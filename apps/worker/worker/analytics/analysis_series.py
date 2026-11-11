"""Analysis-tab series (docs/06 section on the Analysis sub-tab): drawdown, rolling volatility,
return histogram, month x year heatmap, calendar heatmap. Pure numpy; percent numbers throughout.

Series are stored **columnar** to keep ``analysis_snapshot`` small (free-tier DB budget,
docs/OPEN_QUESTIONS D05a-A2/A6): one shared ``dates`` array (the last 750 rows) and one value array
per series, rounded to ``DIGITS`` decimals. Warm-up positions are ``null`` (never fabricated).
"""

from __future__ import annotations

import math
from collections.abc import Collection
from datetime import date
from typing import Any

import numpy as np
from numpy.typing import NDArray

from worker.analytics import returns as rt
from worker.analytics.inv_months import MonthModel, month_cells

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


def month_year(
    dates: list[date],
    close: F64,
    today: date | None = None,
    holidays: Collection[date] = frozenset(),
) -> list[list[Any]]:
    """Monthly return = month-end close over the previous calendar month's close, as ``[year,
    month, percent|None]`` for the last ``HEATMAP_YEARS`` years (docs/05 12.1). The first month has
    no base and no cell. A month whose previous calendar month has no bar (or an incomplete one)
    is ``None``, never paired across the gap (INV-4); a closed month whose prices stop short of
    its last expected trading day is ``None`` too; the running month shows month to date.
    ``today`` defaults to the last bar's date (this function never reads the clock)."""
    model = MonthModel(dates, close, today or dates[-1], holidays)
    return month_cells(model)[0]


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
