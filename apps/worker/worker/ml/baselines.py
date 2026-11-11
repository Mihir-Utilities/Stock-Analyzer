"""Baselines B1-B3 and the empirical-quantile band baseline (docs/05 10.4)."""

from __future__ import annotations

import numpy as np
from numpy.typing import NDArray

F64 = NDArray[np.float64]

B3_UP = 0.55
B3_DOWN = 0.45
RIDGE = 1e-3
NEWTON_STEPS = 25


def b1_base_rate(y_train: F64, n: int) -> F64:
    """Constant base rate of the training window."""
    return np.full(n, float(y_train.mean()), dtype=np.float64)


def b3_momentum(ret_21: F64) -> F64:
    """``ret_21 > 0`` -> 0.55 else 0.45 (for scoring)."""
    return np.where(ret_21 > 0, B3_UP, B3_DOWN).astype(np.float64)


class Logistic:
    """B2: logistic regression on standardised features by Newton steps with a tiny ridge, so it
    is deterministic and has no optimiser dependency."""

    def __init__(self, x: F64, y: F64) -> None:
        self.mean = x.mean(axis=0)
        sd = x.std(axis=0)
        self.sd = np.where(sd > 0, sd, 1.0)
        z = np.column_stack([np.ones(len(x)), (x - self.mean) / self.sd])
        w = np.zeros(z.shape[1])
        reg = RIDGE * np.eye(z.shape[1])
        reg[0, 0] = 0.0
        for _ in range(NEWTON_STEPS):
            p = 1.0 / (1.0 + np.exp(-np.clip(z @ w, -30, 30)))
            grad = z.T @ (p - y) + reg @ w
            hess = (z * (p * (1 - p))[:, None]).T @ z + reg + 1e-9 * np.eye(z.shape[1])
            step = np.linalg.solve(hess, grad)
            w = w - step
            if float(np.max(np.abs(step))) < 1e-8:
                break
        self.w: F64 = w

    def predict(self, x: F64) -> F64:
        z = np.column_stack([np.ones(len(x)), (x - self.mean) / self.sd])
        out: F64 = 1.0 / (1.0 + np.exp(-np.clip(z @ self.w, -30, 30)))
        return out


def empirical_band(z_train: F64) -> tuple[float, float]:
    """Baseline band: empirical 10%/90% z-quantiles of the training window (no model)."""
    return float(np.quantile(z_train, 0.1)), float(np.quantile(z_train, 0.9))
