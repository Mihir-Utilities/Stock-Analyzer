"""LightGBM wrappers and the serialised model artifact (docs/05 10.4, 10.8).

Training is deterministic for identical data: fixed seed, one thread, row-wise histograms. The
artifact is JSON (model text + calibrators) compressed with zlib; no pickle anywhere.
"""

from __future__ import annotations

import json
import zlib
from dataclasses import dataclass, field
from typing import Any

import lightgbm as lgb
import numpy as np
from numpy.typing import NDArray

from worker.ml.calibration import Isotonic, apply_band

F64 = NDArray[np.float64]

QUANTILES = (0.1, 0.5, 0.9)


@dataclass(frozen=True)
class TrainParams:
    """docs/05 10.4 defaults. Tests shrink ``num_rounds``/``min_data_in_leaf``/``init_months``."""

    seed: int = 42
    num_leaves: int = 15
    min_data_in_leaf: int = 500
    feature_fraction: float = 0.8
    bagging_fraction: float = 0.8
    bagging_freq: int = 1
    learning_rate: float = 0.03
    lambda_l2: float = 10.0
    num_rounds: int = 300
    early_stopping_rounds: int = 30
    inner_dates: int = 63  # last ~3 months of the training window = inner validation fold
    init_months: int = 36
    fold_months: int = 3

    def as_json(self) -> dict[str, Any]:
        return dict(self.__dict__)


def _lgb_params(tp: TrainParams, objective: str, alpha: float | None) -> dict[str, Any]:
    p: dict[str, Any] = {
        "objective": objective,
        "metric": "binary_logloss" if objective == "binary" else "quantile",
        "num_leaves": tp.num_leaves,
        "min_data_in_leaf": tp.min_data_in_leaf,
        "feature_fraction": tp.feature_fraction,
        "bagging_fraction": tp.bagging_fraction,
        "bagging_freq": tp.bagging_freq,
        "learning_rate": tp.learning_rate,
        "lambda_l2": tp.lambda_l2,
        "seed": tp.seed,
        "deterministic": True,
        "force_row_wise": True,
        "num_threads": 1,
        "feature_pre_filter": False,
        "verbosity": -1,
    }
    if alpha is not None:
        p["alpha"] = alpha
    return p


def fit_booster(
    x: F64,
    y: F64,
    x_inner: F64 | None,
    y_inner: F64 | None,
    tp: TrainParams,
    *,
    objective: str,
    alpha: float | None = None,
    categorical: list[int] | None = None,
) -> lgb.Booster:
    cat: Any = categorical if categorical else "auto"
    train = lgb.Dataset(x, label=y, categorical_feature=cat, free_raw_data=False)
    valid_sets = []
    callbacks: list[Any] = []
    if x_inner is not None and y_inner is not None and len(y_inner):
        valid_sets = [lgb.Dataset(x_inner, label=y_inner, reference=train, free_raw_data=False)]
        callbacks = [lgb.early_stopping(tp.early_stopping_rounds, verbose=False)]
    return lgb.train(
        _lgb_params(tp, objective, alpha),
        train,
        num_boost_round=tp.num_rounds,
        valid_sets=valid_sets,
        callbacks=callbacks,
    )


def predict_booster(b: lgb.Booster, x: F64) -> F64:
    out: F64 = np.asarray(b.predict(x, num_iteration=b.best_iteration or None), dtype=np.float64)
    return out


@dataclass
class HorizonModel:
    """Everything needed to score new rows for one horizon."""

    horizon: int
    names: list[str]
    clf: lgb.Booster
    iso: Isotonic
    quantile: list[lgb.Booster]  # alpha 0.1, 0.5, 0.9
    conformal_adj: float
    baseline_band: tuple[float, float]
    meta: dict[str, Any] = field(default_factory=dict)

    def p_up(self, x: F64) -> F64:
        clipped: F64 = np.clip(self.iso.predict(predict_booster(self.clf, x)), 0.0, 1.0)
        return clipped

    def z_band(self, x: F64) -> F64:
        """Columns ``[q10, q50, q90]`` of the volatility-scaled target, sorted (ML-10) and
        widened by the conformal adjustment."""
        raw = np.column_stack([predict_booster(b, x) for b in self.quantile])
        return apply_band(raw, self.conformal_adj)

    def dir_artifact(self) -> bytes:
        return _pack(
            {
                "kind": "dir",
                "horizon": self.horizon,
                "names": self.names,
                "clf": self.clf.model_to_string(),
                "iso": self.iso.to_json(),
            }
        )

    def range_artifact(self) -> bytes:
        return _pack(
            {
                "kind": "range",
                "horizon": self.horizon,
                "names": self.names,
                "quantile": [b.model_to_string() for b in self.quantile],
                "conformal_adj": self.conformal_adj,
                "baseline_band": list(self.baseline_band),
            }
        )


def _pack(obj: dict[str, Any]) -> bytes:
    return zlib.compress(json.dumps(obj, separators=(",", ":")).encode(), 6)


def unpack(blob: bytes) -> dict[str, Any]:
    out: dict[str, Any] = json.loads(zlib.decompress(blob).decode())
    return out


@dataclass
class ScoringModel:
    """A horizon model rebuilt from the two stored artifacts."""

    horizon: int
    names: list[str]
    clf: lgb.Booster
    iso: Isotonic
    quantile: list[lgb.Booster]
    conformal_adj: float

    @staticmethod
    def load(dir_blob: bytes, range_blob: bytes) -> ScoringModel:
        d, r = unpack(dir_blob), unpack(range_blob)
        if d["names"] != r["names"] or d["horizon"] != r["horizon"]:
            raise ValueError("direction and range artifacts disagree")
        return ScoringModel(
            int(d["horizon"]),
            list(d["names"]),
            lgb.Booster(model_str=d["clf"]),
            Isotonic.from_json(d["iso"]),
            [lgb.Booster(model_str=s) for s in r["quantile"]],
            float(r["conformal_adj"]),
        )

    def p_up(self, x: F64) -> F64:
        clipped: F64 = np.clip(self.iso.predict(predict_booster(self.clf, x)), 0.0, 1.0)
        return clipped

    def z_band(self, x: F64) -> F64:
        raw = np.column_stack([predict_booster(b, x) for b in self.quantile])
        return apply_band(raw, self.conformal_adj)
