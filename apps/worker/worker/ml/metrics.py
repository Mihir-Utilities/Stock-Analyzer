"""Metrics and the block bootstrap (docs/05 10.5). Pure numpy; unknown values are ``nan`` here and
become ``null`` at the storage boundary (never 0)."""

from __future__ import annotations

import math

import numpy as np
from numpy.typing import NDArray

F64 = NDArray[np.float64]
I64 = NDArray[np.int64]

EPS = 1e-12
ECE_BINS = 10
BOOTSTRAP_RESAMPLES = 2000


def _avg_ranks(x: F64) -> F64:
    """1-based ranks, ties get the average rank."""
    order = np.argsort(x, kind="mergesort")
    sorted_x = x[order]
    ranks = np.empty(len(x), dtype=np.float64)
    n = len(x)
    i = 0
    while i < n:
        j = i
        while j + 1 < n and sorted_x[j + 1] == sorted_x[i]:
            j += 1
        ranks[order[i : j + 1]] = (i + j) / 2.0 + 1.0
        i = j + 1
    return ranks


def auc(y: F64, p: F64) -> float:
    """Mann-Whitney AUC; nan when only one class is present."""
    pos = y > 0.5
    n_pos = int(pos.sum())
    n_neg = len(y) - n_pos
    if n_pos == 0 or n_neg == 0:
        return math.nan
    ranks = _avg_ranks(p)
    return float((ranks[pos].sum() - n_pos * (n_pos + 1) / 2.0) / (n_pos * n_neg))


def brier(y: F64, p: F64) -> float:
    return float(np.mean((p - y) ** 2)) if len(y) else math.nan


def log_loss(y: F64, p: F64) -> float:
    if not len(y):
        return math.nan
    q = np.clip(p, EPS, 1.0 - EPS)
    return float(-np.mean(y * np.log(q) + (1.0 - y) * np.log(1.0 - q)))


def accuracy(y: F64, p: F64) -> float:
    return float(np.mean((p >= 0.5) == (y > 0.5))) if len(y) else math.nan


def ece(y: F64, p: F64, bins: int = ECE_BINS) -> float:
    """Expected calibration error, equal-width bins on [0, 1]."""
    if not len(y):
        return math.nan
    idx = np.minimum((np.clip(p, 0.0, 1.0) * bins).astype(np.int64), bins - 1)
    total = 0.0
    for b in range(bins):
        m = idx == b
        k = int(m.sum())
        if k:
            total += k / len(y) * abs(float(y[m].mean()) - float(p[m].mean()))
    return total


def coverage(realized: F64, lo: F64, hi: F64) -> float:
    return float(np.mean((realized >= lo) & (realized <= hi))) if len(realized) else math.nan


def classification_metrics(y: F64, p: F64) -> dict[str, float]:
    return {
        "auc": auc(y, p),
        "brier": brier(y, p),
        "log_loss": log_loss(y, p),
        "accuracy": accuracy(y, p),
        "ece": ece(y, p),
    }


def block_bootstrap_lower(
    block_values: F64, *, resamples: int = BOOTSTRAP_RESAMPLES, seed: int = 0, q: float = 2.5
) -> float:
    """Lower ``q`` percentile of the mean of ``block_values`` (one value per calendar month),
    resampling whole blocks with replacement. Seeded, so identical inputs give identical bounds."""
    vals = block_values[np.isfinite(block_values)]
    if len(vals) < 2:
        return math.nan
    rng = np.random.default_rng(seed)
    idx = rng.integers(0, len(vals), size=(resamples, len(vals)))
    means = vals[idx].mean(axis=1)
    return float(np.percentile(means, q))


def monthly_auc(y: F64, p: F64, month: I64) -> F64:
    """AUC of the pooled rows of each calendar month (months with one class are skipped)."""
    out: list[float] = []
    for m in np.unique(month):
        sel = month == m
        a = auc(y[sel], p[sel])
        if math.isfinite(a):
            out.append(a)
    return np.array(out, dtype=np.float64)
