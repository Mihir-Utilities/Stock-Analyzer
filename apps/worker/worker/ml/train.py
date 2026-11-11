"""Walk-forward training, validation and guardrail evaluation (docs/05 10.4, 10.5, 10.8).

``train_all`` is pure (numpy + LightGBM, no database, no clock): the caller passes ``should_stop``
so a runner timeout aborts cleanly with ``TrainingAborted`` and nothing is stored (ML-09).
"""

from __future__ import annotations

import math
import platform
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import lightgbm as lgb
import numpy as np
from numpy.typing import NDArray

from worker.ml import baselines as bl
from worker.ml import features as ft
from worker.ml.calibration import apply_band, conformal_adjustment, fit_isotonic, order_quantiles
from worker.ml.guardrail import FoldEval, GuardrailParams, GuardrailResult, evaluate_guardrail
from worker.ml.models import QUANTILES, HorizonModel, TrainParams, fit_booster, predict_booster
from worker.ml.walkforward import Fold, make_folds, month_key, train_mask, valid_mask

F64 = NDArray[np.float64]
DEFAULT_PARAMS = TrainParams()
DEFAULT_GUARDRAIL = GuardrailParams()
MIN_UNIVERSE = 20  # docs/05 10.1
MIN_FOLDS_STATUS = "insufficient_history"


class TrainingAborted(Exception):  # noqa: N818
    """The time budget ran out (ML-09). No partial model may be activated."""


@dataclass
class HorizonTrain:
    horizon: int
    guardrail: GuardrailResult
    fold_metrics: list[dict[str, Any]]
    n_rows: int
    train_start_idx: int
    train_end_idx: int
    model: HorizonModel | None  # None when there were too few folds to validate


@dataclass
class TrainOutput:
    status: str  # ok | insufficient_universe | insufficient_history
    horizons: list[HorizonTrain] = field(default_factory=list)
    meta: dict[str, Any] = field(default_factory=dict)


def _z(panel: ft.Panel, h: int) -> F64:
    out: F64 = panel.y_ret[h] / (panel.sigma * math.sqrt(h))
    return out


def _inner_split(
    panel: ft.Panel, rows: NDArray[np.bool_], h: int, tp: TrainParams
) -> tuple[NDArray[np.bool_], NDArray[np.bool_]]:
    dates = np.unique(panel.date_idx[rows])
    if len(dates) <= 2 * tp.inner_dates:
        return rows, np.zeros_like(rows)
    inner_start = int(dates[-tp.inner_dates])
    inner = rows & (panel.date_idx >= inner_start)
    fit_rows = rows & (panel.label_end[h] < inner_start)
    return fit_rows, inner


def _fit_models(
    panel: ft.Panel, rows: NDArray[np.bool_], h: int, tp: TrainParams, stop: Callable[[], bool]
) -> tuple[Any, list[Any]]:
    fit_rows, inner = _inner_split(panel, rows, h, tp)
    y = panel.y_dir(h)
    z = _z(panel, h)
    if float(np.min(y[fit_rows])) == float(np.max(y[fit_rows])):
        raise ValueError("training window has a single class")
    cat = [panel.names.index(n) for n in ft.CATEGORICAL if n in panel.names]
    has_inner = bool(inner.any())
    xi = panel.X[inner] if has_inner else None

    def fit(target: F64, objective: str, alpha: float | None) -> lgb.Booster:
        if stop():
            raise TrainingAborted("time budget exhausted")
        return fit_booster(
            panel.X[fit_rows],
            target[fit_rows],
            xi,
            target[inner] if has_inner else None,
            tp,
            objective=objective,
            alpha=alpha,
            categorical=cat,
        )

    clf = fit(y, "binary", None)
    quant = [fit(z, "quantile", a) for a in QUANTILES]
    return clf, quant


def _train_horizon(
    panel: ft.Panel,
    h: int,
    tp: TrainParams,
    gp: GuardrailParams,
    stop: Callable[[], bool],
) -> HorizonTrain:
    lab = panel.labeled(h)
    y = panel.y_dir(h)
    z = _z(panel, h)
    folds = make_folds(panel.calendar, init_months=tp.init_months, fold_months=tp.fold_months)
    ret21 = panel.column("ret_21")
    vol20 = panel.column("vol_20")
    base_x = np.column_stack([ret21, vol20])
    month_of = np.array([month_key(d) for d in panel.calendar], dtype=np.int64)[panel.date_idx]

    evals: list[FoldEval] = []
    prev_p: list[F64] = []
    prev_y: list[F64] = []
    prev_q: list[F64] = []
    prev_z: list[F64] = []
    used: list[Fold] = []
    for fold in folds:
        vm = valid_mask(lab, panel.date_idx, fold)
        tm = train_mask(lab, panel.label_end[h], fold.start)
        if not vm.any() or not tm.any():
            continue
        if stop():
            raise TrainingAborted("time budget exhausted")
        clf, quant = _fit_models(panel, tm, h, tp, stop)
        p_raw = predict_booster(clf, panel.X[vm])
        q_raw = order_quantiles(np.column_stack([predict_booster(b, panel.X[vm]) for b in quant]))
        yv, zv = y[vm], z[vm]
        calibrated = bool(prev_p)
        if calibrated:
            iso = fit_isotonic(np.concatenate(prev_p), np.concatenate(prev_y))
            p_cal = np.clip(iso.predict(p_raw), 0.0, 1.0)
            pq = np.concatenate(prev_q)
            adj = conformal_adjustment(pq[:, 0], pq[:, 2], np.concatenate(prev_z))
        else:
            p_cal, adj = p_raw, 0.0
        band = apply_band(q_raw, adj)
        b_lo, b_hi = bl.empirical_band(z[tm])
        logit = bl.Logistic(base_x[tm], y[tm])
        evals.append(
            FoldEval(
                index=fold.index,
                y=yv,
                p=p_cal,
                p_b1=bl.b1_base_rate(y[tm], len(yv)),
                p_b2=logit.predict(base_x[vm]),
                p_b3=bl.b3_momentum(ret21[vm]),
                in_band=(zv >= band[:, 0]) & (zv <= band[:, 2]),
                in_band_baseline=(zv >= b_lo) & (zv <= b_hi),
                month=month_of[vm],
                calibrated=calibrated,
            )
        )
        used.append(fold)
        prev_p.append(p_raw)
        prev_y.append(yv)
        prev_q.append(q_raw)
        prev_z.append(zv)

    guard = evaluate_guardrail(evals, gp)
    metrics = [e.metrics() for e in evals]
    rows_labeled = int(lab.sum())
    first_idx = int(np.min(panel.date_idx[lab])) if rows_labeled else 0
    last_idx = int(np.max(panel.date_idx[lab])) if rows_labeled else 0
    if len(evals) < gp.min_folds or not prev_p:
        return HorizonTrain(h, guard, metrics, rows_labeled, first_idx, last_idx, None)
    # Final model for inference: every labeled row; calibrators on all out-of-fold predictions.
    if stop():
        raise TrainingAborted("time budget exhausted")
    clf, quant = _fit_models(panel, lab, h, tp, stop)
    iso = fit_isotonic(np.concatenate(prev_p), np.concatenate(prev_y))
    pq = np.concatenate(prev_q)
    pz = np.concatenate(prev_z)
    model = HorizonModel(
        horizon=h,
        names=list(panel.names),
        clf=clf,
        iso=iso,
        quantile=quant,
        conformal_adj=conformal_adjustment(pq[:, 0], pq[:, 2], pz),
        baseline_band=bl.empirical_band(z[lab]),
    )
    return HorizonTrain(h, guard, metrics, rows_labeled, first_idx, last_idx, model)


def train_all(
    panel: ft.Panel,
    *,
    tp: TrainParams = DEFAULT_PARAMS,
    gp: GuardrailParams = DEFAULT_GUARDRAIL,
    horizons: tuple[int, ...] = ft.HORIZONS,
    should_stop: Callable[[], bool] = lambda: False,
) -> TrainOutput:
    """Train, validate and guard every horizon. Fewer than 20 stocks in the panel ->
    ``insufficient_universe`` with no model at all (ML-04)."""
    meta: dict[str, Any] = {
        "feature_hash": ft.feature_hash(panel.names),
        "features": list(panel.names),
        "params": tp.as_json(),
        "guardrail_params": dict(gp.__dict__),
        "seed": tp.seed,
        "universe": len(panel.symbols),
        "versions": {
            "lightgbm": lgb.__version__,
            "numpy": np.__version__,
            "python": platform.python_version(),
        },
    }
    if len(panel.symbols) < MIN_UNIVERSE:
        return TrainOutput("insufficient_universe", [], meta)
    out = TrainOutput("ok", [], meta)
    for h in horizons:
        out.horizons.append(_train_horizon(panel, h, tp, gp, should_stop))
    if all(ht.model is None for ht in out.horizons):
        out.status = MIN_FOLDS_STATUS
    return out
