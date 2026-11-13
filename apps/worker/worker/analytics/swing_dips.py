"""Swing dips (docs/05 section 12.13, rules SWD-1..SWD-8): falls of at least X percent from the
recent peak, recovered or not, counted as often as they happened.

Two descriptions of the same closes, both close-based (``adj_close``, price return):

* *dips from the 52-week high* (rule A): a dip starts when the close is at least X percent below
  the highest close of the 252-row window ending that day. It ends when a later close is back at
  or above that reference high (**recovered**), or when the reference peak drops out of the
  252-row window while the dip is still open (**superseded**: not regained within a year; a new
  dip may then start from the new window high). At most one dip is open at a time.
* *swings* (rule B, zig-zag): a fall of X percent from a running peak, ended when the close
  bounces X percent above the fall's lowest close.

Past prices only: no verdict, no score, no target. Windows and thresholds are arguments (the
golden vectors use small windows); an unknown value is ``None`` with a ``*_reason``, never 0, NaN
or Infinity. Pure: no clock, no database, no network.
"""

from __future__ import annotations

import logging
import os
import traceback
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
    end: int | None = None  # recovery / bounce row (rule A: also the supersession row)
    status: str = "open"  # open | recovered | superseded (rule A); open | bounced (rule B)


def _pct(a: float, b: float) -> float:
    """``a / b - 1`` as a percent rounded for comparison against a threshold."""
    return round((a / b - 1.0) * 100.0, _CMP)


def window_highs(close: F64, w: int) -> F64:
    """``top[i]`` = max of ``close[i .. i+w-1]`` (the high of the window ending at row ``i+w-1``);
    empty when there are fewer than ``w`` rows. Computed once and shared by every threshold."""
    if len(close) < w:
        return np.empty(0, dtype=np.float64)
    return np.asarray(np.max(sliding_window_view(close, w), axis=1), dtype=np.float64)


def find_dips(close: F64, x: float, w: int, tol: float, top: F64 | None = None) -> list[_Dip]:
    """Dips from the 52-week high of at least ``x`` percent (docs/05 12.13, SWD-1, SWD-3).

    At each row ``t >= w-1``, with ``H_t`` the window high: an open dip first tests recovery
    (``C_t >= ref``), then updates its low, then is superseded when its peak row is older than
    the window (``peak < t-w+1``); when no dip is open (also straight after a supersession) a new
    dip starts if ``C_t`` is at least ``x`` percent below ``H_t``."""
    n = len(close)
    if n < w:
        return []
    highs = window_highs(close, w) if top is None else top
    dips: list[_Dip] = []
    cur: _Dip | None = None
    for t in range(w - 1, n):
        if cur is not None:
            if close[t] >= cur.ref:
                cur.end, cur.status = t, "recovered"
                dips.append(cur)
                cur = None
                continue  # no new dip starts on the row that recovers one
            if close[t] < close[cur.low]:
                cur.low = t
            if cur.peak < t - w + 1:
                cur.end, cur.status = t, "superseded"
                dips.append(cur)
                cur = None
        if cur is None:
            ref = float(highs[t - w + 1])
            if _pct(float(close[t]), ref) <= -x + tol:
                window = close[t - w + 1 : t + 1]
                peak = t - w + 1 + int(np.flatnonzero(window == ref)[-1])
                cur = _Dip(ref=ref, peak=peak, start=t, low=t)
    if cur is not None:
        dips.append(cur)
    return dips


def find_legs(close: F64, x: float, tol: float) -> list[_Dip]:
    """Zig-zag swings of at least ``x`` percent fall and ``x`` percent bounce (SWD-6)."""
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
            cur.end, cur.status = t, "bounced"
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


def _record(d: _Dip, dates: list[date], close: F64) -> dict[str, Any]:
    low_close = float(close[d.low])
    recovered = d.status == "recovered"
    return {
        "peak_date": iso(dates[d.peak]),
        "peak_close": r4(d.ref),
        "low_date": iso(dates[d.low]),
        "low_close": r4(low_close),
        "depth_pct": r4((low_close / d.ref - 1.0) * 100.0),
        "days_peak_to_low": (dates[d.low] - dates[d.peak]).days,
        "recovery_date": iso(dates[d.end]) if recovered and d.end is not None else None,
        "days_low_to_recovery": (
            (dates[d.end] - dates[d.low]).days if recovered and d.end is not None else None
        ),
        "days_low_to_recovery_reason": None if recovered else d.status if d.end else "open_dip",
        "status": d.status,
    }


def _med(values: list[float], minimum: int) -> tuple[float | None, str | None]:
    if len(values) < minimum:
        return None, "too_few_episodes"
    return r4(median(np.array(values, dtype=np.float64))), None


def _summary(
    dips: list[_Dip],
    dates: list[date],
    close: F64,
    settings: InvSettings,
    rule_a: bool,
) -> dict[str, Any]:
    done_status = "recovered" if rule_a else "bounced"
    done = [d for d in dips if d.status == done_status]
    opened = [d for d in dips if d.status == "open"]
    superseded = [d for d in dips if d.status == "superseded"]
    depths = [(float(close[d.low]) / d.ref - 1.0) * 100.0 for d in dips]
    to_low = [float((dates[d.low] - dates[d.peak]).days) for d in dips]
    to_end = [float((dates[d.end] - dates[d.low]).days) for d in done if d.end is not None]
    m = settings.min_episodes
    med_depth, med_depth_r = _med(depths, m)
    med_low, med_low_r = _med(to_low, m)
    med_end, med_end_r = _med(to_end, m)
    verb = "recover" if rule_a else "bounce"
    out: dict[str, Any] = {
        "dips" if rule_a else "legs": len(dips),
        "recovered" if rule_a else "bounced": len(done),
        "open": len(opened),
        "median_depth_pct": med_depth,
        "median_depth_reason": med_depth_r,
        "worst_depth_pct": r4(min(depths)) if depths else None,
        "worst_depth_reason": None if depths else "no_dips",
        "median_days_peak_to_low": med_low,
        "median_days_peak_to_low_reason": med_low_r,
        f"median_days_to_{verb}": med_end,
        f"median_days_to_{verb}_reason": med_end_r,
        "small_sample": len(dips) < settings.small_episodes,
        "reason": None,
    }
    if rule_a:
        out["superseded"] = len(superseded)
        if len(dips) >= m:
            out["recovered_share_pct"] = r4(100.0 * len(done) / len(dips))
            out["recovered_share_reason"] = None
        else:
            out["recovered_share_pct"] = None
            out["recovered_share_reason"] = "too_few_episodes"
        if opened:
            out["longest_open_days"] = max((dates[-1] - dates[d.peak]).days for d in opened)
            out["longest_open_reason"] = None
        else:
            out["longest_open_days"] = None
            out["longest_open_reason"] = "no_open_dip"
    return out


def _empty(x: int, rule_a: bool, reason: str) -> dict[str, Any]:
    verb = "recover" if rule_a else "bounce"
    out: dict[str, Any] = {
        "threshold_pct": x,
        "dips" if rule_a else "legs": None,
        "recovered" if rule_a else "bounced": None,
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
    if rule_a:
        out.update(
            superseded=None,
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
    """The ``analysis.swing_dips`` block (docs/05 12.13, docs/03 4a-swing)."""
    n = len(close)
    rows: list[dict[str, Any]] = []
    zig: list[dict[str, Any]] = []
    highs = window_highs(close, w52)  # shared by every threshold
    for x in thresholds:
        if n < w52:
            rows.append(_empty(x, True, INSUFFICIENT))
        else:
            dips = find_dips(close, float(x), w52, settings.dd_tol, highs)
            row = {"threshold_pct": x, **_summary(dips, dates, close, settings, True)}
            recent = dips[-max_records:][::-1]  # the newest first
            row["records"] = [_lean(_record(d, dates, close)) for d in recent]
            rows.append(_lean(row))
        if n < 2:
            zig.append(_empty(x, False, INSUFFICIENT))
        else:
            legs = find_legs(close, float(x), settings.dd_tol)
            zig.append(_lean({"threshold_pct": x, **_summary(legs, dates, close, settings, False)}))
    return {
        "as_of": dates[-1].isoformat(),
        "bars": n,
        "window_rows": w52,
        "min_episodes": settings.min_episodes,
        "thresholds": rows,
        "zigzag": zig,
    }


def _innermost_frame(exc: BaseException) -> str:
    frames = traceback.extract_tb(exc.__traceback__)
    if not frames:
        return "unknown"
    f = frames[-1]
    return f"{os.path.basename(f.filename)}:{f.lineno}"


def swing_dips_safe(
    dates: list[date],
    close: F64,
    settings: InvSettings,
    symbol: str | None = None,
) -> tuple[dict[str, Any] | None, str | None]:
    """Per-block failure isolation (docs/05 12.13, SWD-7): ``(block, None)`` or, when the block
    raises, ``(None, "compute_error")`` after a log line with the symbol, the bar count, the
    exception type and the innermost frame (file:line), never the message (it may hold data).
    It never aborts the snapshot."""
    try:
        return swing_dips(dates, close, settings), None
    except Exception as exc:  # noqa: BLE001 - isolation is the point: any failure becomes a reason
        log.warning(
            "swing_dips failed: symbol=%s bars=%d error=%s at %s",
            symbol or "-",
            len(close),
            type(exc).__name__,
            _innermost_frame(exc),
        )
        return None, "compute_error"
