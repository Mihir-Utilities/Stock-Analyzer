"""Swing dips (docs/05 section 12.13, rules SWD-1..SWD-8): falls of at least X percent from the
recent peak, recovered or not, counted as often as they happened.

Two descriptions of the same closes, both close-based (``adj_close``, price return):

* *peak-recovery dips* (the 52-week-high rule): a dip starts when the close is at least X percent
  below the highest close of the 252-row window ending that day and ends when a later close is
  back at or above that peak. One dip per peak.
* *swing legs* (the zig-zag rule): a fall of X percent from a running peak, ended when the close
  bounces X percent above the fall's lowest close.

Past prices only: no verdict, no score, no target. Windows and thresholds are arguments (the
golden vectors use small windows); an unknown value is ``None`` with a ``*_reason``, never 0, NaN
or Infinity. Pure: no clock, no database, no network.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date
from typing import Any

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

from worker.analytics.inv_common import F64, INSUFFICIENT, InvSettings, iso, median, r4

log = logging.getLogger("worker.swing_dips")

SWING_THRESHOLDS = (10, 20)
SWING_WINDOW = 252
MAX_RECORDS = 8
_CMP = 9  # decimals kept before comparing percents (so 90/100-1 counts as -10)


@dataclass
class _Dip:
    ref: float
    peak: int
    start: int
    low: int
    end: int | None = None  # recovery (or bounce) row; None while open


def _pct(a: float, b: float) -> float:
    """``a / b - 1`` as a percent rounded for comparison against a threshold."""
    return round((a / b - 1.0) * 100.0, _CMP)


def find_dips(close: F64, x: float, w: int, tol: float) -> list[_Dip]:
    """Peak-recovery dips of at least ``x`` percent (docs/05 12.13, SWD-1, SWD-3)."""
    n = len(close)
    if n < w:
        return []
    top = np.max(sliding_window_view(close, w), axis=1)  # top[i] = max(close[i..i+w-1])
    dips: list[_Dip] = []
    cur: _Dip | None = None
    for t in range(w - 1, n):
        if cur is None:
            ref = float(top[t - w + 1])
            if _pct(float(close[t]), ref) <= -x + tol:
                window = close[t - w + 1 : t + 1]
                peak = t - w + 1 + int(np.flatnonzero(window == ref)[-1])
                cur = _Dip(ref=ref, peak=peak, start=t, low=t)
        elif close[t] >= cur.ref:
            cur.end = t
            dips.append(cur)
            cur = None
        elif close[t] < close[cur.low]:
            cur.low = t
    if cur is not None:
        dips.append(cur)
    return dips


def find_legs(close: F64, x: float, tol: float) -> list[_Dip]:
    """Zig-zag swing legs of at least ``x`` percent fall and ``x`` percent bounce (SWD-6)."""
    n = len(close)
    legs: list[_Dip] = []
    if n < 2:
        return legs
    peak = 0
    cur: _Dip | None = None
    for t in range(1, n):
        if cur is None:
            if close[t] >= close[peak]:
                peak = t  # the latest of equal closes
            elif _pct(float(close[t]), float(close[peak])) <= -x + tol:
                cur = _Dip(ref=float(close[peak]), peak=peak, start=t, low=t)
        elif close[t] < close[cur.low]:
            cur.low = t
        elif _pct(float(close[t]), float(close[cur.low])) >= x - tol:
            cur.end = t
            legs.append(cur)
            peak = t
            cur = None
    if cur is not None:
        legs.append(cur)
    return legs


def _lean(d: dict[str, Any]) -> dict[str, Any]:
    """Omits a ``reason`` / ``*_reason`` that is null (absent means null), as the SIP variants do,
    to keep the stored snapshot under its size budget (RET-89)."""
    return {k: v for k, v in d.items() if not (v is None and k.endswith("reason"))}


def _record(d: _Dip, dates: list[date], close: F64, end_key: str) -> dict[str, Any]:
    low_close = float(close[d.low])
    end = d.end
    out: dict[str, Any] = {
        "peak_date": iso(dates[d.peak]),
        "peak_close": r4(d.ref),
        "start_date": iso(dates[d.start]),
        "low_date": iso(dates[d.low]),
        "low_close": r4(low_close),
        "depth_pct": r4((low_close / d.ref - 1.0) * 100.0),
        "days_peak_to_low": (dates[d.low] - dates[d.peak]).days,
        f"{end_key}_date": None if end is None else iso(dates[end]),
        f"days_low_to_{end_key}": None if end is None else (dates[end] - dates[d.low]).days,
        f"days_low_to_{end_key}_reason": "open_dip" if end is None else None,
        "status": "open" if end is None else ("recovered" if end_key == "recovery" else "bounced"),
    }
    return out


def _med(values: list[float], minimum: int) -> tuple[float | None, str | None]:
    if len(values) < minimum:
        return None, "too_few_episodes"
    return r4(median(np.array(values, dtype=np.float64))), None


def _summary(
    dips: list[_Dip],
    dates: list[date],
    close: F64,
    settings: InvSettings,
    end_key: str,
) -> dict[str, Any]:
    done = [d for d in dips if d.end is not None]
    opened = [d for d in dips if d.end is None]
    depths = [(float(close[d.low]) / d.ref - 1.0) * 100.0 for d in dips]
    to_low = [float((dates[d.low] - dates[d.peak]).days) for d in dips]
    to_end = [float((dates[d.end] - dates[d.low]).days) for d in done if d.end is not None]
    m = settings.min_episodes
    med_depth, med_depth_r = _med(depths, m)
    med_low, med_low_r = _med(to_low, m)
    med_end, med_end_r = _med(to_end, m)
    share, share_r = (
        (r4(100.0 * len(done) / len(dips)), None) if len(dips) >= m else (None, "too_few_episodes")
    )
    out: dict[str, Any] = {
        "dips" if end_key == "recovery" else "legs": len(dips),
        "recovered" if end_key == "recovery" else "bounced": len(done),
        "open": len(opened),
        "median_depth_pct": med_depth,
        "median_depth_reason": med_depth_r,
        "worst_depth_pct": r4(min(depths)) if depths else None,
        "worst_depth_reason": None if depths else "no_dips",
        "median_days_peak_to_low": med_low,
        "median_days_peak_to_low_reason": med_low_r,
        f"median_days_to_{'recover' if end_key == 'recovery' else 'bounce'}": med_end,
        f"median_days_to_{'recover' if end_key == 'recovery' else 'bounce'}_reason": med_end_r,
        "small_sample": len(dips) < settings.small_episodes,
        "reason": None,
    }
    if end_key == "recovery":
        out["recovered_share_pct"] = share
        out["recovered_share_reason"] = share_r
        if opened:
            out["longest_open_days"] = max((dates[-1] - dates[d.peak]).days for d in opened)
            out["longest_open_reason"] = None
        else:
            out["longest_open_days"] = None
            out["longest_open_reason"] = "no_open_dip"
    return out


def _empty(x: int, end_key: str, reason: str) -> dict[str, Any]:
    first = "dips" if end_key == "recovery" else "legs"
    done = "recovered" if end_key == "recovery" else "bounced"
    verb = "recover" if end_key == "recovery" else "bounce"
    out: dict[str, Any] = {
        "threshold_pct": x,
        first: None,
        done: None,
        "open": None,
        "median_depth_pct": None,
        "median_depth_reason": reason,
        "worst_depth_pct": None,
        "worst_depth_reason": reason,
        "median_days_peak_to_low": None,
        "median_days_peak_to_low_reason": reason,
        f"median_days_to_{verb}": None,
        f"median_days_to_{verb}_reason": reason,
        "small_sample": True,
        "reason": reason,
    }
    if end_key == "recovery":
        out.update(
            recovered_share_pct=None,
            recovered_share_reason=reason,
            longest_open_days=None,
            longest_open_reason=reason,
            records=[],
        )
    return out


def swing_dips(
    dates: list[date],
    close: F64,
    settings: InvSettings,
    *,
    w52: int = SWING_WINDOW,
    thresholds: tuple[int, ...] = SWING_THRESHOLDS,
    max_records: int = MAX_RECORDS,
) -> dict[str, Any]:
    """The ``analysis.swing_dips`` block (docs/05 12.13, docs/03 4a)."""
    n = len(close)
    rows: list[dict[str, Any]] = []
    zig: list[dict[str, Any]] = []
    for x in thresholds:
        if n < w52:
            rows.append(_empty(x, "recovery", INSUFFICIENT))
        else:
            dips = find_dips(close, float(x), w52, settings.dd_tol)
            row = {"threshold_pct": x, **_summary(dips, dates, close, settings, "recovery")}
            recent = dips[-max_records:][::-1]  # the newest first
            row["records"] = [_lean(_record(d, dates, close, "recovery")) for d in recent]
            rows.append(_lean(row))
        if n < 2:
            zig.append(_empty(x, "bounce", INSUFFICIENT))
        else:
            legs = find_legs(close, float(x), settings.dd_tol)
            zig.append(
                _lean({"threshold_pct": x, **_summary(legs, dates, close, settings, "bounce")})
            )
    return {
        "as_of": dates[-1].isoformat(),
        "bars": n,
        "window_rows": w52,
        "thresholds": rows,
        "zigzag": zig,
    }


def swing_dips_safe(
    dates: list[date], close: F64, settings: InvSettings
) -> tuple[dict[str, Any] | None, str | None]:
    """Per-block failure isolation (docs/05 12.13, SWD-7): ``(block, None)`` or, when the block
    raises, ``(None, "compute_error")`` after a log line with the error type only. It never
    aborts the snapshot."""
    try:
        return swing_dips(dates, close, settings), None
    except Exception as exc:  # noqa: BLE001 - isolation is the point: any failure becomes a reason
        log.warning("swing_dips failed: %s", type(exc).__name__)
        return None, "compute_error"
