"""Investment-context blocks of ``analysis`` (docs/05 12.3-12.9): price position, drawdown profile,
holding periods, entry-point study, volatility regime and risk-adjusted return.

Descriptions of past prices only: no verdict, no score, no target. Close-based (``adj_close``,
price return, dividends excluded). Windows and thresholds are arguments (the golden vectors use
small windows); an unknown value is ``None`` with a ``*_reason``, never 0, NaN or Infinity.
"""

from __future__ import annotations

import math
from datetime import date
from typing import Any

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

from worker.analytics import returns as rt
from worker.analytics.inv_common import (
    F64,
    INSUFFICIENT,
    InvSettings,
    iso,
    median,
    pctile,
    r4,
)

# ------------------------------------------------------------------ 12.3 price position
W52 = 252
SMA_WINDOW = 200
MIN_ALL_ROWS = 504


def position(
    dates: list[date],
    close: F64,
    *,
    w: int = W52,
    sma_window: int = SMA_WINDOW,
    min_all_rows: int = MIN_ALL_ROWS,
) -> dict[str, Any]:
    """Where the last close sits in its 52-week and whole-history range (docs/05 12.3)."""
    n = len(close)
    last = float(close[-1])
    out: dict[str, Any] = {
        "as_of": dates[-1].isoformat(),
        "bars": n,
        "close": r4(last),
        "high_52w_close": None,
        "low_52w_close": None,
        "range_pos_52w_pct": None,
        "range_pos_52w_reason": None,
        "range_band": None,
        "dist_high_52w_pct": None,
        "dist_high_all_pct": None,
        "high_all_date": None,
        "history_first_date": dates[0].isoformat(),
        "pctile_52w": None,
        "pctile_52w_reason": None,
        "pctile_all": None,
        "pctile_all_reason": None,
        "pctile_all_n": n,
        "sma200": None,
        "ext_sma200_pct": None,
        "ext_sma200_reason": None,
    }
    peak = float(np.max(close))
    out["dist_high_all_pct"] = r4((last / peak - 1.0) * 100.0)
    out["high_all_date"] = dates[int(np.flatnonzero(close == peak)[-1])].isoformat()

    if n >= w:
        win = close[-w:]
        hi, lo = float(np.max(win)), float(np.min(win))
        out["high_52w_close"], out["low_52w_close"] = r4(hi), r4(lo)
        out["dist_high_52w_pct"] = r4((last / hi - 1.0) * 100.0)
        out["pctile_52w"] = r4(pctile(last, win))
        if hi == lo:
            out["range_pos_52w_reason"] = "flat_range"
        else:
            pos = 100.0 * (last - lo) / (hi - lo)
            out["range_pos_52w_pct"] = r4(pos)
            out["range_band"] = (
                "lower" if pos < 100 / 3 else ("middle" if pos < 200 / 3 else "upper")
            )
    else:
        out["range_pos_52w_reason"] = INSUFFICIENT  # also explains the other 52-week values
        out["pctile_52w_reason"] = INSUFFICIENT
    if n >= min_all_rows:
        out["pctile_all"] = r4(pctile(last, close))
    else:
        out["pctile_all_reason"] = INSUFFICIENT
    if n >= sma_window:
        sma = float(close[-sma_window:].mean())
        out["sma200"] = r4(sma)
        out["ext_sma200_pct"] = r4((last / sma - 1.0) * 100.0)
    else:
        out["ext_sma200_reason"] = INSUFFICIENT
    return out


# ------------------------------------------------------------------ 12.4 drawdown profile
RECOVERY_THRESHOLDS = (10, 20)


def drawdown_profile(
    dates: list[date],
    close: F64,
    settings: InvSettings,
    thresholds: tuple[int, ...] = RECOVERY_THRESHOLDS,
) -> dict[str, Any]:
    """Drawdown from the running maximum over the whole history (docs/05 12.4)."""
    n = len(close)
    peaks = np.maximum.accumulate(close)
    dd = (close / peaks - 1.0) * 100.0

    # Episodes: start at the first row below the running peak, end at the first row back at it.
    episodes: list[dict[str, Any]] = []
    cur: dict[str, Any] | None = None
    for t in range(n):
        if close[t] < peaks[t]:
            if cur is None:
                peak_idx = int(np.flatnonzero(close[:t] == peaks[t])[-1])
                cur = {"start": t, "peak_idx": peak_idx, "trough": t, "recovery": None}
            elif dd[t] < dd[cur["trough"]]:
                cur["trough"] = t
        elif cur is not None:
            cur["recovery"] = t
            episodes.append(cur)
            cur = None
    if cur is not None:
        episodes.append(cur)

    underwater = int(np.count_nonzero(close < peaks))
    top = int(np.argmin(dd))  # the first (earliest) of equal depths
    last = n - 1
    run_peak_idx = int(np.flatnonzero(close == peaks[last])[-1])
    max_dd: dict[str, Any]
    if dd[top] < 0:
        ep = next(e for e in episodes if e["start"] <= top and (e["recovery"] or n) > top)
        rec = ep["recovery"]
        max_dd = {
            "depth_pct": r4(float(dd[top])),
            "peak_date": dates[ep["peak_idx"]].isoformat(),
            "trough_date": dates[top].isoformat(),
            "recovery_date": None if rec is None else dates[rec].isoformat(),
            "recovered": rec is not None,
            "reason": None,
        }
    else:
        max_dd = {
            "depth_pct": 0.0,
            "peak_date": None,
            "trough_date": None,
            "recovery_date": None,
            "recovered": None,
            "reason": "no_drawdown",
        }

    recovery: list[dict[str, Any]] = []
    for x in thresholds:
        deep = []
        for e in episodes:
            end = e["recovery"] if e["recovery"] is not None else n
            hit = np.flatnonzero(dd[e["start"] : end] <= -x + settings.dd_tol)
            if len(hit):
                deep.append((e, e["start"] + int(hit[0])))
        rec_days = [(dates[e["recovery"]] - dates[c]).days for e, c in deep if e["recovery"]]
        n_rec = len(rec_days)
        shown = n_rec >= settings.min_episodes
        recovery.append(
            {
                "threshold_pct": x,
                "episodes": len(deep),
                "recovered": n_rec,
                "open": len(deep) - n_rec,
                "median_days": r4(median(np.array(rec_days, dtype=np.float64))) if shown else None,
                "median_days_reason": None if shown else "too_few_episodes",
                "small_sample": n_rec < settings.small_episodes,
            }
        )
    return {
        "as_of": dates[-1].isoformat(),
        "bars": n,
        "first_date": dates[0].isoformat(),
        "current_dd_pct": r4(float(dd[last])),
        "days_since_high": (dates[last] - dates[run_peak_idx]).days,
        "max_dd": max_dd,
        "underwater_rows": underwater,
        "time_under_water_pct": r4(100.0 * underwater / n),
        "avg_underwater_depth_pct": r4(float(dd[close < peaks].mean())) if underwater else None,
        "avg_underwater_depth_reason": None if underwater else "no_drawdown",
        "episodes_total": len(episodes),
        "recovery": recovery,
    }


# ------------------------------------------------------------------ 12.5 holding periods
HOLD_WINDOWS: dict[str, int] = {"1m": 21, "3m": 63, "6m": 126, "1y": 252, "3y": 756}
_CMP = 9  # decimals kept before comparing percents (so 20.000000000000004 ties 19.999999999999996)


def rolling_returns(close: F64, w: int) -> F64:
    """Cumulative return (percent) over every ``w``-row window ``C_t / C_{t-w} - 1``."""
    return np.round((close[w:] / close[:-w] - 1.0) * 100.0, _CMP)


def holding_periods(
    dates: list[date],
    close: F64,
    settings: InvSettings,
    windows: dict[str, int] | None = None,
) -> dict[str, Any]:
    """What a buyer on any past day would have had after ``w`` rows (docs/05 12.5)."""
    n = len(close)
    rows: list[dict[str, Any]] = []
    for key, w in (windows or HOLD_WINDOWS).items():
        count = max(n - w, 0)
        indep = (n - 1) // w
        row: dict[str, Any] = {
            "key": key,
            "rows": w,
            "windows": count,
            "independent_periods": indep,
            "share_positive_pct": None,
            "median_pct": None,
            "best_pct": None,
            "best_end_date": None,
            "worst_pct": None,
            "worst_end_date": None,
            "reason": None,
            "small_sample": indep < 3,
        }
        if n <= w:
            row["reason"] = INSUFFICIENT
        elif count < settings.min_windows:
            row["reason"] = "too_few_windows"
        else:
            r = rolling_returns(close, w)
            bi, wi = int(np.argmax(r)), int(np.argmin(r))  # first index: the earliest end date
            row.update(
                share_positive_pct=r4(100.0 * np.count_nonzero(r > 0) / count),
                median_pct=r4(median(r)),
                best_pct=r4(float(r[bi])),
                best_end_date=dates[w + bi].isoformat(),
                worst_pct=r4(float(r[wi])),
                worst_end_date=dates[w + wi].isoformat(),
            )
        rows.append(row)
    return {"as_of": dates[-1].isoformat(), "bars": n, "windows": rows}


# ------------------------------------------------------------------ 12.6 entry-point study
ENTRY_HORIZONS: dict[str, int] = {"3m": 63, "6m": 126}
ENTRY_THRESHOLDS = (10, 20)


def entry_study(
    dates: list[date],
    close: F64,
    settings: InvSettings,
    *,
    w52: int = W52,
    horizons: dict[str, int] | None = None,
    thresholds: tuple[int, ...] = ENTRY_THRESHOLDS,
) -> dict[str, Any]:
    """After a fresh close at least X% below the 52-week highest close, what the next ``h`` rows
    did (docs/05 12.6). A description of what happened, not of what will."""
    n = len(close)
    hz = horizons or ENTRY_HORIZONS
    d52 = np.full(n, np.nan)
    if n >= w52:
        top = np.max(sliding_window_view(close, w52), axis=1)
        d52[w52 - 1 :] = np.round((close[w52 - 1 :] / top - 1.0) * 100.0, _CMP)
    rows: list[dict[str, Any]] = []
    for x in thresholds:
        line = -x + settings.dd_tol
        below = d52 <= line  # nan compares False
        for label, h in hz.items():
            events: list[int] = []
            prev = -(10**9)
            for t in range(w52, n):
                if below[t] and not below[t - 1] and np.isfinite(d52[t - 1]) and t >= prev + h:
                    events.append(t)
                    prev = t
            done = [t for t in events if t + h <= n - 1]
            f = np.array([(close[t + h] / close[t] - 1.0) * 100.0 for t in done], dtype=np.float64)
            f = np.round(f, _CMP)
            allw = rolling_returns(close, h) if n > h else None
            row: dict[str, Any] = {
                "drawdown_pct": x,
                "horizon": label,
                "horizon_rows": h,
                "episodes": len(done),
                "pending": len(events) - len(done),
                "median_pct": None,
                "worst_pct": None,
                "best_pct": None,
                "share_positive_pct": None,
                "all_windows_median_pct": None if allw is None else r4(median(allw)),
                "last_event_date": None,
                "reason": None,
                "small_sample": len(done) < settings.small_episodes,
            }
            if n < w52:
                row["reason"] = INSUFFICIENT
            elif len(done) < settings.min_episodes:
                row["reason"] = "too_few_episodes"
            else:
                row.update(
                    median_pct=r4(median(f)),
                    worst_pct=r4(float(np.min(f))),
                    best_pct=r4(float(np.max(f))),
                    share_positive_pct=r4(100.0 * np.count_nonzero(f > 0) / len(f)),
                    last_event_date=dates[done[-1]].isoformat(),
                )
            rows.append(row)
    return {"as_of": dates[-1].isoformat(), "bars": n, "w52_rows": w52, "rows": rows}


# ------------------------------------------------------------------ 12.7 volatility regime
VOL_WINDOW = 21
VOL_MIN_VALUES = 252


def band(percentile: float, settings: InvSettings) -> str:
    if percentile < settings.vol_band_low:
        return "lower"
    return "higher" if percentile >= settings.vol_band_high else "typical"


def vol_regime(
    dates: list[date],
    vol21: F64,
    settings: InvSettings,
    *,
    min_values: int = VOL_MIN_VALUES,
    window_rows: int = VOL_WINDOW,
) -> dict[str, Any]:
    """Where the latest 21-row annualised volatility sits among the stock's own history. ``vol21``
    is the full-history array (nan during warm-up), the values of ``analysis.rolling_vol_21``."""
    ok = np.isfinite(vol21)
    sample = vol21[ok]
    out: dict[str, Any] = {
        "as_of": dates[-1].isoformat(),
        "bars": len(dates),
        "window_rows": window_rows,
        "current_vol_pct": None,
        "percentile": None,
        "sample": int(len(sample)),
        "band": None,
        "reason": None,
        "first_date": iso(dates[int(np.flatnonzero(ok)[0])]) if len(sample) else None,
    }
    if len(sample) < min_values or not ok[-1]:
        out["reason"] = INSUFFICIENT
        return out
    cur = float(vol21[-1])
    pct = pctile(cur, sample)
    out.update(current_vol_pct=r4(cur), percentile=r4(pct), band=band(pct, settings))
    return out


# ------------------------------------------------------------------ 12.9 risk-adjusted return
def downside_deviation(returns_pct: F64) -> float:
    """``sqrt(mean(min(r, 0)^2)) * sqrt(252)`` over **all** returns (percent), target 0."""
    neg = np.minimum(returns_pct, 0.0)
    return float(math.sqrt(float(np.mean(neg * neg))) * math.sqrt(rt.ANNUALIZATION))


def calmar(cagr_pct: float, maxdd_pct: float) -> tuple[float | None, str | None]:
    if maxdd_pct == 0:
        return None, "no_drawdown"
    return r4(cagr_pct / abs(maxdd_pct)), None


def risk_adjusted(dates: list[date], close: F64) -> dict[str, Any]:
    """Calmar-style ratio and return per unit of downside deviation over the calendar 3-year
    window (docs/05 12.9). No Sharpe (it needs a risk-free rate)."""
    out: dict[str, Any] = {
        "as_of": dates[-1].isoformat(),
        "bars": len(dates),
        "window": "3y",
        "cagr_3y_pct": None,
        "maxdd_3y_window_pct": None,
        "calmar_3y": None,
        "calmar_3y_reason": None,
        "downside_dev_3y_pct": None,
        "return_per_downside_3y": None,
        "downside_reason": None,
    }
    cal = rt.ret_calendar(dates, close, 36)
    cagr = cal.cagr_pct.value
    if cal.start_date is None or cagr is None:
        out["calmar_3y_reason"] = out["downside_reason"] = INSUFFICIENT
        return out
    window = close[dates.index(cal.start_date) :]
    maxdd = float(np.min(rt.drawdown_series(window)))
    dev = downside_deviation(rt.simple_returns(window) * 100.0)
    out["cagr_3y_pct"] = r4(cagr)
    out["maxdd_3y_window_pct"] = r4(maxdd)
    out["calmar_3y"], out["calmar_3y_reason"] = calmar(cagr, maxdd)
    out["downside_dev_3y_pct"] = r4(dev)
    if dev == 0:
        out["downside_reason"] = "no_drawdown"
    else:
        out["return_per_downside_3y"] = r4(cagr / dev)
    return out
