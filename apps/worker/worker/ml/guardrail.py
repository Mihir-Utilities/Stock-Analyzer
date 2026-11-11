"""Guardrail evaluation and the live gate (docs/05 10.5). Pure numpy.

Defaults are documented judgements, not evidence (docs/05 10.5). Every check is reported with its
value and threshold so the model card can explain a hidden forecast.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

import numpy as np
from numpy.typing import NDArray

from worker.ml import metrics as mt

F64 = NDArray[np.float64]
I64 = NDArray[np.int64]
BoolArr = NDArray[np.bool_]


@dataclass(frozen=True)
class GuardrailParams:
    eval_folds: int = 8
    min_folds: int = 12
    min_mean_auc: float = 0.53
    auc_lower_bound: float = 0.50
    bootstrap_resamples: int = mt.BOOTSTRAP_RESAMPLES
    brier_margin: float = 0.0005
    brier_folds_needed: int = 6
    max_ece: float = 0.03
    coverage_folds: int = 4
    coverage_lo: float = 0.76
    coverage_hi: float = 0.84
    b2_auc_tolerance: float = 0.005
    seed: int = 42


@dataclass
class FoldEval:
    """Out-of-fold rows of one validation fold (calibrated probabilities and band hits)."""

    index: int
    y: F64
    p: F64  # calibrated model probability
    p_b1: F64
    p_b2: F64
    p_b3: F64
    in_band: BoolArr  # conformal model band hit
    in_band_baseline: BoolArr  # empirical-quantile baseline band hit
    month: I64  # calendar month key (year * 12 + month) of each row's date
    calibrated: bool = True

    def metrics(self) -> dict[str, Any]:
        return {
            "fold": self.index,
            "n": len(self.y),
            "model": mt.classification_metrics(self.y, self.p),
            "b1": mt.classification_metrics(self.y, self.p_b1),
            "b2": mt.classification_metrics(self.y, self.p_b2),
            "b3": mt.classification_metrics(self.y, self.p_b3),
            "band_coverage": float(self.in_band.mean()) if len(self.y) else math.nan,
            "baseline_band_coverage": (
                float(self.in_band_baseline.mean()) if len(self.y) else math.nan
            ),
            "calibrated": self.calibrated,
        }


@dataclass(frozen=True)
class Check:
    name: str
    ok: bool
    value: float | None
    threshold: str

    def to_json(self) -> dict[str, Any]:
        return {"name": self.name, "ok": self.ok, "value": self.value, "threshold": self.threshold}


@dataclass(frozen=True)
class GuardrailResult:
    passed: bool
    checks: list[Check]
    reason: str | None  # first failed check, or ``insufficient_folds``
    summary: dict[str, Any]

    def to_json(self) -> dict[str, Any]:
        return {
            "passed": self.passed,
            "reason": self.reason,
            "checks": [c.to_json() for c in self.checks],
            "summary": self.summary,
        }


def _finite(v: float) -> float | None:
    return v if math.isfinite(v) else None


def _mean(values: Sequence[float]) -> float:
    vals = [v for v in values if math.isfinite(v)]
    return float(np.mean(vals)) if vals else math.nan


def evaluate_guardrail(
    folds: Sequence[FoldEval], params: GuardrailParams | None = None
) -> GuardrailResult:
    """All five conditions of docs/05 10.5 on the last ``eval_folds`` folds."""
    params = params or GuardrailParams()
    if len(folds) < params.min_folds:
        return GuardrailResult(
            False,
            [],
            "insufficient_folds",
            {"folds": len(folds), "needed": params.min_folds},
        )
    last = list(folds[-params.eval_folds :])
    per = [f.metrics() for f in last]
    aucs = [float(m["model"]["auc"]) for m in per]
    mean_auc = _mean(aucs)
    y = np.concatenate([f.y for f in last])
    p = np.concatenate([f.p for f in last])
    month = np.concatenate([f.month for f in last])
    lower = mt.block_bootstrap_lower(
        mt.monthly_auc(y, p, month), resamples=params.bootstrap_resamples, seed=params.seed
    )
    checks: list[Check] = []
    checks.append(
        Check(
            "auc_mean",
            math.isfinite(mean_auc) and mean_auc >= params.min_mean_auc,
            _finite(mean_auc),
            f">= {params.min_mean_auc}",
        )
    )
    checks.append(
        Check(
            "auc_bootstrap_lower",
            math.isfinite(lower) and lower > params.auc_lower_bound,
            _finite(lower),
            f"> {params.auc_lower_bound}",
        )
    )
    wins = sum(
        1
        for m in per
        if m["model"]["brier"] <= m["b1"]["brier"] - params.brier_margin  # nan compares False
    )
    checks.append(
        Check(
            "brier_vs_b1",
            wins >= params.brier_folds_needed,
            float(wins),
            f"beats B1 by {params.brier_margin} in >= {params.brier_folds_needed} of "
            f"{params.eval_folds} folds",
        )
    )
    pooled_ece = mt.ece(y, p)
    checks.append(
        Check(
            "ece_pooled",
            math.isfinite(pooled_ece) and pooled_ece <= params.max_ece,
            _finite(pooled_ece),
            f"<= {params.max_ece}",
        )
    )
    cov_rows = last[-params.coverage_folds :]
    hits = np.concatenate([f.in_band for f in cov_rows])
    cov = float(hits.mean()) if len(hits) else math.nan
    checks.append(
        Check(
            "band_coverage",
            math.isfinite(cov) and params.coverage_lo <= cov <= params.coverage_hi,
            _finite(cov),
            f"[{params.coverage_lo}, {params.coverage_hi}] pooled over the last "
            f"{params.coverage_folds} folds",
        )
    )
    b2_auc = _mean([float(m["b2"]["auc"]) for m in per])
    checks.append(
        Check(
            "auc_vs_b2",
            math.isfinite(mean_auc)
            and math.isfinite(b2_auc)
            and mean_auc >= b2_auc - params.b2_auc_tolerance,
            _finite(mean_auc - b2_auc),
            f">= -{params.b2_auc_tolerance} (model AUC minus B2 AUC)",
        )
    )
    failed = [c.name for c in checks if not c.ok]
    summary = {
        "folds": len(folds),
        "eval_folds": len(last),
        "auc_mean": _finite(mean_auc),
        "auc_lower_95": _finite(lower),
        "brier_mean": _finite(_mean([float(m["model"]["brier"]) for m in per])),
        "baseline_brier_b1_mean": _finite(_mean([float(m["b1"]["brier"]) for m in per])),
        "ece_pooled": _finite(pooled_ece),
        "band_coverage_last_folds": _finite(cov),
        "b2_auc_mean": _finite(b2_auc),
    }
    return GuardrailResult(not failed, checks, failed[0] if failed else None, summary)


# ----------------------------------------------------------------------------- live gate

LIVE_MIN_RESOLVED = 100
LIVE_MIN_AUC = 0.50
LIVE_COVERAGE_LO = 0.70
LIVE_COVERAGE_HI = 0.90


@dataclass(frozen=True)
class LiveRecord:
    p_up: float
    realized_return: float  # simple return C_{t+h}/C_t - 1
    in_band: bool


@dataclass(frozen=True)
class LiveGate:
    resolved: int
    live_auc: float | None
    live_coverage: float | None
    tripped: bool
    reason: str | None  # live_auc | live_coverage


def live_gate(records: Sequence[LiveRecord]) -> LiveGate:
    """After >= 100 resolved live predictions of a horizon: AUC < 0.50 or band coverage outside
    [0.70, 0.90] trips the gate. Fewer than 100 never trips it."""
    n = len(records)
    if n == 0:
        return LiveGate(0, None, None, False, None)
    y = np.array([1.0 if r.realized_return > 0 else 0.0 for r in records])
    p = np.array([r.p_up for r in records])
    a = mt.auc(y, p)
    cov = float(np.mean([r.in_band for r in records]))
    auc_v = _finite(a)
    if n < LIVE_MIN_RESOLVED:
        return LiveGate(n, auc_v, cov, False, None)
    if auc_v is not None and auc_v < LIVE_MIN_AUC:
        return LiveGate(n, auc_v, cov, True, "live_auc")
    if not (LIVE_COVERAGE_LO <= cov <= LIVE_COVERAGE_HI):
        return LiveGate(n, auc_v, cov, True, "live_coverage")
    return LiveGate(n, auc_v, cov, False, None)
