"""``build_snapshot`` (D05a): IND-92, RET-89 and the shape the indicators API relies on."""

from __future__ import annotations

import json
import math
from datetime import date, timedelta
from typing import Any

import numpy as np

from worker.analytics import indicators as ind
from worker.analytics.snapshot import MIN_BARS, Bars, build_snapshot


def make_bars(n: int, *, k: float = 1.0, start: date = date(2024, 1, 1)) -> Bars:
    """Deterministic bars; ``k`` = adj_close / close (a confirmed split makes it != 1)."""
    rng = np.random.default_rng(42)
    close = 100 * np.cumprod(1 + rng.normal(0.0003, 0.01, n))
    dates: list[date] = []
    d = start
    while len(dates) < n:
        if d.weekday() < 5:
            dates.append(d)
        d += timedelta(days=1)
    return Bars(
        dates=dates,
        close=close,
        adj_close=close * k,
        high=close * 1.01,
        low=close * 0.99,
        volume=rng.integers(100_000, 900_000, n).astype(np.float64),
    )


def walk(o: Any) -> list[Any]:
    if isinstance(o, dict):
        return [x for v in o.values() for x in walk(v)]
    if isinstance(o, list):
        return [x for v in o for x in walk(v)]
    return [o]


def test_ind92_below_sixty_valid_bars_has_no_snapshot() -> None:
    assert build_snapshot(make_bars(MIN_BARS - 1)) is None
    assert build_snapshot(make_bars(MIN_BARS)) is not None


def test_ret89_output_is_json_safe_with_reasons_for_every_null() -> None:
    snap = build_snapshot(make_bars(120))
    assert snap is not None
    text = json.dumps(snap, allow_nan=False)  # raises on NaN / Infinity
    assert "NaN" not in text and "Infinity" not in text
    t, reasons = snap["technicals"], snap["null_reasons"]
    # 120 bars: no SMA200, no 52w range, no 1y return, no beta (no benchmark)
    for key in ("sma200", "high_52w", "dist_52w_high_pct", "golden_cross"):
        assert t[key] is None and reasons[key] == "insufficient_history"
    assert snap["returns"]["trading"]["ret_1y"] is None
    assert reasons["ret_1y"] == "insufficient_history"
    assert snap["returns"]["risk"]["beta_252"] is None
    assert reasons["beta_252"] == "no_benchmark"
    # every scalar that is null has a reason (never a bare null)
    flat = {
        **t,
        **snap["returns"]["trading"],
        **snap["returns"]["calendar"],
        **snap["returns"]["risk"],
    }
    for key, value in flat.items():
        if (
            value is None and key != "last_cross"
        ):  # None = no recent cross (or golden_cross' reason)
            assert key in reasons or f"cal_{key}" in reasons, key


def test_snapshot_shape_units_and_percent_numbers() -> None:
    bars = make_bars(300)
    snap = build_snapshot(bars, warnings=["UNCONFIRMED_ACTION"])
    assert snap is not None
    assert snap["as_of"] == bars.dates[-1].isoformat()
    assert snap["warnings"] == ["UNCONFIRMED_ACTION"]
    assert snap["price_basis"] == "adj_close price return (excludes dividends)"
    c = bars.adj_close
    # percent numbers, not fractions (docs/05 1)
    assert snap["returns"]["trading"]["ret_1m"] == (c[-1] / c[-22] - 1) * 100
    assert 0.0 <= snap["technicals"]["rsi14"] <= 100.0
    assert snap["returns"]["risk"]["maxdd_max"] <= 0.0
    assert snap["returns"]["risk"]["adv_value_60_cr"] > 0
    assert set(snap["returns"]) == {"trading", "calendar", "risk"}


def test_series_are_capped_at_750_rows_with_null_warmup() -> None:
    snap = build_snapshot(make_bars(900))
    assert snap is not None
    s = snap["series"]
    assert s["format"] == "columnar" and len(s["dates"]) == 750
    assert len(s["sma50"]) == 750 and len(s["macd"]["hist"]) == 750
    assert len(snap["analysis"]["drawdown"]) == len(snap["analysis"]["rolling_vol_63"]) == 750
    short = build_snapshot(make_bars(100))
    assert short is not None
    sma50 = short["series"]["sma50"]
    assert len(short["series"]["dates"]) == 100
    assert sma50[:49] == [None] * 49 and sma50[49] is not None
    assert all(v is None for v in short["series"]["sma200"])  # arrays stay, values are null


def test_snapshot_stays_small_enough_for_the_free_tier() -> None:
    # latest snapshot of a stock with 4 years of bars + benchmark: about 170 KB of JSON before
    # Postgres compression (columnar series, 4 decimals); pairs of [date, value] were 600 KB.
    bars = make_bars(1000)
    idx = 20000 * np.cumprod(1 + np.random.default_rng(1).normal(0, 0.01, 1000))
    snap = build_snapshot(bars, {d: float(v) for d, v in zip(bars.dates, idx, strict=True)})
    assert snap is not None
    assert len(json.dumps(snap)) < 200_000


def test_ind89_52w_high_low_are_scaled_by_adj_close_over_close() -> None:
    # a confirmed 1:2 split => adj_close = close/2 for history; H/L scale by the same k
    bars = make_bars(300, k=0.5)
    snap = build_snapshot(bars)
    assert snap is not None
    expected = float(np.max(bars.high[-252:] * 0.5))
    assert snap["technicals"]["high_52w"] == expected
    # the distance is a percent number measured on adjusted closes
    assert snap["technicals"]["dist_52w_high_pct"] == (bars.adj_close[-1] / expected - 1) * 100


def test_technicals_agree_with_the_indicator_library() -> None:
    bars = make_bars(260)
    snap = build_snapshot(bars)
    assert snap is not None
    t = snap["technicals"]
    assert t["sma50"] == float(ind.sma(bars.adj_close, 50)[-1])
    assert t["rsi14"] == float(ind.rsi(bars.adj_close)[-1])
    assert t["obv"] == float(ind.obv(bars.adj_close, bars.volume)[-1])
    assert all(math.isfinite(v) for v in walk(t) if isinstance(v, float))
    assert t["golden_cross"] in (True, False) and t["death_cross"] in (True, False)


def test_benchmark_gives_beta_and_rolling_beta() -> None:
    bars = make_bars(400)
    rng = np.random.default_rng(9)
    idx = 20000 * np.cumprod(1 + rng.normal(0.0004, 0.009, 400))
    bench = {d: float(v) for d, v in zip(bars.dates, idx, strict=True)}
    snap = build_snapshot(bars, bench)
    assert snap is not None
    risk = snap["returns"]["risk"]
    assert risk["beta_252"] is not None and risk["corr_252"] is not None
    assert risk["beta_observations"] == 252
    beta = snap["analysis"]["rolling_beta_252"]
    assert len(beta) == 400 and beta[:252] == [None] * 252  # aligned to the 400 series dates
    assert all(v is not None for v in beta[252:])
    assert beta[-1] == round(risk["beta_252"], 4)
