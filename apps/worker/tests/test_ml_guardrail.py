"""D07 guardrail (docs/05 10.5) and live gate (ML-07). The key acceptance test: random-noise
predictions never pass."""

from __future__ import annotations

import numpy as np
import pytest

from worker.ml.guardrail import (
    FoldEval,
    GuardrailParams,
    LiveRecord,
    evaluate_guardrail,
    live_gate,
)

N_FOLDS = 13
ROWS = 1500
FAST = GuardrailParams(bootstrap_resamples=300)


def make_fold(
    index: int,
    rng: np.random.Generator,
    *,
    signal: bool,
    shift: float = 0.0,
    jitter: float = 0.0,
    cover: float = 0.8,
    b1_oracle: bool = False,
    b2_oracle: bool = False,
) -> FoldEval:
    q = rng.uniform(0.3, 0.7, ROWS)
    if signal:
        y = (rng.uniform(size=ROWS) < q).astype(float)
        p = q + shift + (rng.normal(0, jitter, ROWS) if jitter else 0.0)
    else:  # pure noise: predictions independent of the outcome
        y = (rng.uniform(size=ROWS) < 0.5).astype(float)
        p = q
    p = np.clip(p, 0.01, 0.99)
    base = float(y.mean())
    return FoldEval(
        index=index,
        y=y,
        p=p,
        p_b1=q.copy() if b1_oracle else np.full(ROWS, base),
        p_b2=q.copy() if b2_oracle else np.full(ROWS, base) + rng.normal(0, 1e-3, ROWS),
        p_b3=np.where(rng.uniform(size=ROWS) < 0.5, 0.55, 0.45),
        in_band=rng.uniform(size=ROWS) < cover,
        in_band_baseline=rng.uniform(size=ROWS) < 0.8,
        month=(index * 3 + np.arange(ROWS) % 3).astype(np.int64),
    )


def folds(seed: int, n: int = N_FOLDS, **kw: object) -> list[FoldEval]:
    rng = np.random.default_rng(seed)
    return [make_fold(i, rng, **kw) for i in range(n)]  # type: ignore[arg-type]


def test_random_noise_never_passes_the_guardrail() -> None:
    passes = 0
    for seed in range(150):
        res = evaluate_guardrail(folds(seed, signal=False), FAST)
        passes += int(res.passed)
        assert res.reason is not None or res.passed
    assert passes == 0


def test_a_calibrated_signal_with_a_good_band_passes_all_checks() -> None:
    res = evaluate_guardrail(folds(1, signal=True), FAST)
    assert res.passed and res.reason is None
    assert {c.name for c in res.checks} == {
        "auc_mean",
        "auc_bootstrap_lower",
        "brier_vs_b1",
        "ece_pooled",
        "band_coverage",
        "auc_vs_b2",
    }
    assert all(c.ok for c in res.checks)


@pytest.mark.parametrize(
    ("kw", "failed"),
    [
        ({"signal": False}, "auc_mean"),
        ({"signal": True, "b1_oracle": True}, "brier_vs_b1"),
        ({"signal": True, "shift": 0.06}, "ece_pooled"),
        ({"signal": True, "cover": 0.70}, "band_coverage"),
        ({"signal": True, "cover": 0.90}, "band_coverage"),
        ({"signal": True, "jitter": 0.12, "b2_oracle": True}, "auc_vs_b2"),
    ],
)
def test_each_condition_alone_blocks_the_guardrail(kw: dict[str, object], failed: str) -> None:
    res = evaluate_guardrail(folds(5, **kw), FAST)
    assert not res.passed
    assert failed in [c.name for c in res.checks if not c.ok]


def test_bootstrap_lower_bound_blocks_a_marginal_mean_auc() -> None:
    # mean AUC just above 0.53 but noisy by month: the lower bound must stay above 0.50
    rng = np.random.default_rng(11)
    weak = []
    for i in range(N_FOLDS):
        f = make_fold(i, rng, signal=True)
        f.p = np.clip(0.5 + (f.p - 0.5) * 0.12 + rng.normal(0, 0.12, ROWS), 0.01, 0.99)
        weak.append(f)
    res = evaluate_guardrail(weak, FAST)
    by = {c.name: c for c in res.checks}
    assert not res.passed
    assert not (by["auc_mean"].ok and by["auc_bootstrap_lower"].ok)


def test_fewer_than_12_folds_cannot_pass() -> None:
    res = evaluate_guardrail(folds(2, n=11, signal=True), FAST)
    assert not res.passed and res.reason == "insufficient_folds"


def test_only_the_last_eight_folds_count() -> None:
    rng = np.random.default_rng(4)
    old_bad = [make_fold(i, rng, signal=False) for i in range(5)]
    recent_good = [make_fold(5 + i, rng, signal=True) for i in range(8)]
    assert evaluate_guardrail([*old_bad, *recent_good], FAST).passed
    recent_bad = [make_fold(5 + i, rng, signal=False) for i in range(8)]
    good_old = [make_fold(i, rng, signal=True) for i in range(5)]
    assert not evaluate_guardrail([*good_old, *recent_bad], FAST).passed


def test_guardrail_is_deterministic() -> None:
    a = evaluate_guardrail(folds(8, signal=True), FAST).to_json()
    b = evaluate_guardrail(folds(8, signal=True), FAST).to_json()
    assert a == b


# ML-07 (pure part; the DB part is in test_ml_db)
def rec(p: float, realized: float, in_band: bool) -> LiveRecord:
    return LiveRecord(p, realized, in_band)


def good_records(n: int) -> list[LiveRecord]:
    out = []
    for i in range(n):
        up = i % 2 == 0
        out.append(rec(0.6 if up else 0.4, 0.01 if up else -0.01, i % 5 != 0))  # coverage 0.8
    return out


def test_ml07_live_gate_needs_100_resolved_predictions() -> None:
    bad = [rec(0.6, -0.01, False) for _ in range(99)]  # worst possible, but only 99
    g = live_gate(bad)
    assert not g.tripped and g.resolved == 99
    assert not live_gate(good_records(100)).tripped
    assert live_gate([]).resolved == 0


def test_ml07_live_auc_below_half_trips() -> None:
    recs = [
        rec(0.6 if i % 2 == 0 else 0.4, -0.01 if i % 2 == 0 else 0.01, i % 5 != 0)
        for i in range(100)
    ]
    g = live_gate(recs)
    assert g.tripped and g.reason == "live_auc" and g.live_auc == pytest.approx(0.0)


@pytest.mark.parametrize(("hits", "tripped"), [(69, True), (70, False), (90, False), (91, True)])
def test_ml07_live_coverage_outside_70_90_trips(hits: int, tripped: bool) -> None:
    recs = [
        rec(0.6 if i % 2 == 0 else 0.4, 0.01 if i % 2 == 0 else -0.01, i < hits) for i in range(100)
    ]
    g = live_gate(recs)
    assert g.tripped is tripped
    if tripped:
        assert g.reason == "live_coverage"
