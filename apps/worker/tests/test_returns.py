"""Known-answer tests for docs/05 section 4 (RET-81 .. RET-88) and the analysis-tab series."""

from __future__ import annotations

import math
from datetime import date, timedelta

import numpy as np
import pytest

from worker.analytics import analysis_series as ser
from worker.analytics import returns as rt


def arr(*v: float) -> np.ndarray:
    return np.array(v, dtype=np.float64)


def daily(start: date, n: int) -> list[date]:
    return [start + timedelta(days=i) for i in range(n)]


# RET-81 -------------------------------------------------------------------------------------
def test_ret81_trading_row_return_percent_and_null_below_n_plus_one_rows() -> None:
    c = arr(100, 110, 121)
    assert rt.ret_trading(c, 2).value == pytest.approx(21.0)  # 121/100 - 1, a percent number
    assert rt.ret_trading(c, 1).value == pytest.approx(10.0)
    m = rt.ret_trading(c, 3)  # needs 4 rows
    assert m.value is None and m.reason == "insufficient_history"


# RET-82 -------------------------------------------------------------------------------------
def test_ret82_month_subtraction_clamps_to_month_end() -> None:
    assert rt.subtract_months(date(2026, 3, 31), 1) == date(2026, 2, 28)
    assert rt.subtract_months(date(2024, 3, 31), 1) == date(2024, 2, 29)
    assert rt.subtract_months(date(2024, 2, 29), 12) == date(2023, 2, 28)
    assert rt.subtract_months(date(2026, 1, 15), 3) == date(2025, 10, 15)


def test_ret82_calendar_return_uses_last_bar_on_or_before_target() -> None:
    # end 2026-06-30 (Tue); 1M target 2026-05-30 is a Saturday -> base is the Friday 05-29 bar
    dates = [date(2026, 5, 28), date(2026, 5, 29), date(2026, 6, 1), date(2026, 6, 30)]
    r = rt.ret_calendar(dates, arr(50, 100, 120, 150), 1)
    assert r.start_date == date(2026, 5, 29)
    assert r.ret_pct.value == pytest.approx(50.0)  # 150/100 - 1


def test_ret82_calendar_return_null_when_first_bar_is_after_target() -> None:
    dates = [date(2026, 6, 10), date(2026, 6, 30)]
    r = rt.ret_calendar(dates, arr(100, 110), 1)  # needs a bar on/before 2026-05-30
    assert r.ret_pct.value is None and r.ret_pct.reason == "insufficient_history"
    assert rt.ret_calendar([], arr(), 1).ret_pct.value is None


# RET-83 -------------------------------------------------------------------------------------
def test_ret83_cagr_only_beyond_one_year_and_uses_365_25_over_days() -> None:
    dates = [date(2023, 6, 30), date(2026, 6, 30)]  # 1096 days (one leap day)
    r = rt.ret_calendar(dates, arr(100, 200), 36)
    assert r.ret_pct.value == pytest.approx(100.0)
    assert r.cagr_pct.value == pytest.approx((2 ** (365.25 / 1096) - 1) * 100)
    assert 25.9 < (r.cagr_pct.value or 0) < 26.0  # hand check: 2^0.33326 = 1.2598
    one_year = rt.ret_calendar(dates, arr(100, 200), 12)
    assert one_year.cagr_pct.value is None and one_year.cagr_pct.reason == "not_applicable"
    short = rt.ret_calendar([date(2025, 1, 1), date(2026, 6, 30)], arr(100, 200), 36)
    assert short.cagr_pct.value is None and short.cagr_pct.reason == "insufficient_history"


# RET-84 -------------------------------------------------------------------------------------
def test_ret84_volatility_known_answer_ddof1_annualised() -> None:
    # log returns are +a and -a (a = ln 1.1): sample std = a*sqrt(2); vol = that * sqrt(252) * 100
    a = math.log(1.1)
    expected = a * math.sqrt(2) * math.sqrt(252) * 100
    assert rt.volatility(arr(100, 110, 100), 2).value == pytest.approx(expected)
    assert rt.volatility_window(arr(100, 110, 100)).value == pytest.approx(expected)


def test_ret84_volatility_needs_n_plus_one_rows() -> None:
    m = rt.volatility(arr(100, 110, 100), 3)
    assert m.value is None and m.reason == "insufficient_history"
    assert rt.volatility(arr(*([100.0] * 30)), 21).value == 0.0  # a real zero: flat prices


# RET-85 -------------------------------------------------------------------------------------
def test_ret85_max_drawdown_windows() -> None:
    c = arr(100, 120, 90, 130, 65)
    assert rt.max_drawdown(c, None).value == pytest.approx(-50.0)  # 65/130 - 1
    assert rt.max_drawdown(c, 3).value == pytest.approx(-50.0)
    c2 = arr(100, 120, 90, 130, 100)
    # the base of a window is its own running maximum, not an earlier higher/lower close
    assert rt.max_drawdown(c2, 2).value == pytest.approx((100 / 130 - 1) * 100)
    assert rt.max_drawdown(c2, 3).value == pytest.approx((100 / 130 - 1) * 100)
    assert rt.max_drawdown(c2, 5).value == pytest.approx(-25.0)  # 90/120 - 1 beats 100/130 - 1
    m = rt.max_drawdown(c, 10)
    assert m.value is None and m.reason == "insufficient_history"
    assert rt.max_drawdown(arr(1, 2, 3), None).value == 0.0  # rising: genuinely no drawdown


# RET-86 -------------------------------------------------------------------------------------
def _bench(n: int) -> tuple[list[date], dict[date, float], np.ndarray]:
    rng = np.random.default_rng(3)
    r = rng.normal(0.0004, 0.01, n)
    idx = 20000 * np.cumprod(1 + np.concatenate([[0.0], r[1:]]))
    dates = [date(2025, 1, 1) + timedelta(days=i) for i in range(n)]
    return dates, dict(zip(dates, (float(v) for v in idx), strict=True)), idx


def test_ret86_beta_and_correlation_known_answer() -> None:
    dates, bench, idx = _bench(300)
    rb = idx[1:] / idx[:-1] - 1
    stock = 50 * np.cumprod(np.concatenate([[1.0], 1 + 2 * rb]))  # daily return exactly 2x market
    res = rt.beta_corr(dates, stock, bench)
    assert res.beta.value == pytest.approx(2.0, rel=1e-9)
    assert res.correlation.value == pytest.approx(1.0, rel=1e-9)
    assert res.observations == 252  # last 252 aligned returns


def test_ret86_inner_join_ignores_stock_dates_missing_from_the_benchmark() -> None:
    dates, bench, idx = _bench(200)
    rng = np.random.default_rng(11)
    stock = 50 * np.cumprod(1 + rng.normal(0, 0.012, 200))
    gap = dates[100]
    del bench[gap]  # the benchmark has no value on this date; the stock does
    res = rt.beta_corr(dates, stock, bench)
    keep = [i for i, d in enumerate(dates) if d != gap]
    rs = stock[keep][1:] / stock[keep][:-1] - 1  # returns on the aligned (joined) series
    rb = idx[keep][1:] / idx[keep][:-1] - 1
    expected = np.cov(rs, rb, ddof=1)[0, 1] / np.var(rb, ddof=1)
    assert res.beta.value == pytest.approx(expected, rel=1e-9)
    assert res.observations == 198  # 199 aligned closes -> 198 returns


def test_ret86_beta_null_reasons() -> None:
    dates, bench, idx = _bench(300)
    stock = idx * 0.01
    none = rt.beta_corr(dates, stock, {})
    assert none.beta.value is None and none.beta.reason == "no_benchmark"
    few = rt.beta_corr(dates[:100], stock[:100], bench)  # 99 aligned returns < 120
    assert few.beta.value is None and few.beta.reason == "insufficient_overlap"
    assert few.correlation.value is None
    flat_bench = {d: 100.0 for d in dates}
    flat = rt.beta_corr(dates, stock, flat_bench)
    assert flat.beta.value is None and flat.beta.reason == "n/m"  # zero benchmark variance


def test_ret86_rolling_beta_matches_point_beta_on_the_last_window() -> None:
    dates, bench, idx = _bench(400)
    rb = idx[1:] / idx[:-1] - 1
    stock = 50 * np.cumprod(np.concatenate([[1.0], 1 + 0.8 * rb]))
    rolled = rt.rolling_beta(dates, stock, bench)
    assert len(rolled) == 400 - 1 - 252 + 1
    assert rolled[-1][0] == dates[-1]
    assert rolled[-1][1] == pytest.approx(0.8, rel=1e-9)
    assert rt.rolling_beta(dates[:200], stock[:200], bench) == []


# RET-87 -------------------------------------------------------------------------------------
def test_ret87_sharpe_like_hand_value_and_nulls() -> None:
    # (0.20 - 0.06) / 0.10 = 1.4 ; inputs are percent numbers, the rate is a fraction
    assert rt.sharpe_like(rt.Metric(20.0), rt.Metric(10.0), 0.06).value == pytest.approx(1.4)
    short = rt.sharpe_like(rt.Metric(None, "insufficient_history"), rt.Metric(10.0), 0.06)
    assert short.value is None and short.reason == "insufficient_history"
    zero = rt.sharpe_like(rt.Metric(20.0), rt.Metric(0.0), 0.06)
    assert zero.value is None and zero.reason == "n/m"
    assert rt.sharpe_like(rt.Metric(20.0), rt.Metric(None, "x"), 0.06).reason == "x"


# RET-88 -------------------------------------------------------------------------------------
def test_ret88_adv_value_in_crore_over_60_rows() -> None:
    close, vol = np.full(80, 100.0), np.full(80, 1_000_000.0)
    assert rt.adv_value_cr(close, vol).value == pytest.approx(10.0)  # 1e8 INR = 10 crore
    # only the last 60 rows count
    vol2 = vol.copy()
    vol2[:20] = 0.0
    assert rt.adv_value_cr(close, vol2).value == pytest.approx(10.0)
    m = rt.adv_value_cr(close[:59], vol[:59])
    assert m.value is None and m.reason == "insufficient_history"


def test_metric_of_never_returns_nan_or_inf() -> None:
    assert rt.Metric.of(math.nan).value is None
    assert rt.Metric.of(math.inf).reason == "n/m"
    assert rt.Metric.of(0.0).value == 0.0


# analysis-tab series ---------------------------------------------------------------------------
def test_drawdown_series_percent() -> None:
    np.testing.assert_allclose(rt.drawdown_series(arr(100, 120, 90, 130, 65)), [0, 0, -25, 0, -50])


def test_rolling_vol_warmup_is_null_and_matches_point_value() -> None:
    c = 100 + np.cumsum(np.random.default_rng(1).normal(0, 1, 60))
    out = ser.rolling_vol(c, 21)
    assert np.isnan(out[:21]).all()
    assert out[-1] == pytest.approx(rt.volatility(c, 21).value)


def test_month_year_heatmap_uses_month_end_and_drops_first_partial_month() -> None:
    dates = [date(2026, 1, 15), date(2026, 1, 30), date(2026, 2, 27), date(2026, 3, 31)]
    cells = ser.month_year(dates, arr(90, 100, 110, 99))
    assert cells == [[2026, 2, pytest.approx(10.0)], [2026, 3, pytest.approx(-10.0)]]


def test_calendar_heatmap_last_year_only_and_histogram_counts() -> None:
    dates = daily(date(2024, 1, 1), 500)
    c = 100 * np.cumprod(1 + np.random.default_rng(5).normal(0, 0.01, 500))
    cal = ser.calendar_days(dates, c)
    assert len(cal["dates"]) == len(cal["values"]) > 200
    assert all((dates[-1] - date.fromisoformat(d)).days < 365 for d in cal["dates"])
    h = ser.histogram(c)
    assert h is not None and sum(h["counts"]) == h["n"] == 499
    assert len(h["edges"]) == len(h["counts"]) + 1
    assert ser.histogram(c[:10]) is None


def test_column_never_emits_nan_inf_and_rounds() -> None:
    assert ser.column(arr(math.nan, 1.0, math.inf, 1.23456789)) == [None, 1.0, None, 1.2346]
