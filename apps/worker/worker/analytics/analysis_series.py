"""Analysis-tab series (docs/06 section on the Analysis sub-tab): drawdown, rolling volatility,
return histogram, month x year heatmap, calendar heatmap. Pure numpy; percent numbers throughout.

Series are stored **columnar** to keep ``analysis_snapshot`` small (free-tier DB budget,
docs/OPEN_QUESTIONS D05a-A2/A6): one shared ``dates`` array (the last 750 rows) and one value array
per series, rounded to ``DIGITS`` decimals. Warm-up positions are ``null`` (never fabricated).
"""

from __future__ import annotations

import math
from datetime import date
from typing import Any

import numpy as np
from numpy.typing import NDArray

from worker.analytics import returns as rt

F64 = NDArray[np.float64]

SERIES_ROWS = 750  # docs/03 section 4: series limited to the last 750 trading days
HEATMAP_YEARS = 10
CALENDAR_DAYS = 365
HIST_BINS = 40


def num(v: float) -> float | None:
    """JSON-safe number: nan/inf become null."""
    return float(v) if math.isfinite(v) else None


DIGITS = 4


def column(values: F64) -> list[float | None]:
    """Rounded JSON-safe values (nan/inf -> null)."""
    return [None if not math.isfinite(float(v)) else round(float(v), DIGITS) for v in values]


def rolling_vol(close: F64, n: int) -> F64:
    """Annualised rolling volatility (percent) of daily log returns; first valid at row ``n``."""
    out = np.full(len(close), np.nan)
    if len(close) <= n:
        return out
    lr = rt.log_returns(close)
    for t in range(n, len(close)):
        out[t] = lr[t - n : t].std(ddof=1) * math.sqrt(rt.ANNUALIZATION) * 100.0
    return out


def drawdown_column(close: F64) -> list[float | None]:
    """Drawdown from the running maximum inside the displayed window (last 750 rows)."""
    return column(rt.drawdown_series(close[-SERIES_ROWS:]))


def histogram(close: F64, bins: int = HIST_BINS) -> dict[str, Any] | None:
    """Histogram of daily simple returns (percent) over the last window; None if < 20 returns."""
    with np.errstate(all="ignore"):
        r = rt.simple_returns(close[-(SERIES_ROWS + 1) :]) * 100.0
    r = r[np.isfinite(r)]  # np.histogram raises on nan/inf
    if len(r) < 20:
        return None
    counts, edges = np.histogram(r, bins=bins)
    return {
        "edges": [float(e) for e in edges],
        "counts": [int(c) for c in counts],
        "n": int(len(r)),
        "unit": "percent",
    }


def month_year(dates: list[date], close: F64) -> list[list[Any]]:
    """Monthly return = month-end close over the previous month-end close, as ``[year, month,
    percent]``. The first (partial) month of the history has no base and is omitted."""
    month_end: dict[tuple[int, int], float] = {}
    for d, c in zip(dates, close, strict=True):
        month_end[(d.year, d.month)] = float(c)  # dates ascend, so the last write is month-end
    keys = sorted(month_end)
    out: list[list[Any]] = []
    for prev, cur in zip(keys, keys[1:], strict=False):
        base = month_end[prev]
        pct = (month_end[cur] / base - 1.0) * 100.0 if base else math.nan
        out.append([cur[0], cur[1], num(pct)])
    cutoff = dates[-1].year - HEATMAP_YEARS
    return [row for row in out if row[0] > cutoff]


def calendar_days(dates: list[date], close: F64) -> dict[str, Any]:
    """Daily return (percent) per date for the last year of bars (columnar)."""
    out_dates: list[str] = []
    out_values: list[float | None] = []
    last = dates[-1]
    for i in range(1, len(close)):
        if (last - dates[i]).days < CALENDAR_DAYS:
            out_dates.append(dates[i].isoformat())
            base = float(close[i - 1])
            pct = (float(close[i]) / base - 1.0) * 100.0 if base else math.nan
            out_values.append(num(round(pct, DIGITS)) if math.isfinite(pct) else None)
    return {"dates": out_dates, "values": out_values}
