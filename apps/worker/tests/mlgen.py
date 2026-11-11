"""Deterministic synthetic price panels for the ML tests (no market data, no wall clock)."""

from __future__ import annotations

from datetime import date, timedelta

import numpy as np

from worker.analytics.snapshot import Bars
from worker.ml.features import MarketInput, StockInput

START = date(2018, 1, 1)  # a Monday


def weekdays(n: int, start: date = START, skip: set[date] | None = None) -> list[date]:
    out: list[date] = []
    d = start
    while len(out) < n:
        if d.weekday() < 5 and not (skip and d in skip):
            out.append(d)
        d += timedelta(days=1)
    return out


def make_bars(
    dates: list[date], rng: np.random.Generator, *, phi: float = 0.0, vol: float = 0.015
) -> Bars:
    """Log returns with AR(1) coefficient ``phi`` (0 = pure noise)."""
    n = len(dates)
    eps = rng.normal(0.0, vol, n)
    r = np.zeros(n)
    for i in range(1, n):
        r[i] = phi * r[i - 1] + eps[i]
    close = 100.0 * np.exp(np.cumsum(r))
    spread = 1.0 + np.abs(rng.normal(0.004, 0.001, n))
    return Bars(
        dates=list(dates),
        close=close,
        adj_close=close.copy(),
        high=close * spread,
        low=close / spread,
        volume=rng.integers(800_000, 1_200_000, n).astype(np.float64),
    )


def make_panel_inputs(
    n_stocks: int = 20,
    n_days: int = 1400,
    *,
    seed: int = 7,
    phi: float = 0.0,
    with_market: bool = True,
) -> tuple[list[StockInput], MarketInput]:
    rng = np.random.default_rng(seed)
    dates = weekdays(n_days)
    stocks = [StockInput(f"S{i:02d}", make_bars(dates, rng, phi=phi)) for i in range(n_stocks)]
    if not with_market:
        return stocks, MarketInput()
    nifty = 10_000.0 * np.exp(np.cumsum(rng.normal(0.0003, 0.008, n_days)))
    vix = 15.0 + np.abs(np.cumsum(rng.normal(0.0, 0.3, n_days))) % 20 + 5
    return stocks, MarketInput(
        nifty={d: float(v) for d, v in zip(dates, nifty, strict=True)},
        vix={d: float(v) for d, v in zip(dates, vix, strict=True)},
    )
