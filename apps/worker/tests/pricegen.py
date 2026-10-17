"""Deterministic synthetic daily bars for D03 tests (no market data is used)."""

from __future__ import annotations

import math
from datetime import date, timedelta

from worker.analytics.actions import Bar

START = date(2026, 1, 5)  # a Monday


def trading_days(n: int, start: date = START) -> list[date]:
    days: list[date] = []
    d = start
    while len(days) < n:
        if d.weekday() < 5:
            days.append(d)
        d += timedelta(days=1)
    return days


def make_series(
    n: int = 60,
    *,
    close0: float = 1000.0,
    volume: int = 400_000,
    jumps: dict[int, tuple[float, float]] | None = None,
    adjusted_until: int = -1,
) -> list[Bar]:
    """``jumps[i] = (price_ratio, volume_multiple)`` applied on bar ``i``.

    Daily noise is a small deterministic wobble (< 0.6%) so nothing else ever triggers.
    Bars with index <= ``adjusted_until`` carry ``src_adjusted=True``.
    """
    jumps = jumps or {}
    level = close0
    bars: list[Bar] = []
    for i, day in enumerate(trading_days(n)):
        vol_mult = 1.0
        if i in jumps:
            ratio, vol_mult = jumps[i]
            level *= ratio
        wobble = 1.0 + 0.005 * math.sin(i * 1.7)
        bars.append(
            Bar(
                trade_date=day,
                close=round(level * wobble, 2),
                volume=int(volume * vol_mult * (1.0 + 0.05 * math.cos(i * 0.9))),
                src_adjusted=i <= adjusted_until,
            )
        )
    return bars
