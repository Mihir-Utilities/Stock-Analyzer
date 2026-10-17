"""Returns and risk (docs/05 section 4). Pure numpy, no database.

Percent-valued results (returns, CAGR, volatility, drawdown) are **percent numbers** (12.34 means
12.34%, docs/05 1; docs/OPEN_QUESTIONS D05a-A1). Beta, correlation and the Sharpe-like ratio are
plain ratios. An unknown value is ``Metric(None, reason)``: never 0, NaN or Infinity.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date

import numpy as np
from numpy.typing import NDArray

F64 = NDArray[np.float64]

TRADING_WINDOWS: dict[str, int] = {"1w": 5, "1m": 21, "3m": 63, "6m": 126, "1y": 252}
CALENDAR_MONTHS: dict[str, int] = {"1m": 1, "3m": 3, "6m": 6, "1y": 12, "3y": 36, "5y": 60}
ANNUALIZATION = 252
MIN_BETA_OBS = 120
BETA_WINDOW = 252

INSUFFICIENT = "insufficient_history"


@dataclass(frozen=True)
class Metric:
    value: float | None
    reason: str | None = None

    @staticmethod
    def of(value: float, reason: str = "n/m") -> Metric:
        """A finite number, or null with ``reason`` when the arithmetic produced nan/inf."""
        return Metric(value) if math.isfinite(value) else Metric(None, reason)


def ret_trading(close: F64, n: int) -> Metric:
    """``C_t / C_{t-n} - 1`` in percent over ``n`` trading rows; needs ``n + 1`` rows."""
    if len(close) <= n:
        return Metric(None, INSUFFICIENT)
    return Metric.of((close[-1] / close[-1 - n] - 1.0) * 100.0)


def subtract_months(d: date, months: int) -> date:
    """``d`` minus whole calendar months, day clamped to the end of the target month."""
    total = d.year * 12 + (d.month - 1) - months
    year, month = divmod(total, 12)
    month += 1
    for day in (d.day, 30, 29, 28):
        try:
            return date(year, month, day)
        except ValueError:
            continue
    raise AssertionError("unreachable")  # pragma: no cover


@dataclass(frozen=True)
class CalendarReturn:
    ret_pct: Metric
    cagr_pct: Metric  # only windows longer than one year
    start_date: date | None


def ret_calendar(dates: list[date], close: F64, months: int) -> CalendarReturn:
    """Display return: ``C_end / C_start - 1`` where ``C_start`` is the last bar on or before
    ``end - offset``; null if the first bar is later than that date. Windows over one year also
    carry ``CAGR = (C_end/C_start)^(365.25/days) - 1`` (days between the two bar dates)."""
    if not dates:
        return CalendarReturn(Metric(None, INSUFFICIENT), Metric(None, INSUFFICIENT), None)
    target = subtract_months(dates[-1], months)
    if dates[0] > target:
        miss = Metric(None, INSUFFICIENT)
        return CalendarReturn(miss, miss if months > 12 else Metric(None, "not_applicable"), None)
    start = max(i for i, d in enumerate(dates) if d <= target)
    ratio = float(close[-1] / close[start])
    days = (dates[-1] - dates[start]).days
    ret = Metric.of((ratio - 1.0) * 100.0)
    if months <= 12:
        return CalendarReturn(ret, Metric(None, "not_applicable"), dates[start])
    if days <= 0:
        return CalendarReturn(ret, Metric(None, "n/m"), dates[start])
    return CalendarReturn(ret, Metric.of((ratio ** (365.25 / days) - 1.0) * 100.0), dates[start])


def log_returns(close: F64) -> F64:
    return np.diff(np.log(close))


def simple_returns(close: F64) -> F64:
    return close[1:] / close[:-1] - 1.0


def volatility(close: F64, n: int) -> Metric:
    """``std(ln(C_t/C_{t-1}) over last n, ddof=1) * sqrt(252)`` in percent; needs ``n + 1`` rows."""
    if len(close) <= n or n < 2:
        return Metric(None, INSUFFICIENT)
    r = log_returns(close[-(n + 1) :])
    return Metric.of(float(r.std(ddof=1)) * math.sqrt(ANNUALIZATION) * 100.0)


def volatility_window(close: F64) -> Metric:
    """Annualised volatility (percent) of every daily log return inside ``close``."""
    if len(close) < 3:
        return Metric(None, INSUFFICIENT)
    return Metric.of(float(log_returns(close).std(ddof=1)) * math.sqrt(ANNUALIZATION) * 100.0)


def drawdown_series(close: F64) -> F64:
    """``C_t / max_{s<=t} C_s - 1`` in percent for every row of ``close`` (0 at new highs)."""
    return (close / np.maximum.accumulate(close) - 1.0) * 100.0


def max_drawdown(close: F64, rows: int | None) -> Metric:
    """Worst drawdown (percent, <= 0) over the last ``rows`` rows; ``None`` = all history.
    Needs the whole window: fewer rows than ``rows`` -> null."""
    if rows is not None and len(close) < rows:
        return Metric(None, INSUFFICIENT)
    if len(close) < 2:
        return Metric(None, INSUFFICIENT)
    window = close if rows is None else close[-rows:]
    return Metric.of(float(np.min(drawdown_series(window))))


@dataclass(frozen=True)
class BetaResult:
    beta: Metric
    correlation: Metric
    observations: int


def align(dates: list[date], close: F64, bench: dict[date, float]) -> tuple[list[date], F64, F64]:
    """Inner join of the stock's bars and the benchmark on date (docs/05 1)."""
    keep = [i for i, d in enumerate(dates) if d in bench]
    kept_dates = [dates[i] for i in keep]
    stock = np.array([close[i] for i in keep], dtype=np.float64)
    index = np.array([bench[d] for d in kept_dates], dtype=np.float64)
    return kept_dates, stock, index


def beta_corr(
    dates: list[date],
    close: F64,
    bench: dict[date, float],
    *,
    window: int = BETA_WINDOW,
    min_obs: int = MIN_BETA_OBS,
) -> BetaResult:
    """OLS slope and correlation of the stock's daily simple returns on the benchmark's, over the
    last ``window`` aligned returns; null below ``min_obs`` observations."""
    if not bench:
        miss = Metric(None, "no_benchmark")
        return BetaResult(miss, miss, 0)
    _, stock, index = align(dates, close, bench)
    if len(stock) < 2:
        miss = Metric(None, "insufficient_overlap")
        return BetaResult(miss, miss, 0)
    rs = simple_returns(stock)[-window:]
    rb = simple_returns(index)[-window:]
    obs = len(rs)
    if obs < min_obs:
        miss = Metric(None, "insufficient_overlap")
        return BetaResult(miss, miss, obs)
    return BetaResult(*_ols(rs, rb), obs)


def _ols(rs: F64, rb: F64) -> tuple[Metric, Metric]:
    var_b = float(rb.var(ddof=1))
    if var_b <= 0.0:
        miss = Metric(None, "n/m")
        return miss, miss
    cov = float(np.cov(rs, rb, ddof=1)[0, 1])
    beta = Metric.of(cov / var_b)
    sd_s = float(rs.std(ddof=1))
    corr = Metric.of(cov / (sd_s * math.sqrt(var_b))) if sd_s > 0 else Metric(None, "n/m")
    return beta, corr


def rolling_beta(
    dates: list[date], close: F64, bench: dict[date, float], *, window: int = BETA_WINDOW
) -> list[tuple[date, float | None]]:
    """Rolling OLS beta on aligned returns; a value needs a full ``window`` of returns."""
    if not bench:
        return []
    kept, stock, index = align(dates, close, bench)
    if len(stock) < window + 1:
        return []
    rs, rb = simple_returns(stock), simple_returns(index)
    out: list[tuple[date, float | None]] = []
    for t in range(window - 1, len(rs)):
        b, _ = _ols(rs[t - window + 1 : t + 1], rb[t - window + 1 : t + 1])
        out.append((kept[t + 1], b.value))
    return out


def sharpe_like(cagr_3y_pct: Metric, vol_3y_pct: Metric, risk_free: float) -> Metric:
    """``(CAGR_3y - RISK_FREE_RATE) / vol_3y`` as plain ratios; null without 3 years of history
    or when the volatility is 0. ``risk_free`` is a fraction (0.065)."""
    if cagr_3y_pct.value is None:
        return Metric(None, cagr_3y_pct.reason or INSUFFICIENT)
    if vol_3y_pct.value is None:
        return Metric(None, vol_3y_pct.reason or INSUFFICIENT)
    if vol_3y_pct.value <= 0.0:
        return Metric(None, "n/m")
    return Metric.of((cagr_3y_pct.value / 100.0 - risk_free) / (vol_3y_pct.value / 100.0))


def adv_value_cr(close_raw: F64, volume: F64, rows: int = 60) -> Metric:
    """``mean(close * volume)`` over the last ``rows`` rows in INR crore (1 crore = 1e7)."""
    if len(close_raw) < rows:
        return Metric(None, INSUFFICIENT)
    return Metric.of(float((close_raw[-rows:] * volume[-rows:]).mean()) / 1e7)
