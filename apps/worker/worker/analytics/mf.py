"""Mutual fund math (docs/05 sections 9.1-9.3) and NAV jump flags (docs/04 3.5, MF-08).

Pure functions on ascending ``(date, nav)`` series; float64 as the spec states (NAV column is
double precision). Percent outputs are percent numbers (12.34 = 12.34%). Unknown values are
``None`` with a reason, never 0 or NaN.
"""

from __future__ import annotations

import math
import statistics
from bisect import bisect_right
from collections.abc import Sequence
from datetime import date
from typing import Any

from worker.analytics.returns import subtract_months  # the one shared implementation

__all__ = ["compute_mf_metrics", "nav_jumps", "nav_on_or_before", "subtract_months"]

JUMP_THRESHOLD = 0.25  # docs/04 3.5: day change > 25% is flagged (kept)
WEEKLY_NAV_GAP_DAYS = 3  # docs/05 9.3: median gap above this -> volatility null (MF-07)
TRADING_DAYS = 252
DEFAULT_RISK_FREE = 0.065
WINDOWS: tuple[tuple[str, int], ...] = (
    ("1m", 1),
    ("3m", 3),
    ("6m", 6),
    ("1y", 12),
    ("3y", 36),
    ("5y", 60),
)


def nav_on_or_before(dates: Sequence[date], d: date) -> int | None:
    """Index of the latest NAV dated <= d (docs/05 9.1); None if there is none."""
    i: int = bisect_right(dates, d) - 1
    return i if i >= 0 else None


def _cagr(start_nav: float, end_nav: float, days: int) -> float | None:
    if days <= 0 or start_nav <= 0 or end_nav <= 0:
        return None
    return float((end_nav / start_nav) ** (365.0 / days)) - 1.0


def _window_return(
    dates: Sequence[date], navs: Sequence[float], start_idx: int, end_idx: int, annualise: bool
) -> float | None:
    if annualise:
        return _cagr(navs[start_idx], navs[end_idx], (dates[end_idx] - dates[start_idx]).days)
    return navs[end_idx] / navs[start_idx] - 1.0


def nav_jumps(dates: Sequence[date], navs: Sequence[float]) -> list[dict[str, Any]]:
    """Consecutive-NAV changes above 25% (MF-08): kept in the data, flagged for a chart marker."""
    out: list[dict[str, Any]] = []
    for i in range(1, len(navs)):
        change = navs[i] / navs[i - 1] - 1.0
        if abs(change) > JUMP_THRESHOLD:
            out.append({"date": dates[i].isoformat(), "change_pct": round(change * 100.0, 2)})
    return out


def _pct(x: float | None) -> float | None:
    return None if x is None or not math.isfinite(x) else round(x * 100.0, 4)


def _risk_window(dates: Sequence[date], end_idx: int) -> tuple[int, float] | None:
    """Start index and span in years of the 3Y risk window; None when history is under 1Y."""
    end = dates[end_idx]
    if dates[0] > subtract_months(end, 12):
        return None
    base = nav_on_or_before(dates, subtract_months(end, 36))
    start = base if base is not None else 0
    return start, (end - dates[start]).days / 365.25


def compute_mf_metrics(
    dates: Sequence[date],
    navs: Sequence[float],
    *,
    risk_free: float = DEFAULT_RISK_FREE,
) -> dict[str, Any] | None:
    """The ``mf_return_cache.metrics`` document; None for an empty series (no cache row)."""
    if not dates or len(dates) != len(navs):
        return None
    end_idx = len(dates) - 1
    end = dates[end_idx]
    returns: dict[str, float | None] = {}
    reasons: dict[str, str] = {}

    def put(key: str, value: float | None, reason: str = "insufficient_history") -> None:
        returns[key] = _pct(value)
        if returns[key] is None:
            reasons[key] = reason

    cagr_3y: float | None = None
    for key, months in WINDOWS:
        idx = nav_on_or_before(dates, subtract_months(end, months))
        if idx is None:
            put(key, None)
            continue
        value = _window_return(dates, navs, idx, end_idx, annualise=months >= 12)
        if key == "3y":
            cagr_3y = value
        put(key, value, "n/m")
    ytd_idx = nav_on_or_before(dates, date(end.year - 1, 12, 31))
    put("ytd", None if ytd_idx is None else navs[end_idx] / navs[ytd_idx] - 1.0)
    one_year = dates[0] <= subtract_months(end, 12)
    since = _window_return(dates, navs, 0, end_idx, annualise=one_year) if end_idx > 0 else None
    put("since", since, "n/m")

    # Rolling 1Y (docs/05 9.2): every NAV date with a NAV at or before d - 1Y.
    rolling: list[float] = []
    for i in range(len(dates)):
        j = nav_on_or_before(dates, subtract_months(dates[i], 12))
        if j is None or j == i:
            continue
        r = _cagr(navs[j], navs[i], (dates[i] - dates[j]).days)
        if r is not None:
            rolling.append(r)
    rolling_doc: dict[str, Any] | None = None
    if rolling:
        rolling_doc = {
            "min": _pct(min(rolling)),
            "median": _pct(statistics.median(rolling)),
            "max": _pct(max(rolling)),
            "pct_positive": round(100.0 * sum(1 for r in rolling if r > 0) / len(rolling), 2),
            "count": len(rolling),
        }

    vol: float | None = None
    vol_reason: str | None = None
    drawdown: float | None = None
    window = _risk_window(dates, end_idx)
    sharpe: float | None = None
    sharpe_reason: str | None = None
    window_years = 0.0
    if window is None:
        vol_reason = "insufficient_history"
        sharpe_reason = "insufficient_history"
    else:
        start, window_years = window
        wd, wn = dates[start:], navs[start:]
        gaps = [(wd[i] - wd[i - 1]).days for i in range(1, len(wd))]
        if len(wn) >= 3 and gaps and statistics.median(gaps) > WEEKLY_NAV_GAP_DAYS:
            vol_reason = "weekly_nav"  # MF-07
        elif len(wn) < 3:
            vol_reason = "insufficient_history"
        else:
            logs = [math.log(wn[i] / wn[i - 1]) for i in range(1, len(wn))]
            vol = statistics.stdev(logs) * math.sqrt(TRADING_DAYS)
        peak, worst = wn[0], 0.0
        for v in wn:
            peak = max(peak, v)
            worst = min(worst, v / peak - 1.0)
        drawdown = worst
        if vol is None:
            sharpe_reason = vol_reason
        elif cagr_3y is None:  # no base NAV at or before end-36M (not a year-length test)
            sharpe_reason = "insufficient_history"
        elif vol <= 0:
            sharpe_reason = "n/m"
        else:
            sharpe = (cagr_3y - risk_free) / vol
    return {
        "end_date": end.isoformat(),
        "end_nav": navs[end_idx],
        "first_nav_date": dates[0].isoformat(),
        "returns": returns,
        "return_reasons": reasons,
        "volatility": _pct(vol),
        "volatility_reason": vol_reason,
        "volatility_years": round(window_years, 2) if window is not None else None,
        "max_drawdown": _pct(drawdown),
        "sharpe_like": None if sharpe is None else round(sharpe, 4),
        "sharpe_reason": sharpe_reason,
        "risk_free_rate": risk_free,
        "rolling_1y": rolling_doc,
        "nav_jumps": nav_jumps(dates, navs),
    }
