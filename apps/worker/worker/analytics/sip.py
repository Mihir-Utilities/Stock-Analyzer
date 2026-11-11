"""SIP versus lump sum, a backtest on the imported history (docs/05 12.8).

A fixed monthly amount on a chosen day against the same total invested on the first instalment
date. A replay of past prices of a stock the owner already follows (hindsight and survivorship),
not an estimate of the future. Hypothetical INR amounts, not portfolio money. Price return only.
"""

from __future__ import annotations

import bisect
from datetime import date
from typing import Any

import numpy as np

from worker.analytics.inv_common import F64, InvSettings, iso, r2, r4

AMOUNT_INR = 1000
DAYS = (None, *range(1, 29))  # None = the first trading day of each month
XIRR_LOW = -0.9999  # docs/05 8.3 bracket
XIRR_HIGH = 100.0
XIRR_TOL = 1e-7
XIRR_MAX_ITER = 200
MIN_SPAN_DAYS = 365  # MFH-3: XIRR only for a span of a year or more


def xirr(flows: list[tuple[date, float]]) -> float | None:
    """Annual rate ``r`` with ``sum(cf_i / (1+r)^t_i) = 0``, ``t_i = days/365`` (docs/05 8.3).

    Bracketed on ``[-0.9999, 100]`` and solved by bisection (tolerance 1e-7, 200 iterations);
    ``None`` without an outflow and an inflow or without a sign change."""
    if not any(cf < 0 for _, cf in flows) or not any(cf > 0 for _, cf in flows):
        return None
    d0 = min(d for d, _ in flows)
    t = np.array([(d - d0).days / 365.0 for d, _ in flows], dtype=np.float64)
    cf = np.array([c for _, c in flows], dtype=np.float64)

    def f(r: float) -> float:
        return float(np.sum(cf / (1.0 + r) ** t))

    lo, hi = XIRR_LOW, XIRR_HIGH
    flo, fhi = f(lo), f(hi)
    if not (np.isfinite(flo) and np.isfinite(fhi)) or flo * fhi > 0:
        return None
    for _ in range(XIRR_MAX_ITER):
        mid = (lo + hi) / 2.0
        fm = f(mid)
        if fm == 0 or (hi - lo) / 2.0 < XIRR_TOL:
            return mid
        if flo * fm < 0:
            hi, fhi = mid, fm
        else:
            lo, flo = mid, fm
    return (lo + hi) / 2.0


def executions(dates: list[date], day: int | None) -> tuple[list[int], int]:
    """Row index of the execution bar of every calendar month from the first bar's month to the
    last bar's month (the first bar on or after ``day``; ``None`` = the month's first bar), and
    the number of months without such a bar."""
    first, last = dates[0], dates[-1]
    idxs: list[int] = []
    skipped = 0
    y, m = first.year, first.month
    while (y, m) <= (last.year, last.month):
        target = date(y, m, 1 if day is None else day)
        i = bisect.bisect_left(dates, target)
        if i < len(dates) and (dates[i].year, dates[i].month) == (y, m):
            idxs.append(i)
        else:
            skipped += 1
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return idxs, skipped


def variant(
    dates: list[date],
    close: F64,
    day: int | None,
    settings: InvSettings,
    amount: float = AMOUNT_INR,
) -> dict[str, Any]:
    idxs, skipped = executions(dates, day)
    n_inst = len(idxs)
    out: dict[str, Any] = {
        "day": day,
        "installments": n_inst,
        "skipped": skipped,
        "first_date": None,
        "last_date": None,
        "span_days": None,
        "invested_inr": None,
        "sip_value_inr": None,
        "lump_value_inr": None,
        "value_ratio": None,
        "sip_absolute_return_pct": None,
        "lump_absolute_return_pct": None,
        "sip_xirr_pct": None,
        "lump_xirr_pct": None,
        "sip_worst_unrealised_pct": None,
        "lump_worst_unrealised_pct": None,
    }
    if n_inst < settings.sip_min_months:
        out["reason"] = "history_under_12_months"
        return out

    last = float(close[-1])
    units = np.zeros(len(close))
    for i in idxs:
        units[i] = amount / float(close[i])
    first = idxs[0]
    invested = amount * n_inst
    sip_value = float(units.sum()) * last
    lump_units = invested / float(close[first])
    lump_value = lump_units * last
    span = (dates[-1] - dates[first]).days

    held = np.cumsum(units)[first:]
    paid = np.cumsum(np.isin(np.arange(len(close)), idxs) * amount)[first:]
    sip_worst = float(np.min(held * close[first:] / paid - 1.0) * 100.0)
    lump_worst = float(np.min(close[first:] / close[first] - 1.0) * 100.0)

    out.update(
        first_date=dates[first].isoformat(),
        last_date=dates[idxs[-1]].isoformat(),
        span_days=span,
        invested_inr=r2(invested),
        sip_value_inr=r2(sip_value),
        lump_value_inr=r2(lump_value),
        value_ratio=r4(sip_value / lump_value),
        sip_absolute_return_pct=r2((sip_value / invested - 1.0) * 100.0),
        lump_absolute_return_pct=r2((lump_value / invested - 1.0) * 100.0),
        sip_worst_unrealised_pct=r2(sip_worst),
        lump_worst_unrealised_pct=r2(lump_worst),
    )
    if span < MIN_SPAN_DAYS:
        out["xirr_reason"] = "under_one_year"
        return out
    sip_flows = [(dates[i], -amount) for i in idxs] + [(dates[-1], sip_value)]
    lump_flows = [(dates[first], -invested), (dates[-1], lump_value)]
    s, lmp = xirr(sip_flows), xirr(lump_flows)
    out["sip_xirr_pct"] = None if s is None else r2(s * 100.0)
    out["lump_xirr_pct"] = None if lmp is None else r2(lmp * 100.0)
    if s is None or lmp is None:
        out["xirr_reason"] = "n/m"
    return out


def sip_backtest(
    dates: list[date],
    close: F64,
    settings: InvSettings,
    *,
    amount: float = AMOUNT_INR,
    days: tuple[int | None, ...] = DAYS,
) -> dict[str, Any]:
    """The default ``first_trading_day`` plus the 28 fixed days, so the day picker needs no new
    request (docs/05 12.8)."""
    return {
        "as_of": iso(dates[-1]),
        "bars": len(dates),
        "amount_per_month_inr": int(amount),
        "price_basis": "adj_close",
        "variants": [variant(dates, close, d, settings, amount) for d in days],
    }
