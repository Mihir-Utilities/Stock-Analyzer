"""Builds the price-derived part of ``analysis_snapshot.indicators`` (D05a; docs/05 sections 3-4).

Pure: bars in, JSON-safe dict out. Scores (section 6) and derived fundamentals (section 5) are
D05b and are not produced here. Unknown values are ``None`` with an entry in ``null_reasons``.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Any

import numpy as np
from numpy.typing import NDArray

from worker.analytics import analysis_series as ser
from worker.analytics import indicators as ind
from worker.analytics import returns as rt

F64 = NDArray[np.float64]

VERSION = "d05a-1"
MIN_BARS = 60  # docs/04 3.7: stocks with >= 60 valid bars
DEFAULT_RISK_FREE = 0.065  # MASTER_PLAN section 5 RISK_FREE_RATE default

PRICE_BASIS = "adj_close price return (excludes dividends)"


@dataclass(frozen=True)
class Bars:
    """Valid (non-suspect) bars in ascending date order; nothing is forward-filled."""

    dates: list[date]
    close: F64  # as stored (raw or adjusted per src_adjusted)
    adj_close: F64
    high: F64
    low: F64
    volume: F64


def _drop_invalid_prices(bars: Bars) -> tuple[Bars, int]:
    """Drop rows whose close/adj_close/high/low is NaN, inf or <= 0 (never forward-filled).

    Volume is left alone: a NaN volume only nulls the volume-based metrics (OBV, volume z-score,
    ADV) with a reason.
    """
    price_ok = np.ones(len(bars.dates), dtype=bool)
    for a in (bars.close, bars.adj_close, bars.high, bars.low):
        price_ok &= np.isfinite(a) & (a > 0)
    if price_ok.all():
        return bars, 0
    keep = [i for i, ok in enumerate(price_ok) if ok]
    return (
        Bars(
            dates=[bars.dates[i] for i in keep],
            close=bars.close[price_ok],
            adj_close=bars.adj_close[price_ok],
            high=bars.high[price_ok],
            low=bars.low[price_ok],
            volume=bars.volume[price_ok],
        ),
        int(len(price_ok) - len(keep)),
    )


def _scaled(bars: Bars) -> tuple[F64, F64]:
    """High/low scaled by ``k = adj_close / close`` per row (docs/05 1)."""
    k = bars.adj_close / bars.close
    return bars.high * k, bars.low * k


class _Collector:
    """Collects values and the reason for every null one."""

    def __init__(self) -> None:
        self.reasons: dict[str, str] = {}

    def metric(self, key: str, m: rt.Metric) -> float | None:
        if m.value is None:
            self.reasons[key] = m.reason or "n/m"
        return m.value

    def value(self, key: str, v: float, reason: str = "insufficient_history") -> float | None:
        out = ser.num(v)
        if out is None:
            self.reasons[key] = reason
        return out


def build_snapshot(
    bars: Bars,
    bench: dict[date, float] | None = None,
    *,
    risk_free: float = DEFAULT_RISK_FREE,
    warnings: list[str] | None = None,
) -> dict[str, Any] | None:
    """The ``indicators`` jsonb of one stock, or ``None`` below ``MIN_BARS`` valid bars."""
    bars, dropped = _drop_invalid_prices(bars)
    warnings = list(warnings or [])
    if dropped:
        warnings.append(f"dropped {dropped} bar(s) with a non-finite or non-positive price")
    n = len(bars.dates)
    if n < MIN_BARS:
        return None
    bench = bench or {}
    c = bars.adj_close
    hi, lo = _scaled(bars)
    col = _Collector()

    with np.errstate(all="ignore"):  # unknown stays null with a reason, never NaN/inf/raise
        technicals, series = _technicals(bars, hi, lo, col)
        returns = _returns(bars, bench, risk_free, col)
        analysis = _analysis(bars, bench)
    return {
        "version": VERSION,
        "as_of": bars.dates[-1].isoformat(),
        "bars": n,
        "price_basis": PRICE_BASIS,
        "source": "owner-imported prices",
        "last_close": col.value("last_close", float(c[-1]), "n/m"),
        "returns": returns,
        "technicals": technicals,
        "series": series,
        "analysis": analysis,
        "null_reasons": col.reasons,
        "warnings": warnings,
        "units": UNITS,
    }


def _last(a: F64) -> float:
    return float(a[-1])


def _technicals(
    bars: Bars, hi: F64, lo: F64, col: _Collector
) -> tuple[dict[str, Any], dict[str, Any]]:
    c, vol = bars.adj_close, bars.volume
    sma20, sma50, sma200 = ind.sma(c, 20), ind.sma(c, 50), ind.sma(c, 200)
    ema20 = ind.ema(c, 20)
    rsi14 = ind.rsi(c, 14)
    mac = ind.macd(c)
    bb = ind.bollinger(c)
    atr14 = ind.atr(hi, lo, c)
    dmi = ind.adx(hi, lo, c)
    sto = ind.stochastic(hi, lo, c)
    obv = ind.obv(c, vol)
    vz = ind.volume_zscore(vol)

    t: dict[str, Any] = {
        "sma20": col.value("sma20", _last(sma20)),
        "sma50": col.value("sma50", _last(sma50)),
        "sma200": col.value("sma200", _last(sma200)),
        "ema20": col.value("ema20", _last(ema20)),
        "rsi14": col.value("rsi14", _last(rsi14)),
        "macd": col.value("macd", _last(mac.macd)),
        "macd_signal": col.value("macd_signal", _last(mac.signal)),
        "macd_hist": col.value("macd_hist", _last(mac.hist)),
        "bb_upper": col.value("bb_upper", _last(bb.upper)),
        "bb_middle": col.value("bb_middle", _last(bb.middle)),
        "bb_lower": col.value("bb_lower", _last(bb.lower)),
        "bb_pos": col.value("bb_pos", _last(bb.position), "n/m"),
        "atr14": col.value("atr14", _last(atr14)),
        "adx14": col.value("adx14", _last(dmi.adx)),
        "plus_di14": col.value("plus_di14", _last(dmi.plus_di)),
        "minus_di14": col.value("minus_di14", _last(dmi.minus_di)),
        "stoch_k": col.value("stoch_k", _last(sto.k)),
        "stoch_d": col.value("stoch_d", _last(sto.d)),
        "obv": col.value("obv", _last(obv), "n/m"),
        "volume_z20": col.value("volume_z20", _last(vz), "n/m"),
    }
    w52 = ind.week52(hi, lo)
    if w52 is None:
        col.reasons["high_52w"] = col.reasons["low_52w"] = "insufficient_history"
        col.reasons["dist_52w_high_pct"] = "insufficient_history"
        t.update(high_52w=None, low_52w=None, dist_52w_high_pct=None)
    else:
        t.update(
            high_52w=col.value("high_52w", w52.high, "n/m"),
            low_52w=col.value("low_52w", w52.low, "n/m"),
            dist_52w_high_pct=col.value(
                "dist_52w_high_pct", (float(c[-1]) / w52.high - 1) * 100, "n/m"
            ),
        )
    sup, res = ind.support_resistance(hi, lo, float(c[-1]))
    t["support"] = [
        {"price": s.price, "touches": s.touches} for s in sup if ser.num(s.price) is not None
    ]
    t["resistance"] = [
        {"price": r.price, "touches": r.touches} for r in res if ser.num(r.price) is not None
    ]
    cross = ind.crosses(sma50, sma200)
    if cross is None:
        col.reasons["golden_cross"] = col.reasons["death_cross"] = "insufficient_history"
        t.update(golden_cross=None, death_cross=None, last_cross=None)
    else:
        t.update(golden_cross=cross.golden, death_cross=cross.death, last_cross=cross.last_cross)

    last_n = ser.SERIES_ROWS
    d = bars.dates[-last_n:]

    def p(a: F64) -> list[float | None]:
        return ser.column(a[-last_n:])

    series: dict[str, Any] = {
        "format": "columnar",  # one shared `dates` array; every other array aligns to it
        "dates": [x.isoformat() for x in d],
        "sma20": p(sma20),
        "sma50": p(sma50),
        "sma200": p(sma200),
        "ema20": p(ema20),
        "rsi14": p(rsi14),
        "macd": {"macd": p(mac.macd), "signal": p(mac.signal), "hist": p(mac.hist)},
        "bollinger": {"upper": p(bb.upper), "middle": p(bb.middle), "lower": p(bb.lower)},
        "atr14": p(atr14),
        "adx14": {"adx": p(dmi.adx), "plus_di": p(dmi.plus_di), "minus_di": p(dmi.minus_di)},
        "stochastic": {"k": p(sto.k), "d": p(sto.d)},
        "obv": p(obv),
    }
    return t, series


def _returns(
    bars: Bars, bench: dict[date, float], risk_free: float, col: _Collector
) -> dict[str, Any]:
    c = bars.adj_close
    trading = {
        f"ret_{k}": col.metric(f"ret_{k}", rt.ret_trading(c, n))
        for k, n in rt.TRADING_WINDOWS.items()
    }
    calendar: dict[str, Any] = {}
    cal: dict[str, rt.CalendarReturn] = {}
    for k, months in rt.CALENDAR_MONTHS.items():
        cal[k] = rt.ret_calendar(bars.dates, c, months)
        calendar[f"ret_{k}"] = col.metric(f"cal_ret_{k}", cal[k].ret_pct)
        if months > 12:
            calendar[f"cagr_{k}"] = col.metric(f"cagr_{k}", cal[k].cagr_pct)
    risk: dict[str, Any] = {}
    for n in (21, 63, 252):
        risk[f"vol_{n}"] = col.metric(f"vol_{n}", rt.volatility(c, n))
    # vol_3y: every daily log return inside the calendar 3Y window used for CAGR_3y (D05a-A4).
    start = cal["3y"].start_date
    if start is None:
        vol3 = rt.Metric(None, rt.INSUFFICIENT)
    else:
        first = bars.dates.index(start)
        vol3 = rt.volatility_window(c[first:])
    risk["vol_3y"] = col.metric("vol_3y", vol3)
    for key, rows in (
        ("maxdd_1y", 252),
        ("maxdd_3y", 756),
        ("maxdd_5y", 1260),
        ("maxdd_max", None),
    ):
        risk[key] = col.metric(key, rt.max_drawdown(c, rows))
    bc = rt.beta_corr(bars.dates, c, bench)
    risk["beta_252"] = col.metric("beta_252", bc.beta)
    risk["corr_252"] = col.metric("corr_252", bc.correlation)
    risk["beta_observations"] = bc.observations
    risk["sharpe_3y"] = col.metric("sharpe_3y", rt.sharpe_like(cal["3y"].cagr_pct, vol3, risk_free))
    risk["adv_value_60_cr"] = col.metric(
        "adv_value_60_cr", rt.adv_value_cr(bars.close, bars.volume)
    )
    risk["risk_free_rate"] = risk_free
    return {"trading": trading, "calendar": calendar, "risk": risk}


def _analysis(bars: Bars, bench: dict[date, float]) -> dict[str, Any]:
    c, d = bars.adj_close, bars.dates
    window = ser.SERIES_ROWS
    beta_by_date = dict(rt.rolling_beta(d, c, bench))
    return {
        "format": "columnar",  # drawdown/rolling_* align to `series.dates` (the last 750 rows)
        "drawdown": ser.drawdown_column(c),
        "rolling_vol_21": ser.column(ser.rolling_vol(c, 21)[-window:]),
        "rolling_vol_63": ser.column(ser.rolling_vol(c, 63)[-window:]),
        "rolling_beta_252": [
            None
            if beta_by_date.get(day) is None
            else round(float(beta_by_date[day] or 0), ser.DIGITS)
            for day in d[-window:]
        ],
        "return_histogram": ser.histogram(c),
        "month_year": ser.month_year(d, c),
        "calendar": ser.calendar_days(d, c),
    }


UNITS: dict[str, str] = {
    "ret_*": "percent",
    "cagr_*": "percent",
    "vol_*": "percent (annualised)",
    "maxdd_*": "percent",
    "dist_52w_high_pct": "percent",
    "beta_252": "ratio",
    "corr_252": "ratio",
    "sharpe_3y": "ratio (return per unit of risk, simple)",
    "adv_value_60_cr": "INR_CR",
    "rsi14": "0-100",
    "stoch_*": "0-100",
    "adx14": "0-100",
    "volume_z20": "std devs",
    "sma*": "INR (adjusted)",
    "ema*": "INR (adjusted)",
}
