"""INV-P, INV-D, INV-H, INV-E, INV-V, INV-L, INV-R and INV-A06 rows (docs/07; golden vectors
VP1, VD1, VH1, VE1, VV1, VL1, VR1 of docs/05 12.3-12.9). Windows are arguments, as the spec says."""

from __future__ import annotations

import math
from dataclasses import replace
from datetime import date, timedelta

import numpy as np
import pytest

from worker.analytics import investing as inv
from worker.analytics import sip
from worker.analytics.inv_common import InvSettings, pctile

S = InvSettings()


def days(n: int, start: date = date(2024, 1, 1)) -> list[date]:
    return [start + timedelta(days=i) for i in range(n)]


def arr(*v: float) -> np.ndarray:
    return np.array(v, dtype=np.float64)


# ---------------------------------------------------------------- INV-P
def test_inv_p01_vp1_price_position() -> None:
    c = arr(20, 16, 10, 12, 11, 15, 14)
    p = inv.position(days(7), c, w=5, sma_window=3, min_all_rows=7)
    assert p["range_pos_52w_pct"] == pytest.approx(80.0) and p["range_band"] == "upper"
    assert p["high_52w_close"] == 15.0 and p["low_52w_close"] == 10.0
    assert p["dist_high_52w_pct"] == pytest.approx(-6.6667, abs=1e-4)
    assert p["pctile_52w"] == pytest.approx(70.0)
    assert p["pctile_all"] == pytest.approx(50.0) and p["pctile_all_n"] == 7
    assert p["dist_high_all_pct"] == pytest.approx(-30.0)
    assert p["high_all_date"] == "2024-01-01" and p["history_first_date"] == "2024-01-01"
    assert p["sma200"] == pytest.approx(13.3333, abs=1e-4)
    assert p["ext_sma200_pct"] == pytest.approx(5.0, abs=1e-3)


def test_inv_p02_exact_thirds() -> None:
    third = inv.position(days(3), arr(1, 4, 2), w=3, sma_window=3, min_all_rows=99)
    assert third["range_pos_52w_pct"] == pytest.approx(100 / 3, abs=1e-4)
    assert third["range_band"] == "middle"  # exactly 100/3 is middle
    two_thirds = inv.position(days(3), arr(1, 4, 3), w=3, sma_window=3, min_all_rows=99)
    assert two_thirds["range_band"] == "upper"  # exactly 200/3 is upper
    just_under = inv.position(days(3), arr(1, 4, 1.99), w=3, sma_window=3, min_all_rows=99)
    assert just_under["range_band"] == "lower"


def test_inv_p03_flat_range_and_short_history() -> None:
    flat = inv.position(days(5), arr(5, 5, 5, 5, 5), w=5, sma_window=3, min_all_rows=99)
    assert flat["range_pos_52w_pct"] is None and flat["range_pos_52w_reason"] == "flat_range"
    assert flat["range_band"] is None and flat["pctile_52w"] == 50.0
    short = inv.position(days(100), np.linspace(10, 20, 100))
    assert short["range_pos_52w_pct"] is None
    assert short["range_pos_52w_reason"] == "insufficient_history"
    assert short["pctile_52w"] is None and short["pctile_all"] is None
    assert short["pctile_all_reason"] == "insufficient_history"
    assert short["ext_sma200_pct"] is None and short["ext_sma200_reason"] == "insufficient_history"
    assert short["dist_high_all_pct"] is not None


def test_inv_p04_percentile_ties_are_mid_rank() -> None:
    assert pctile(7.0, arr(7, 7, 7, 7)) == 50.0
    p = inv.position(days(6), arr(3, 3, 3, 3, 3, 3), w=6, sma_window=3, min_all_rows=6)
    assert p["pctile_52w"] == 50.0 and p["pctile_all"] == 50.0


# ---------------------------------------------------------------- INV-D
VD1 = arr(100, 90, 80, 85, 100, 95, 100, 110, 99, 88, 99, 110, 105)


def vd1(min_episodes: int = 2) -> dict:  # type: ignore[type-arg]
    return inv.drawdown_profile(days(13), VD1, replace(S, min_episodes=min_episodes))


def test_inv_d01_vd1_profile() -> None:
    p = vd1()
    assert p["current_dd_pct"] == pytest.approx(-4.5455, abs=1e-4)
    assert p["days_since_high"] == 1
    assert p["underwater_rows"] == 8
    assert p["time_under_water_pct"] == pytest.approx(61.5385, abs=1e-4)
    assert p["avg_underwater_depth_pct"] == pytest.approx(-11.8182, abs=1e-4)
    assert p["episodes_total"] == 4


def test_inv_d02_max_drawdown_with_dates_tie_is_the_earliest() -> None:
    m = vd1()["max_dd"]
    assert m == {
        "depth_pct": -20.0,
        "peak_date": "2024-01-01",
        "trough_date": "2024-01-03",
        "recovery_date": "2024-01-05",
        "recovered": True,
        "reason": None,
    }


def test_inv_d03_recovery_from_10_and_20_percent_falls() -> None:
    rec = {r["threshold_pct"]: r for r in vd1()["recovery"]}
    assert (rec[10]["episodes"], rec[10]["recovered"], rec[10]["open"]) == (2, 2, 0)
    assert rec[10]["median_days"] == 3.0 and rec[10]["small_sample"] is True
    assert rec[20]["median_days"] == 2.0 and rec[20]["episodes"] == 2


def test_inv_d04_default_minimum_hides_the_median_but_keeps_counts() -> None:
    rec = {r["threshold_pct"]: r for r in vd1(3)["recovery"]}
    assert rec[10]["median_days"] is None and rec[10]["median_days_reason"] == "too_few_episodes"
    assert rec[10]["episodes"] == 2 and rec[10]["recovered"] == 2


def test_inv_d05_open_episode_is_counted_and_never_in_the_median() -> None:
    c = arr(100, 85, 100, 80, 95)  # E1 recovers (3 days), E2 never recovers
    p = inv.drawdown_profile(days(5), c, replace(S, min_episodes=1))
    r10 = p["recovery"][0]
    assert (r10["episodes"], r10["recovered"], r10["open"]) == (2, 1, 1)
    assert r10["median_days"] == 1.0  # only the recovered one
    assert p["max_dd"]["depth_pct"] == -20.0
    assert p["max_dd"]["recovered"] is False and p["max_dd"]["recovery_date"] is None


@pytest.mark.parametrize(("price", "counts"), [(90.0, True), (89.99, True), (90.01, False)])
def test_inv_d06_float_tolerance(price: float, counts: bool) -> None:
    c = arr(100, price, 100)
    p = inv.drawdown_profile(days(3), c, replace(S, min_episodes=1))
    assert (p["recovery"][0]["episodes"] == 1) is counts


def test_inv_d07_monotonic_series_has_no_drawdown() -> None:
    p = inv.drawdown_profile(days(5), arr(1, 2, 3, 4, 5), S)
    assert p["current_dd_pct"] == 0.0 and p["episodes_total"] == 0
    assert p["max_dd"]["depth_pct"] == 0.0 and p["max_dd"]["peak_date"] is None
    assert p["max_dd"]["reason"] == "no_drawdown" and p["max_dd"]["recovered"] is None
    assert p["avg_underwater_depth_pct"] is None
    assert p["avg_underwater_depth_reason"] == "no_drawdown"
    assert all(r["median_days"] is None and r["episodes"] == 0 for r in p["recovery"])


# ---------------------------------------------------------------- INV-H
VH1 = arr(100, 120, 90, 135, 108, 162)


def test_inv_h01_vh1_rolling_window() -> None:
    p = inv.holding_periods(days(6), VH1, replace(S, min_windows=4), {"x": 2})
    w = p["windows"][0]
    assert w["windows"] == 4 and w["share_positive_pct"] == 75.0
    assert w["median_pct"] == 16.25 and w["best_pct"] == 20.0 and w["worst_pct"] == -10.0
    assert w["best_end_date"] == "2024-01-05"  # t=4, the earlier of the two ties
    assert w["worst_end_date"] == "2024-01-03"
    assert w["independent_periods"] == 2 and w["small_sample"] is True


def test_inv_h02_window_availability() -> None:
    c = np.linspace(100, 200, 300)
    p = {w["key"]: w for w in inv.holding_periods(days(300), c, S)["windows"]}
    assert (
        p["1y"]["reason"] is None
        and p["1y"]["windows"] == 48
        and p["1y"]["independent_periods"] == 1
    )
    assert p["3y"]["reason"] == "insufficient_history" and p["3y"]["median_pct"] is None
    few = inv.holding_periods(days(260), c[:260], S)["windows"][3]
    assert few["windows"] == 8 and few["reason"] == "too_few_windows" and few["best_pct"] is None
    edge = inv.holding_periods(days(252), c[:252], S)["windows"][3]
    assert edge["windows"] == 0 and edge["reason"] == "insufficient_history"  # N <= w
    big = inv.holding_periods(days(756 + 20), np.linspace(1, 2, 776), S)["windows"][4]
    assert big["windows"] == 20 and big["reason"] is None  # 756 rows plus 20 windows


# ---------------------------------------------------------------- INV-E
VE1 = arr(100, 100, 100, 90, 95, 99, 100, 80, 85, 90, 95, 100, 90, 88, 81)


def study(c: np.ndarray, h: int = 2) -> dict:  # type: ignore[type-arg]
    return inv.entry_study(days(len(c)), c, S, w52=3, horizons={"h": h}, thresholds=(10, 20))


def test_inv_e01_e02_vve1_entry_study() -> None:
    row = study(VE1)["rows"][0]
    assert row["drawdown_pct"] == 10 and row["episodes"] == 3 and row["pending"] == 0
    assert row["median_pct"] == 10.0 and row["best_pct"] == 12.5 and row["worst_pct"] == -10.0
    assert row["share_positive_pct"] == pytest.approx(66.67, abs=5e-3)
    assert row["all_windows_median_pct"] == pytest.approx(-5.0)
    assert row["small_sample"] is True and row["reason"] is None
    assert row["last_event_date"] == "2024-01-13"  # t = 12


def test_inv_e03_one_episode_is_hidden_not_zero() -> None:
    row = study(VE1)["rows"][1]
    assert row["drawdown_pct"] == 20 and row["episodes"] == 1
    assert row["reason"] == "too_few_episodes"
    assert (
        row["median_pct"] is None and row["best_pct"] is None and row["share_positive_pct"] is None
    )


def test_inv_e04_pending_windows() -> None:
    row = study(VE1[:14])["rows"][0]
    assert row["episodes"] == 2 and row["pending"] == 1 and row["reason"] == "too_few_episodes"


def test_inv_e05_crossing_inside_the_previous_window_is_skipped() -> None:
    row = study(VE1, h=5)["rows"][0]
    assert row["episodes"] == 1 and row["pending"] == 1
    lenient = inv.entry_study(
        days(15), VE1, replace(S, min_episodes=1), w52=3, horizons={"h": 5}, thresholds=(10,)
    )["rows"][0]
    assert lenient["median_pct"] == pytest.approx(-5.5556, abs=1e-4)  # t3 -> t8 only


def test_inv_e06_only_fresh_crossings_count() -> None:
    # already 20% below the 3-close high at the first defined row: no event there
    c = arr(100, 100, 80, 78, 70, 90, 95, 99)
    row = inv.entry_study(
        days(8), c, replace(S, min_episodes=1), w52=3, horizons={"h": 1}, thresholds=(10,)
    )["rows"][0]
    # t=2 is the first defined row (d52 = -20): not an event; t=3, t=4 are further below, not fresh
    assert row["episodes"] == 0 and row["pending"] == 0
    short = inv.entry_study(days(2), arr(1, 2), S, w52=3, horizons={"h": 1}, thresholds=(10,))
    assert short["rows"][0]["reason"] == "insufficient_history"


# ---------------------------------------------------------------- INV-V
def test_inv_v01_v02_vv1_percentile_and_bands() -> None:
    d = days(6)
    v = arr(12, 18, 15, 18, 25, 18)
    out = inv.vol_regime(d, v, S, min_values=6)
    assert out["percentile"] == pytest.approx(58.3333, abs=1e-4) and out["band"] == "typical"
    assert out["sample"] == 6 and out["current_vol_pct"] == 18.0
    assert inv.band(19.99, S) == "lower" and inv.band(20.0, S) == "typical"
    assert inv.band(79.99, S) == "typical" and inv.band(80.0, S) == "higher"
    short = inv.vol_regime(d, v, S)  # 6 values < 252
    assert short["percentile"] is None and short["reason"] == "insufficient_history"
    assert short["band"] is None and short["current_vol_pct"] is None


def test_inv_v03_window_is_21_rows_and_matches_rolling_vol_21() -> None:
    from worker.analytics import analysis_series as ser
    from worker.analytics.snapshot import Bars, build_snapshot

    rng = np.random.default_rng(11)
    n = 400
    c = 100 * np.cumprod(1 + rng.normal(0, 0.01, n))
    ds = [date(2022, 1, 3) + timedelta(days=i) for i in range(n)]
    snap = build_snapshot(Bars(ds, c, c, c * 1.01, c * 0.99, np.full(n, 1.0)))
    assert snap is not None
    block = snap["analysis"]["vol_regime"]
    series = snap["analysis"]["rolling_vol_21"]
    assert block["window_rows"] == 21
    assert block["current_vol_pct"] == series[-1]
    assert block["sample"] == n - 21 and block["first_date"] == ds[21].isoformat()
    assert ser.rolling_vol(c, 21)[-1] == pytest.approx(series[-1], abs=1e-4)


# ---------------------------------------------------------------- INV-L
VL1_DATES = [
    date(2024, 1, 1),
    date(2024, 2, 1),
    date(2024, 3, 1),
    date(2024, 4, 1),
    date(2024, 4, 30),
]
VL1 = arr(100, 50, 100, 200, 200)


def test_inv_l01_vl1_sip_versus_lump() -> None:
    v = sip.variant(VL1_DATES, VL1, None, replace(S, sip_min_months=4))
    assert v["installments"] == 4 and v["skipped"] == 0
    assert v["invested_inr"] == 4000.0 and v["sip_value_inr"] == 9000.0
    assert v["lump_value_inr"] == 8000.0 and v["value_ratio"] == 1.125
    assert v["sip_absolute_return_pct"] == 125.0 and v["lump_absolute_return_pct"] == 100.0
    assert v["sip_worst_unrealised_pct"] == -25.0 and v["lump_worst_unrealised_pct"] == -50.0
    assert v["span_days"] == 120 and v["sip_xirr_pct"] is None and v["lump_xirr_pct"] is None
    assert v["xirr_reason"] == "under_one_year"
    assert v["first_date"] == "2024-01-01" and v["last_date"] == "2024-04-01"


def test_inv_l02_xirr_vectors() -> None:
    flows = [
        (date(2024, 1, 5), -1000.0),
        (date(2024, 2, 5), -1000.0),
        (date(2024, 3, 5), -1000.0),
        (date(2025, 3, 5), 3300.0),
    ]
    assert sip.xirr(flows) == pytest.approx(0.09213, abs=1e-4)
    lump = [(date(2024, 1, 1), -4000.0), (date(2025, 1, 1), 8000.0)]
    assert sip.xirr(lump) == pytest.approx(2 ** (365 / 366) - 1, abs=1e-4)
    assert sip.xirr(lump) == pytest.approx(0.99622, abs=1e-4)
    assert sip.xirr([(date(2024, 1, 1), -1.0)]) is None  # no inflow
    assert sip.xirr([(date(2024, 1, 1), -1.0), (date(2024, 6, 1), 1e9)]) is None  # beyond bracket


def test_inv_l03_chosen_day_and_skipped_instalments() -> None:
    ds = [date(2024, 1, 16), date(2024, 2, 15), date(2024, 3, 15), date(2024, 4, 10)]
    idxs, skipped = sip.executions(ds, 15)
    assert idxs == [0, 1, 2] and skipped == 1
    v = sip.variant(ds, arr(10, 10, 10, 10), 15, replace(S, sip_min_months=3))
    assert v["installments"] == 3 and v["skipped"] == 1 and "reason" not in v


def monthly(n: int) -> tuple[list[date], np.ndarray]:
    ds = [date(2023 + (i // 12), i % 12 + 1, 3) for i in range(n)]
    return ds, np.linspace(100, 150, n)


def test_inv_l04_minimum_history() -> None:
    ds, c = monthly(11)
    v = sip.variant(ds, c, None, S)
    assert v["reason"] == "history_under_12_months" and v["installments"] == 11
    assert v["invested_inr"] is None and v["sip_xirr_pct"] is None and v["first_date"] is None
    ds, c = monthly(12)
    ok = sip.variant(ds, c, None, S)
    assert ok["installments"] == 12 and "reason" not in ok and ok["invested_inr"] == 12000.0


def test_inv_l05_29_variants_and_scale_free_percents() -> None:
    ds = [
        date(2022, 1, 3) + timedelta(days=i)
        for i in range(900)
        if (date(2022, 1, 3) + timedelta(days=i)).weekday() < 5
    ]
    c = np.linspace(100, 300, len(ds)) + 5 * np.sin(np.arange(len(ds)))
    one = sip.sip_backtest(ds, c, S)
    two = sip.sip_backtest(ds, c, S, amount=2000)
    assert [v["day"] for v in one["variants"]] == [None, *range(1, 29)]
    for a, b in zip(one["variants"], two["variants"], strict=True):
        assert a["invested_inr"] == a["installments"] * 1000
        assert a["sip_absolute_return_pct"] == pytest.approx(b["sip_absolute_return_pct"], abs=1e-9)
        assert a["value_ratio"] == pytest.approx(b["value_ratio"], abs=1e-3)
        assert b["invested_inr"] == 2 * a["invested_inr"]
        assert a["sip_xirr_pct"] is not None  # 3+ years of data: XIRR is shown
        assert round(a["sip_value_inr"], 2) == a["sip_value_inr"]
    assert one["amount_per_month_inr"] == 1000 and one["price_basis"] == "adj_close"


# ---------------------------------------------------------------- INV-R
def test_inv_r01_r02_downside_deviation_vr1() -> None:
    dev = inv.downside_deviation(arr(1, -2, 3, -4))
    assert dev == pytest.approx(35.4965, abs=1e-3)
    assert 15.0 / dev == pytest.approx(0.4226, abs=1e-4)
    assert inv.downside_deviation(arr(1, 2, 3)) == 0.0


def test_inv_r03_calmar() -> None:
    assert inv.calmar(15.0, -30.0) == (0.5, None)
    assert inv.calmar(15.0, 0.0) == (None, "no_drawdown")


def test_inv_r03_r04_block_uses_one_calendar_window() -> None:
    # Weekday bars: the calendar 3-year window holds about 783 rows, more than 756. A plateau
    # placed just inside the calendar window (but outside the last 756 rows) must show up in the
    # window's maximum drawdown, and CAGR must come from the same window.
    from worker.analytics import returns as rt

    ds = [date(2019, 1, 1) + timedelta(days=i) for i in range(1400)]
    ds = [d for d in ds if d.weekday() < 5][:900]
    c = np.linspace(100, 200, len(ds))
    start = ds.index(rt.ret_calendar(ds, c, 36).start_date)  # type: ignore[arg-type]
    assert start < len(ds) - 756
    c[start + 1 : start + 4] = 500.0
    out = inv.risk_adjusted(ds, c)
    assert out["maxdd_3y_window_pct"] == pytest.approx((c[start + 4] / 500.0 - 1) * 100, abs=1e-3)
    days_in_window = (ds[-1] - ds[start]).days
    cagr = ((c[-1] / c[start]) ** (365.25 / days_in_window) - 1) * 100
    assert out["cagr_3y_pct"] == pytest.approx(cagr, abs=1e-3)
    assert out["calmar_3y"] == pytest.approx(
        out["cagr_3y_pct"] / abs(out["maxdd_3y_window_pct"]), rel=1e-3
    )


def test_inv_r_monotonic_window_has_no_drawdown() -> None:
    ds = [date(2021, 1, 1) + timedelta(days=i) for i in range(3 * 365 + 10)]
    out = inv.risk_adjusted(ds, np.linspace(100, 200, len(ds)))
    assert out["maxdd_3y_window_pct"] == 0.0
    assert out["calmar_3y"] is None and out["calmar_3y_reason"] == "no_drawdown"
    assert out["downside_dev_3y_pct"] == 0.0 and out["return_per_downside_3y"] is None
    assert out["downside_reason"] == "no_drawdown" and out["cagr_3y_pct"] is not None


def test_inv_r03_under_three_years_is_insufficient_history() -> None:
    ds = [date(2022, 1, 1) + timedelta(days=i) for i in range(int(2.5 * 365))]
    out = inv.risk_adjusted(ds, np.linspace(100, 150, len(ds)))
    assert out["calmar_3y"] is None and out["calmar_3y_reason"] == "insufficient_history"
    assert (
        out["return_per_downside_3y"] is None and out["downside_reason"] == "insufficient_history"
    )
    assert out["cagr_3y_pct"] is None


def test_inv_r_block_values_with_a_drawdown() -> None:
    ds = [date(2020, 1, 1) + timedelta(days=i) for i in range(4 * 365)]
    c = 100 + np.arange(len(ds)) * 0.1
    c[-300:-200] -= 30
    out = inv.risk_adjusted(ds, c)
    assert out["maxdd_3y_window_pct"] < 0 and out["calmar_3y"] is not None
    assert out["calmar_3y"] == pytest.approx(
        out["cagr_3y_pct"] / abs(out["maxdd_3y_window_pct"]), rel=1e-3
    )
    assert out["downside_dev_3y_pct"] > 0
    assert math.isfinite(out["return_per_downside_3y"])


# ---------------------------------------------------------------- INV-A06
def test_inv_a06_settings_fallbacks_and_effect() -> None:
    d = InvSettings.from_mapping({})
    assert d == InvSettings()
    changed = InvSettings.from_mapping(
        {"INV_MIN_YEARS": 2, "INV_SMALL_YEARS": "7", "INV_VOL_BAND_LOW": 10, "INV_DD_TOL": 0}
    )
    assert (changed.min_years, changed.small_years, changed.vol_band_low) == (2, 7, 10.0)
    assert changed.dd_tol == 0.0
    bad = InvSettings.from_mapping(
        {
            "INV_MIN_YEARS": "x",
            "INV_MIN_WINDOWS": -4,
            "INV_VOL_BAND_LOW": 90,
            "INV_VOL_BAND_HIGH": 10,
            "INV_DD_TOL": True,
        }
    )
    assert bad == InvSettings()  # malformed or inconsistent values fall back to the defaults
    from worker.analytics import inv_months as inm

    two = [(2019, 1.0), (2020, -1.0)]
    assert inm.stats(two, InvSettings())["green_pct"] is None
    assert inm.stats(two, changed)["green_pct"] == 50.0
