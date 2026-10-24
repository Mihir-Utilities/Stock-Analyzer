"""docs/05 section 9.1-9.3 golden tests with hand-computed values; MF-04, MF-07, MF-08."""

from __future__ import annotations

import math
from datetime import date, timedelta

import pytest

from worker.analytics.mf import compute_mf_metrics, nav_jumps, nav_on_or_before, subtract_months


def test_subtract_months_clamps_day() -> None:
    assert subtract_months(date(2026, 3, 31), 1) == date(2026, 2, 28)
    assert subtract_months(date(2024, 3, 31), 1) == date(2024, 2, 29)
    assert subtract_months(date(2026, 1, 15), 3) == date(2025, 10, 15)
    assert subtract_months(date(2026, 10, 9), 60) == date(2021, 10, 9)


def test_nav_on_or_before_point_in_time() -> None:
    d = [date(2026, 1, 1), date(2026, 1, 5), date(2026, 1, 9)]
    assert nav_on_or_before(d, date(2025, 12, 31)) is None
    assert nav_on_or_before(d, date(2026, 1, 4)) == 0
    assert nav_on_or_before(d, date(2026, 1, 5)) == 1
    assert nav_on_or_before(d, date(2027, 1, 1)) == 2


def test_returns_absolute_and_cagr_golden() -> None:
    dates = [date(2023, 10, 9), date(2025, 10, 9), date(2026, 4, 9), date(2026, 10, 9)]
    navs = [100.0, 110.0, 115.5, 121.0]
    m = compute_mf_metrics(dates, navs)
    assert m is not None
    r = m["returns"]
    assert r["6m"] == pytest.approx(121 / 115.5 * 100 - 100, abs=1e-3)  # 4.7619
    assert r["1y"] == pytest.approx(10.0, abs=1e-3)  # 110 -> 121 over 365 days
    assert r["3y"] == pytest.approx((1.21 ** (365 / 1096) - 1) * 100, abs=1e-3)  # 6.55%
    assert r["3y"] == pytest.approx(6.554, abs=0.01)
    assert r["1m"] == pytest.approx(4.7619, abs=1e-3)  # no NAV in between: start is 2026-04-09
    assert r["since"] == r["3y"]  # first NAV is exactly 3Y back (>= 1Y -> CAGR)
    assert r["ytd"] == pytest.approx(10.0, abs=1e-3)  # NAV on/before 2025-12-31 is 110 (2025-10-09)
    assert m["end_date"] == "2026-10-09" and m["end_nav"] == 121.0


def test_mf04_window_longer_than_history_is_null_with_reason() -> None:
    dates = [date(2026, 1, 1), date(2026, 10, 9)]
    m = compute_mf_metrics(dates, [100.0, 105.0])
    assert m is not None
    for k in ("1y", "3y", "5y", "ytd"):
        assert m["returns"][k] is None and m["return_reasons"][k] == "insufficient_history"
    assert m["returns"]["6m"] is not None
    assert m["volatility"] is None and m["volatility_reason"] == "insufficient_history"
    assert m["sharpe_like"] is None and m["max_drawdown"] is None and m["rolling_1y"] is None
    assert m["returns"]["since"] == pytest.approx(5.0, abs=1e-3)  # < 1Y: absolute


def test_empty_and_single_series() -> None:
    assert compute_mf_metrics([], []) is None
    one = compute_mf_metrics([date(2026, 10, 9)], [10.0])
    assert one is not None and one["returns"]["since"] is None
    assert all(v is None for v in one["returns"].values())


def _daily(n: int, f: callable) -> tuple[list[date], list[float]]:  # type: ignore[valid-type]
    start = date(2025, 1, 1)
    return [start + timedelta(days=i) for i in range(n)], [f(i) for i in range(n)]


def test_volatility_and_sharpe_golden() -> None:
    # 3.2 years of daily NAV alternating x1.01 / x(1/1.01): log returns are exactly +-ln(1.01).
    r = math.log(1.01)
    n = 1200
    dates, navs = _daily(n, lambda i: 100.0 * math.exp(r * (i % 2)))
    m = compute_mf_metrics(dates, navs, risk_free=0.0)
    assert m is not None
    k = n - 1  # number of returns; mean = r/k or 0, so std ~ r * sqrt(k/(k-1))
    expected = r * math.sqrt(k / (k - 1)) * math.sqrt(252) * 100
    assert m["volatility"] == pytest.approx(expected, rel=2e-3)
    assert m["volatility_years"] == pytest.approx(3.0, abs=0.1)  # 3Y window, not all 3.28Y
    assert m["max_drawdown"] == pytest.approx((1 / 1.01 - 1) * 100, abs=1e-3)
    # NAV is flat over 3Y so CAGR_3y ~ 0 and sharpe ~ 0 with rf 0
    assert m["sharpe_like"] == pytest.approx(0.0, abs=0.01)
    rf = compute_mf_metrics(dates, navs, risk_free=0.065)
    assert rf is not None and rf["sharpe_like"] == pytest.approx(
        -0.065 / (expected / 100), abs=0.01
    )


def test_sharpe_null_under_three_years() -> None:
    dates, navs = _daily(500, lambda i: 100.0 + (i % 7) * 0.5 + i * 0.01)
    m = compute_mf_metrics(dates, navs)
    assert m is not None and m["volatility"] is not None
    assert m["sharpe_like"] is None and m["sharpe_reason"] == "insufficient_history"
    assert m["volatility_years"] == pytest.approx(499 / 365.25, abs=0.01)  # full history >= 1Y


# MF-84
def test_mf07_weekly_nav_scheme_volatility_null() -> None:
    start = date(2023, 1, 6)
    dates = [start + timedelta(days=7 * i) for i in range(120)]  # about 2.3 years, weekly
    navs = [100 + i * 0.3 + (i % 3) for i in range(120)]
    m = compute_mf_metrics(dates, navs)
    assert m is not None
    assert m["volatility"] is None and m["volatility_reason"] == "weekly_nav"
    assert m["sharpe_like"] is None and m["sharpe_reason"] == "weekly_nav"
    assert m["max_drawdown"] is not None  # drawdown does not depend on NAV frequency
    # daily funds with weekend gaps (median 1 day) are not weekly
    dates2, navs2 = _daily(600, lambda i: 100 + (i % 5))
    m2 = compute_mf_metrics(dates2, navs2)
    assert m2 is not None and m2["volatility"] is not None


def test_max_drawdown_golden() -> None:
    dates = [
        date(2025, 1, 1),
        date(2025, 6, 1),
        date(2025, 9, 1),
        date(2025, 12, 1),
        date(2026, 2, 1),
    ]
    m = compute_mf_metrics(dates, [100.0, 120.0, 60.0, 90.0, 95.0])
    assert m is not None and m["max_drawdown"] == pytest.approx(-50.0)


def test_rolling_1y_golden() -> None:
    # NAV doubles over each year on a daily grid: every window CAGR is about +100%.
    dates, navs = _daily(800, lambda i: 100.0 * 2 ** (i / 365))
    m = compute_mf_metrics(dates, navs)
    assert m is not None and m["rolling_1y"] is not None
    roll = m["rolling_1y"]
    assert roll["count"] == 800 - 365
    assert roll["min"] == pytest.approx(100.0, abs=0.01) and roll["max"] == pytest.approx(
        100.0, abs=0.01
    )
    assert roll["pct_positive"] == 100.0
    falling = compute_mf_metrics(*_daily(800, lambda i: 100.0 * 0.5 ** (i / 365)))
    assert falling is not None and falling["rolling_1y"]["pct_positive"] == 0.0


def test_mf08_jump_over_25_percent_flagged_and_kept() -> None:
    dates = [date(2026, 1, 1), date(2026, 1, 2), date(2026, 1, 3), date(2026, 1, 4)]
    navs = [100.0, 126.0, 126.0, 94.0]  # +26% and -25.4%
    jumps = nav_jumps(dates, navs)
    assert [(j["date"], j["change_pct"]) for j in jumps] == [
        ("2026-01-02", 26.0),
        ("2026-01-04", -25.4),
    ]
    assert nav_jumps(dates, [100.0, 125.0, 125.0, 125.0]) == []  # exactly 25% is not > 25%
    m = compute_mf_metrics(dates, navs)
    assert m is not None and len(m["nav_jumps"]) == 2 and m["end_nav"] == 94.0


# MF-86
def test_no_nan_or_inf_in_output() -> None:
    dates, navs = _daily(1200, lambda i: 100.0)  # flat NAV: zero volatility
    m = compute_mf_metrics(dates, navs)
    assert m is not None
    assert m["volatility"] == 0.0 and m["sharpe_like"] is None and m["sharpe_reason"] == "n/m"

    def walk(x: object) -> None:
        if isinstance(x, dict):
            for v in x.values():
                walk(v)
        elif isinstance(x, float):
            assert math.isfinite(x)

    walk(m)
