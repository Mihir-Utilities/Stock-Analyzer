"""Probability calibration (isotonic), conformal band calibration and quantile ordering
(docs/05 10.4). Pure numpy."""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray

F64 = NDArray[np.float64]

TARGET_COVERAGE = 0.8


@dataclass(frozen=True)
class Isotonic:
    """Non-decreasing step function fitted by pool-adjacent-violators; predicts by linear
    interpolation between fitted points and clips outside the fitted range."""

    xs: F64
    ys: F64

    def predict(self, p: F64) -> F64:
        if len(self.xs) == 0:
            return p.copy()
        out: F64 = np.interp(p, self.xs, self.ys)
        return out

    def to_json(self) -> dict[str, list[float]]:
        return {"xs": [float(v) for v in self.xs], "ys": [float(v) for v in self.ys]}

    @staticmethod
    def from_json(d: dict[str, list[float]]) -> Isotonic:
        return Isotonic(np.array(d["xs"], dtype=np.float64), np.array(d["ys"], dtype=np.float64))


def fit_isotonic(p: F64, y: F64) -> Isotonic:
    """PAV on (p, y); equal ``p`` values are pooled first. Needs both classes, else identity."""
    if len(p) == 0 or float(np.min(y)) == float(np.max(y)):
        return Isotonic(np.zeros(0), np.zeros(0))
    order = np.argsort(p, kind="mergesort")
    xs, ys = p[order], y[order]
    ux, inv = np.unique(xs, return_inverse=True)
    wsum = np.bincount(inv).astype(np.float64)
    vsum = np.bincount(inv, weights=ys)
    blocks: list[list[float]] = []  # [mean, weight, x_first, x_last]
    for i in range(len(ux)):
        blocks.append([vsum[i] / wsum[i], wsum[i], float(ux[i]), float(ux[i])])
        while len(blocks) > 1 and blocks[-2][0] >= blocks[-1][0]:
            b = blocks.pop()
            a = blocks.pop()
            w = a[1] + b[1]
            blocks.append([(a[0] * a[1] + b[0] * b[1]) / w, w, a[2], b[3]])
    px: list[float] = []
    py: list[float] = []
    for mean, _, x0, x1 in blocks:
        px.append(x0)
        py.append(mean)
        if x1 != x0:
            px.append(x1)
            py.append(mean)
    return Isotonic(np.array(px, dtype=np.float64), np.array(py, dtype=np.float64))


def order_quantiles(q: F64) -> F64:
    """Sort each row so q10 <= q50 <= q90 (quantile crossing, ML-10)."""
    out: F64 = np.sort(q, axis=1)
    return out


def conformal_adjustment(q10: F64, q90: F64, y: F64, coverage: float = TARGET_COVERAGE) -> float:
    """Additive widening ``a`` (negative narrows) so that ``[q10 - a, q90 + a]`` has empirical
    coverage ``coverage`` on the calibration rows (conformalised quantile regression: the
    ``ceil((n+1)*coverage)/n`` quantile of ``max(q10 - y, y - q90)``)."""
    n = len(y)
    if n == 0:
        return 0.0
    scores = np.maximum(q10 - y, y - q90)
    level = min(1.0, math.ceil((n + 1) * coverage) / n)
    return float(np.quantile(scores, level, method="higher"))


def apply_band(q: F64, adj: float) -> F64:
    """Sorted quantile columns ``[q10, q50, q90]`` -> widened band with the median kept inside."""
    s = order_quantiles(q)
    out = s.copy()
    out[:, 0] = np.minimum(s[:, 0] - adj, s[:, 1])
    out[:, 2] = np.maximum(s[:, 2] + adj, s[:, 1])
    return out
