"""Relative strength (docs/05 12.14): the stock against the owner-imported NIFTY50 and against
tracked stocks of the same sector. A description of past prices: no verdict, no score, no target.

Pure: no clock, no database (the peers' prices arrive in ``PeerData``, read by ``analysis_db``).
Price return only (``adj_close``, dividends excluded). Percents and percentage points are rounded
to 4 decimals; an unknown value is ``None`` with a ``reason``, never 0, NaN or Infinity. The two
halves (``vs_index``, ``vs_peers``) fail independently: an exception makes that half ``None`` with
reason ``compute_error`` (logged), and the snapshot is still written.
"""

from __future__ import annotations

import logging
import math
from bisect import bisect_right
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from typing import Any

import numpy as np

from worker.analytics.inv_common import F64, PeerData, iso, median, pctile, r4


def norm_sector(label: str | None) -> str | None:
    """Trimmed sector label (spaces, tabs, newlines, NBSP); ``None`` when blank."""
    out = None if label is None else label.strip(SECTOR_TRIM)
    return out or None


log = logging.getLogger("worker.relative_strength")

INDEX_CODE = "NIFTY50"
BASIS = "price return (adj_close), excludes dividends"

INDEX_WINDOWS: tuple[tuple[str, int], ...] = (("1m", 21), ("3m", 63), ("6m", 126), ("1y", 252))
PEER_WINDOWS: tuple[tuple[str, int], ...] = (("3m", 63), ("6m", 126), ("1y", 252))
ROLLING_ROWS = 252
MIN_ALIGNED = 22  # below this even the 1-month window is impossible: `no_index_series`
MIN_WINDOWS = 20  # INV_MIN_WINDOWS default (docs/05 12.0); the snapshot passes the setting
MIN_PEERS = 3  # hidden below 3 peers (plan item E)
SMALL_PEERS = 5  # RST-4: judgement, not evidence
YEARS_SHOWN = 10
TIE_TOL = 1e-12  # a win needs a margin above float noise: exact scalar multiples tie (N1)
SECTOR_TRIM = " \t\r\n\u00a0"  # the same set as the SQL btrim in analysis_db (N3)

INSUFFICIENT_HISTORY = "insufficient_history"
INSUFFICIENT_OVERLAP = "insufficient_overlap"


@dataclass(frozen=True)
class Aligned:
    """Inner join of the stock's bars and the index on date (docs/05 12.14.1)."""

    dates: list[date]
    stock: F64
    index: F64
    n_stock: int
    dropped_stock: int
    dropped_index: int


def clean_index(bench: Mapping[date, float]) -> dict[date, float]:
    """Only finite values greater than 0 are index rows."""
    return {d: v for d, v in bench.items() if math.isfinite(v) and v > 0}


def align(dates: Sequence[date], close: F64, idx: Mapping[date, float]) -> Aligned:
    keep = [i for i, d in enumerate(dates) if d in idx]
    kept = [dates[i] for i in keep]
    stock = np.array([close[i] for i in keep], dtype=np.float64)
    index = np.array([idx[d] for d in kept], dtype=np.float64)
    have = set(dates)
    first, last = dates[0], dates[-1]
    dropped_index = sum(1 for d in idx if first <= d <= last and d not in have)
    return Aligned(kept, stock, index, len(dates), len(dates) - len(kept), dropped_index)


def _pct(a: float, b: float) -> float:
    return (a / b - 1.0) * 100.0


def _window_reason(n_stock: int, m: int, w: int) -> str | None:
    """Why a window of ``w`` rows cannot be computed, or ``None`` when it can."""
    if m > w:
        return None
    return INSUFFICIENT_OVERLAP if n_stock > w else INSUFFICIENT_HISTORY


def trailing_windows(al: Aligned, windows: Sequence[tuple[str, int]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    m = len(al.dates)
    for key, w in windows:
        reason = _window_reason(al.n_stock, m, w)
        row: dict[str, Any] = {
            "key": key,
            "rows": w,
            "stock_pct": None,
            "index_pct": None,
            "excess_pp": None,
            "base_date": None,
            "reason": reason,
        }
        if reason is None:
            sp = _pct(float(al.stock[-1]), float(al.stock[-1 - w]))
            ip = _pct(float(al.index[-1]), float(al.index[-1 - w]))
            # prices are finite and positive (clean_index, valid bars), so these are finite
            row.update(
                stock_pct=r4(sp),
                index_pct=r4(ip),
                excess_pp=r4(sp - ip),
                base_date=al.dates[-1 - w].isoformat(),
            )
        out.append(row)
    return out


def calendar_years(al: Aligned, shown: int = YEARS_SHOWN) -> list[dict[str, Any]]:
    """One row per calendar year with a base in the previous year (docs/05 12.14.3)."""
    last_of_year: dict[int, int] = {}
    for i, d in enumerate(al.dates):
        last_of_year[d.year] = i
    years = sorted(y for y in last_of_year if y - 1 in last_of_year)[-shown:]
    final_year = al.dates[-1].year if al.dates else 0
    rows: list[dict[str, Any]] = []
    for y in years:
        b, e = last_of_year[y - 1], last_of_year[y]
        sp = _pct(float(al.stock[e]), float(al.stock[b]))
        ip = _pct(float(al.index[e]), float(al.index[b]))
        stock_pct, index_pct, excess = r4(sp), r4(ip), r4(sp - ip)
        if stock_pct is None or index_pct is None or excess is None:
            continue
        rows.append(
            {
                "year": y,
                "kind": "ytd" if y == final_year else "full",
                "base_date": al.dates[b].isoformat(),
                "end_date": al.dates[e].isoformat(),
                "stock_pct": stock_pct,
                "index_pct": index_pct,
                "excess_pp": excess,
            }
        )
    return rows


def rebased_ratio(
    al: Aligned, series_dates: Sequence[date]
) -> tuple[list[float | None] | None, str | None, str | None]:
    """``(values aligned to series_dates, base date, reason)`` (docs/05 12.14.4)."""
    pos = {d: j for j, d in enumerate(al.dates)}
    hits = [(i, pos[d]) for i, d in enumerate(series_dates) if d in pos]
    if len(hits) < 2:
        return None, None, INSUFFICIENT_OVERLAP
    base = float(al.stock[hits[0][1]] / al.index[hits[0][1]])
    values: list[float | None] = [None] * len(series_dates)
    for i, j in hits:
        values[i] = r4(100.0 * float(al.stock[j] / al.index[j]) / base)
    return values, series_dates[hits[0][0]].isoformat(), None


def rolling_year(
    al: Aligned, *, w: int = ROLLING_ROWS, min_windows: int = MIN_WINDOWS
) -> dict[str, Any]:
    """Share of rolling ``w``-row windows in which the stock beat the index (docs/05 12.14.5)."""
    m = len(al.dates)
    out: dict[str, Any] = {
        "windows": 0,
        "independent_periods": 0,
        "share_beat_pct": None,
        "median_excess_pp": None,
        "small_sample": False,
        "reason": _window_reason(al.n_stock, m, w),
    }
    if out["reason"] is not None:
        return out
    r = al.stock[w:] / al.stock[:-w] - 1.0
    b = al.index[w:] / al.index[:-w] - 1.0
    windows = m - w
    out["windows"] = windows
    out["independent_periods"] = (m - 1) // w
    if windows < min_windows:
        out["reason"] = "too_few_windows"
        return out
    out["share_beat_pct"] = r4(100.0 * int(np.count_nonzero(r - b > TIE_TOL)) / windows)
    out["median_excess_pp"] = r4(median((r - b) * 100.0))
    out["small_sample"] = out["independent_periods"] < 3
    return out


def vs_index(
    dates: Sequence[date],
    close: F64,
    bench: Mapping[date, float],
    series_dates: Sequence[date],
    *,
    windows: Sequence[tuple[str, int]] = INDEX_WINDOWS,
    rolling_rows: int = ROLLING_ROWS,
    min_windows: int = MIN_WINDOWS,
    min_aligned: int = MIN_ALIGNED,
) -> tuple[dict[str, Any] | None, str | None]:
    idx = clean_index(bench)
    if not idx:
        return None, "no_index_series"
    al = align(dates, close, idx)
    if len(al.dates) < min_aligned:
        return None, "no_index_series"
    ratio, base, ratio_reason = rebased_ratio(al, series_dates)
    return (
        {
            "index_code": INDEX_CODE,
            "index_as_of": max(idx).isoformat(),
            "index_rows": len(idx),
            "aligned_rows": len(al.dates),
            "first_aligned": al.dates[0].isoformat(),
            "last_aligned": al.dates[-1].isoformat(),
            "dropped_stock_dates": al.dropped_stock,
            "dropped_index_dates": al.dropped_index,
            "windows": trailing_windows(al, windows),
            "years": calendar_years(al),
            "rolling_year": rolling_year(al, w=rolling_rows, min_windows=min_windows),
            "ratio_rebased": ratio,
            "ratio_base_date": base,
            "ratio_reason": ratio_reason,
        },
        None,
    )


def _peer_return(p_dates: Sequence[date], p_close: F64, end: date, w: int) -> float | None:
    """Peer return over ``w`` rows ending on ``end``; needs a bar on ``end`` and ``w + 1`` rows."""
    k = bisect_right(p_dates, end)
    if k < w + 1 or p_dates[k - 1] != end:
        return None
    return _pct(float(p_close[k - 1]), float(p_close[k - 1 - w]))


def vs_peers(
    dates: Sequence[date],
    close: F64,
    peers: PeerData | None,
    *,
    windows: Sequence[tuple[str, int]] = PEER_WINDOWS,
    min_peers: int = MIN_PEERS,
    small_peers: int = SMALL_PEERS,
) -> tuple[dict[str, Any] | None, str | None]:
    if peers is None or norm_sector(peers.sector) is None:
        return None, "no_sector"
    if peers.failed:
        return None, "compute_error"
    end = dates[-1]
    n = len(dates)
    rows: list[dict[str, Any]] = []
    used: set[int] = set()
    for key, w in windows:
        theirs: list[float] = []
        for pid, (p_dates, p_close) in peers.closes.items():
            ret = _peer_return(p_dates, p_close, end, w)
            if ret is not None and math.isfinite(ret):
                theirs.append(ret)
                used.add(pid)
        row: dict[str, Any] = {
            "key": key,
            "rows": w,
            "stock_pct": None,
            "n_peers": len(theirs),
            "n_total": None,
            "rank": None,
            "percentile": None,
            "peer_median_pct": None,
            "vs_median_pp": None,
            "base_date": None,
            "small_sample": False,
            "reason": None,
        }
        rows.append(row)
        if n <= w:
            row["reason"] = INSUFFICIENT_HISTORY  # no stock return: n_total stays null (N2)
            continue
        row["n_total"] = len(theirs) + 1
        row["base_date"] = dates[-1 - w].isoformat()
        mine = _pct(float(close[-1]), float(close[-1 - w]))
        row["stock_pct"] = r4(mine)
        if len(theirs) < min_peers:
            row["reason"] = "too_few_peers"
            continue
        arr = np.array(theirs, dtype=np.float64)
        med = median(arr)
        row.update(
            rank=1 + int(np.count_nonzero(arr > mine)),
            percentile=r4(pctile(mine, np.append(arr, mine))),
            peer_median_pct=r4(med),
            vs_median_pp=r4(mine - med),
            small_sample=len(theirs) < small_peers,
        )
    return (
        {
            "sector": norm_sector(peers.sector),
            "as_of": end.isoformat(),
            "peers_in_sector": peers.peers_in_sector,
            "excluded": max(peers.peers_in_sector - len(used), 0),
            "windows": rows,
        },
        None,
    )


def build(
    dates: Sequence[date],
    close: F64,
    bench: Mapping[date, float],
    series_dates: Sequence[date],
    peers: PeerData | None,
    *,
    symbol: str | None = None,
    min_windows: int = MIN_WINDOWS,
) -> dict[str, Any]:
    """The ``analysis.relative_strength`` block; each half is isolated (docs/05 12.14)."""
    out: dict[str, Any] = {
        "as_of": iso(dates[-1]),
        "bars": len(dates),
        "basis": BASIS,
    }

    def fail(half: str, exc: Exception) -> None:
        log.warning(
            "relative_strength_failed",
            extra={"symbol": symbol, "half": half, "error": type(exc).__name__},
        )

    try:
        out["vs_index"], out["vs_index_reason"] = vs_index(
            dates, close, bench, series_dates, min_windows=min_windows
        )
    except Exception as exc:  # per-half isolation (RST-B01)
        fail("vs_index", exc)
        out["vs_index"], out["vs_index_reason"] = None, "compute_error"
    try:
        out["vs_peers"], out["vs_peers_reason"] = vs_peers(dates, close, peers)
    except Exception as exc:
        fail("vs_peers", exc)
        out["vs_peers"], out["vs_peers_reason"] = None, "compute_error"
    return out
