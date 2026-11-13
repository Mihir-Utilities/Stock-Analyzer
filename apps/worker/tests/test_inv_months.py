"""INV-M and INV-S rows (docs/07; golden vectors VM1-VM4, VS1-VS3 of docs/05 12.1-12.2).

Pure functions: ``today`` is always an argument, nothing reads the wall clock.
"""

from __future__ import annotations

import calendar
import json
import math
from datetime import date, timedelta
from typing import Any

import numpy as np
import pytest

from worker.analytics import analysis_series as ser
from worker.analytics import inv_months as inm
from worker.analytics.inv_common import InvSettings
from worker.analytics.inv_months import MonthModel
from worker.analytics.snapshot import Bars, build_snapshot

S = InvSettings()


def last_weekday(y: int, m: int) -> date:
    d = date(y, m, calendar.monthrange(y, m)[1])
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d


def series(points: dict[date, float]) -> tuple[list[date], np.ndarray]:
    ds = sorted(points)
    return ds, np.array([points[d] for d in ds], dtype=np.float64)


def model(
    points: dict[date, float], today: date, holidays: frozenset[date] = frozenset()
) -> MonthModel:
    ds, c = series(points)
    return MonthModel(ds, c, today, holidays)


def vm1() -> dict[date, float]:
    pts: dict[date, float] = {date(2022, 11, 14): 100.0, last_weekday(2022, 11): 100.0}
    pts[last_weekday(2022, 12)] = 110.0
    pts[last_weekday(2023, 1)] = 99.0
    pts[last_weekday(2023, 2)] = 108.9
    pts[last_weekday(2023, 3)] = 98.01
    for m in range(4, 13):
        pts[last_weekday(2023, m)] = 107.811
    pts[last_weekday(2024, 1)] = 118.5921
    pts[date(2024, 2, 15)] = 106.73289
    return pts


VM1_TODAY = date(2024, 2, 15)


def cell(cells: list[list[Any]], y: int, m: int) -> Any:
    return next(c[2] for c in cells if (c[0], c[1]) == (y, m))


def test_inv_m01_month_return_is_month_end_over_previous_month_end() -> None:
    cells = ser.month_year(*series(vm1()), today=VM1_TODAY)
    exp = {(2022, 12): 10.0, (2023, 1): -10.0, (2023, 2): 10.0, (2023, 3): -10.0, (2023, 4): 10.0}
    exp.update({(2023, m): 0.0 for m in range(5, 13)})
    exp[(2024, 1)] = 10.0
    for (y, m), v in exp.items():
        assert cell(cells, y, m) == pytest.approx(v, abs=1e-9)
    assert not any((c[0], c[1]) == (2022, 11) for c in cells)  # first month: no base, no cell


def test_inv_m02_month_after_a_gap_is_null_not_paired_across_the_gap() -> None:
    pts = {
        last_weekday(2022, 12): 90.0,
        last_weekday(2023, 1): 100.0,
        last_weekday(2023, 2): 110.0,
        last_weekday(2023, 4): 121.0,
    }
    ds, c = series(pts)
    today = date(2023, 5, 10)
    cells = ser.month_year(ds, c, today)
    assert cell(cells, 2023, 2) == pytest.approx(10.0)
    assert cell(cells, 2023, 4) is None
    assert not any((x[0], x[1]) == (2023, 3) for x in cells)
    _, reasons = inm.month_cells(MonthModel(ds, c, today))
    assert reasons == [[2023, 4, "gap_before"]]


def test_inv_m03_running_month_is_mtd_and_in_no_statistic() -> None:
    m = model(vm1(), VM1_TODAY)
    cells, _ = inm.month_cells(m)
    assert cells[-1] == [2024, 2, -10.0]
    seas = inm.seasonality(m, 400, S)
    assert seas["running"] == {
        "year": 2024,
        "month": 2,
        "mtd_return_pct": -10.0,
        "mtd_reason": None,
        "base_date": "2024-01-31",
        "as_of": "2024-02-15",
    }
    assert seas["months"][1]["n_years"] == 1  # February: only 2023; 2024-02 is running


def test_inv_m04_m05_m06_year_rows() -> None:
    rows = {r["year"]: r for r in inm.year_returns(model(vm1(), VM1_TODAY))}
    assert rows[2022] == {
        "year": 2022,
        "return_pct": pytest.approx(10.0),
        "return_pct_reason": None,
        "kind": "partial_first",
        "months_covered": 1,
        "base_date": "2022-11-30",
        "end_date": "2022-12-30",
    }
    assert rows[2023]["kind"] == "full" and rows[2023]["months_covered"] == 12
    assert rows[2023]["return_pct"] == pytest.approx(-1.99, abs=5e-3)
    assert (rows[2023]["base_date"], rows[2023]["end_date"]) == ("2022-12-30", "2023-12-29")
    assert rows[2024]["kind"] == "ytd" and rows[2024]["months_covered"] == 2
    assert rows[2024]["return_pct"] == pytest.approx(-1.0, abs=5e-3)
    assert rows[2024]["end_date"] == "2024-02-15"


def test_inv_m06_a_year_is_full_once_today_is_in_a_later_year() -> None:
    pts = vm1()
    del pts[date(2024, 2, 15)]
    ytd = inm.year_returns(model(pts, date(2024, 1, 31)))[-1]
    assert ytd["kind"] == "ytd" and ytd["year"] == 2024
    full = [r for r in inm.year_returns(model(pts, date(2025, 1, 2))) if r["year"] == 2024]
    assert full and full[0]["kind"] == "full" and full[0]["return_pct_reason"] == "gap_before"
    # last bar in an earlier year than today: no row for the running year
    rows = inm.year_returns(model(pts, date(2026, 3, 1)))
    assert max(r["year"] for r in rows) == 2024


def test_inv_m07_year_edge_cases() -> None:
    # data starting in December: the first-year return is null (no_base)
    dec = {date(2022, 12, 14): 100.0, last_weekday(2022, 12): 101.0, last_weekday(2023, 1): 102.0}
    r = inm.year_returns(model(dec, date(2023, 3, 1)))
    assert (
        r[0]["year"] == 2022
        and r[0]["return_pct"] is None
        and r[0]["return_pct_reason"] == "no_base"
    )
    # a December without a bar in a closed year -> gap_before
    gap = {
        last_weekday(2021, 12): 100.0,
        last_weekday(2022, 6): 105.0,
        last_weekday(2023, 12): 120.0,
    }
    rows = {x["year"]: x for x in inm.year_returns(model(gap, date(2024, 2, 1)))}
    assert rows[2022]["return_pct"] is None and rows[2022]["return_pct_reason"] == "gap_before"
    assert rows[2023]["return_pct"] is None and rows[2023]["return_pct_reason"] == "gap_before"
    # a December that stops short of its last expected trading day -> incomplete_month_data
    short = {last_weekday(2021, 12): 100.0, date(2022, 12, 20): 110.0}
    rows = {x["year"]: x for x in inm.year_returns(model(short, date(2023, 2, 1)))}
    assert rows[2022]["return_pct"] is None
    assert rows[2022]["return_pct_reason"] == "incomplete_month_data"
    # a single bar: no rows
    assert inm.year_returns(model({date(2024, 2, 15): 100.0}, VM1_TODAY)) == []


def test_inv_m08_chain_identity_on_random_data() -> None:
    rng = np.random.default_rng(7)
    ds: list[date] = []
    d = date(2019, 3, 11)
    while d <= date(2024, 8, 20):
        if d.weekday() < 5:
            ds.append(d)
        d += timedelta(days=1)
    c = 100 * np.cumprod(1 + rng.normal(0.0004, 0.012, len(ds)))
    today = date(2024, 8, 20)
    m = MonthModel(ds, c, today)
    monthly: dict[tuple[int, int], float] = {(y, mo): p for y, mo, p in m.closed_returns()}
    mtd = m.mtd().value
    assert mtd is not None
    monthly[(2024, 8)] = mtd
    checked = 0
    for row in inm.year_rows(m, exact=True):
        y = row["year"]
        months = range(1, 13)
        if row["kind"] == "partial_first":
            months = range(4, 13)  # the history starts in March: months after the first month
        if row["kind"] == "ytd":
            months = range(1, 9)
        chain = 1.0
        for mo in months:
            chain *= 1 + monthly[(y, mo)] / 100
        assert 1 + row["return_pct"] / 100 == pytest.approx(chain, abs=1e-9)
        assert row["months_covered"] == len(months)
        checked += 1
    assert checked == 6  # 2019 partial, 2020..2023 full, 2024 ytd


def test_inv_m09_valid_bars_and_adj_close_only() -> None:
    ds: list[date] = []
    d = date(2023, 1, 2)
    while d <= date(2023, 4, 28):
        if d.weekday() < 5:
            ds.append(d)
        d += timedelta(days=1)
    n = len(ds)
    adj = np.linspace(100.0, 130.0, n)
    close = adj * 2.0  # raw close differs: the heatmap must use adj_close
    hi = close * 1.01
    lo = close * 0.99
    # the last bar of March has a non-finite adj_close: it is dropped and never a month end
    idx = ds.index(last_weekday(2023, 3))
    adj_bad = adj.copy()
    adj_bad[idx] = np.nan
    bars = Bars(ds, close, adj_bad, hi, lo, np.full(n, 1000.0))
    snap = build_snapshot(bars, inv_ctx=None)
    assert snap is not None
    cells = {(r[0], r[1]): r[2] for r in snap["analysis"]["month_year"]}
    assert cells[(2023, 2)] == pytest.approx(
        (adj[ds.index(last_weekday(2023, 2))] / adj[ds.index(last_weekday(2023, 1))] - 1) * 100,
        abs=1e-3,
    )
    assert cells[(2023, 3)] is None  # month end bar removed: incomplete
    assert [2023, 3, "incomplete_month_data"] in snap["analysis"]["month_year_reasons"]


def test_inv_m11_incomplete_month_vm3() -> None:
    pts = {
        date(2022, 12, 30): 100.0,
        date(2023, 1, 27): 105.0,
        date(2023, 2, 28): 110.25,
        date(2023, 3, 31): 115.0,
    }
    today = date(2023, 4, 10)
    cells, reasons = inm.month_cells(model(pts, today))
    assert [c[:2] for c in cells] == [
        [2023, 1],
        [2023, 2],
        [2023, 3],
    ]  # Dec 2022 is the first month
    assert cell(cells, 2023, 1) is None and cell(cells, 2023, 2) is None
    assert cell(cells, 2023, 3) == pytest.approx(4.3084, abs=1e-4)
    assert reasons == [[2023, 1, "incomplete_month_data"], [2023, 2, "gap_before"]]
    assert all(c[1] != 1 and c[1] != 2 for c in model(pts, today).closed_returns())
    # holidays decide the expected last trading day
    both = frozenset({date(2023, 1, 30), date(2023, 1, 31)})
    cells2, _ = inm.month_cells(model(pts, today, both))
    assert cell(cells2, 2023, 1) == pytest.approx(5.0)
    one = frozenset({date(2023, 1, 31)})
    assert cell(inm.month_cells(model(pts, today, one))[0], 2023, 1) is None


def test_inv_m12_no_prior_base_reasons() -> None:
    pts = {
        date(2023, 1, 10): 100.0,
        last_weekday(2023, 1): 101.0,
        last_weekday(2023, 3): 103.0,
        last_weekday(2023, 4): 104.0,
    }
    m = model(pts, date(2023, 6, 1))
    assert m.month_return(_i(2023, 1)).reason == "no_base"  # first month of the history
    assert m.month_return(_i(2023, 3)).reason == "gap_before"  # February has no bar
    assert m.month_return(_i(2023, 4)).value == pytest.approx((104 / 103 - 1) * 100)
    assert [(y, mo) for y, mo, _ in m.closed_returns()] == [(2023, 4)]


def _i(y: int, m: int) -> int:
    return y * 12 + m - 1


def test_inv_m13_calendar_closing_rule_vm4() -> None:
    pts = {last_weekday(2023, 12): 100.0, date(2024, 1, 31): 110.0}
    closed = model(pts, date(2024, 2, 1))
    assert closed.closed_returns() == [(2024, 1, pytest.approx(10.0))]
    seas = inm.seasonality(closed, 2, S)
    assert seas["months"][0]["n_years"] == 1 and seas["months"][0]["n_green"] == 1
    assert seas["running"]["month"] == 2 and seas["running"]["mtd_reason"] == "no_bar_this_month"
    running = model(pts, date(2024, 1, 31))
    assert running.closed_returns() == []
    assert running.mtd().value == pytest.approx(10.0)
    assert inm.seasonality(running, 2, S)["months"][0]["n_years"] == 0
    # the month of today never counts, even with its bars already imported
    later = model({**pts, date(2024, 2, 8): 120.0}, date(2024, 2, 8))
    assert [r[:2] for r in later.closed_returns()] == [(2024, 1)]


# ---------------------------------------------------------------- seasonality (INV-S)
def test_inv_s01_vs1_statistics() -> None:
    seas = inm.seasonality(model(vm1(), VM1_TODAY), 330, S)
    jan, feb, dec = seas["months"][0], seas["months"][1], seas["months"][11]
    assert (jan["n_years"], jan["n_green"]) == (2, 1)
    assert jan["green_pct"] is None and jan["green_pct_reason"] == "too_few_years"
    assert jan["avg_pct"] == pytest.approx(0.0, abs=1e-9) and jan["median_pct"] == pytest.approx(
        0.0, abs=1e-9
    )
    assert jan["best"] == {"pct": pytest.approx(10.0), "year": 2024}
    assert jan["worst"] == {"pct": pytest.approx(-10.0), "year": 2023}
    assert feb["n_years"] == 1
    assert (dec["n_years"], dec["n_green"]) == (2, 1)
    assert dec["avg_pct"] == pytest.approx(5.0) and dec["median_pct"] == pytest.approx(5.0)
    assert dec["best"] == {"pct": pytest.approx(10.0), "year": 2022}
    assert dec["worst"] == {"pct": pytest.approx(0.0, abs=1e-9), "year": 2023}
    nov = seas["months"][10]
    assert nov["n_years"] == 1 and nov["n_green"] == 0
    assert [m["n_years"] for m in seas["months"][2:4]] == [1, 1]  # Mar {-10}, Apr {+10}
    yrs = seas["years"]
    assert yrs["n"] == 1 and yrs["green_pct"] is None
    assert seas["best_month"] is None and seas["best_worst_reason"] == "too_few_months"


def test_inv_s02_green_is_strictly_positive_on_the_unrounded_value() -> None:
    def green(v: float) -> int:
        return int(inm.stats([(2020, v)], S)["n_green"])

    assert green(0.0) == 0 and green(0.004) == 1 and green(-0.004) == 0
    assert round(0.004, 1) == 0.0  # it displays +0.0% and still counts


def test_inv_s03_s04_vs2_vector_and_best_worst() -> None:
    a = inm.stats([(2019, 5.0), (2020, -2.0), (2021, 3.0), (2022, 0.0)], S)
    assert (a["n"], a["n_green"]) == (4, 2)
    assert a["green_pct"] == 50.0 and a["avg_pct"] == 1.5 and a["median_pct"] == 1.5
    assert a["best"] == {"pct": 5.0, "year": 2019} and a["worst"] == {"pct": -2.0, "year": 2020}
    assert a["small_sample"] is True
    b = inm.stats([(2019, 4.0), (2020, -1.0), (2021, 2.0)], S)
    assert (b["n"], b["n_green"]) == (3, 2)
    assert b["green_pct"] == pytest.approx(66.67, abs=5e-3)
    assert (
        b["avg_pct"] == pytest.approx(1.67, abs=5e-3)
        and b["median_pct"] == 2.0
        and b["small_sample"] is True
    )
    c = inm.stats([(2019, 2.5), (2020, 1.0)], S)
    assert c["green_pct"] is None and c["green_pct_reason"] == "too_few_years"
    assert c["median_pct"] == 1.75

    def entry(month: int, s: dict[str, Any]) -> dict[str, Any]:
        return {"month": month, "n_years": s["n"], "median_pct": s["median_pct"]}

    best, worst, reason = inm.best_worst([entry(7, a), entry(8, b), entry(9, c)], S)
    assert best == {"month": 8, "median_pct": 2.0, "n_years": 3} and reason is None
    assert worst == {"month": 7, "median_pct": 1.5, "n_years": 4}
    only = inm.best_worst([entry(7, a), entry(9, c)], S)
    assert only == (None, None, "too_few_months")
    tie = inm.best_worst([entry(3, a), entry(5, a), entry(9, b)], S)
    assert tie[0]["month"] == 9 and tie[1]["month"] == 3  # type: ignore[index]


def test_inv_s05_vs3_year_column_summary() -> None:
    s = inm.stats([(2019, 12.0), (2020, -8.0), (2021, 20.0), (2022, 4.0)], S)
    assert (s["n"], s["n_green"], s["green_pct"]) == (4, 3, 75.0)
    assert s["avg_pct"] == 7.0 and s["median_pct"] == 8.0
    assert s["best"] == {"pct": 20.0, "year": 2021} and s["worst"] == {"pct": -8.0, "year": 2020}
    assert s["small_sample"] is True


def long_series(first: date, last: date, seed: int = 3) -> tuple[list[date], np.ndarray]:
    rng = np.random.default_rng(seed)
    ds: list[date] = []
    d = first
    while d <= last:
        if d.weekday() < 5:
            ds.append(d)
        d += timedelta(days=1)
    return ds, 100 * np.cumprod(1 + rng.normal(0.0003, 0.01, len(ds)))


def test_inv_s06_statistics_use_all_history_but_cells_show_ten_years() -> None:
    ds, c = long_series(date(2010, 1, 4), date(2024, 8, 30))
    m = MonthModel(ds, c, date(2024, 8, 30))
    cells, _ = inm.month_cells(m)
    assert min(x[0] for x in cells) == 2015 and len({x[0] for x in cells}) == 10
    years = inm.year_returns(m)
    assert min(r["year"] for r in years) == 2015
    seas = inm.seasonality(m, len(ds), S)
    assert seas["months"][0]["n_years"] == 14  # Jan 2011..2024 (2010 is the first month)
    assert seas["years"]["n"] == 13  # 2011..2023 are full years; 2010 partial, 2024 ytd


def test_inv_s07_data_depth_and_a_14_month_history_shows_no_share() -> None:
    ds, c = long_series(date(2023, 3, 1), date(2024, 4, 30))
    seas = inm.seasonality(MonthModel(ds, c, date(2024, 5, 3)), len(ds), S)
    assert seas["first_bar"] == "2023-03-01" and seas["last_bar"] == "2024-04-30"
    assert seas["years_of_history"] == round(
        (date(2024, 4, 30) - date(2023, 3, 1)).days / 365.25, 1
    )
    assert max(m["n_years"] for m in seas["months"]) == 2  # spec said "at most 1": see B16-2
    assert all(m["green_pct"] is None for m in seas["months"])
    assert seas["years"]["green_pct"] is None


def _null_without_reason(node: Any, path: str = "") -> list[str]:
    """Every dict holding a null scalar must also hold a non-null ``*reason*`` value."""
    bad: list[str] = []
    if isinstance(node, dict):
        has_reason = any("reason" in k and v is not None for k, v in node.items())
        for k, v in node.items():
            if v is None and "reason" not in k and k != "day" and not has_reason:
                bad.append(f"{path}.{k}")
            bad += _null_without_reason(v, f"{path}.{k}")
    elif isinstance(node, list):
        for i, v in enumerate(node):
            bad += _null_without_reason(v, f"{path}[{i}]")
    return bad


NEW_KEYS = (
    "month_year_reasons",
    "year_returns",
    "seasonality",
    "position",
    "drawdown_profile",
    "holding_periods",
    "entry_study",
    "vol_regime",
    "sip_backtest",
    "risk_adjusted",
)


def bars_from(ds: list[date], c: np.ndarray) -> Bars:
    return Bars(ds, c, c, c * 1.01, c * 0.99, np.full(len(ds), 1000.0))


@pytest.mark.parametrize(
    ("first", "last"),
    [(date(2023, 3, 1), date(2024, 4, 30)), (date(1999, 1, 4), date(2024, 8, 30))],
)
def test_inv_s08_new_blocks_are_json_safe_with_reasons_and_small(first: date, last: date) -> None:
    ds, c = long_series(first, last)
    snap = build_snapshot(bars_from(ds, c))
    assert snap is not None
    json.dumps(snap, allow_nan=False)  # NaN / Infinity raise
    a = snap["analysis"]
    new = {k: a[k] for k in NEW_KEYS}
    assert _null_without_reason(new) == []
    grown = len(json.dumps(new, separators=(",", ":")))
    assert grown < 20_000, grown
    assert len(json.dumps(snap)) < 250_000
    for k in NEW_KEYS:
        if isinstance(a[k], dict):
            assert a[k].get("as_of") and a[k].get("bars") == len(ds), k


def test_inv_s08_never_zero_for_unknown_a_short_history() -> None:
    ds, c = long_series(date(2024, 1, 2), date(2024, 5, 31))
    snap = build_snapshot(bars_from(ds, c))
    assert snap is not None
    a = snap["analysis"]
    assert a["position"]["range_pos_52w_pct"] is None
    assert a["position"]["range_pos_52w_reason"] == "insufficient_history"
    assert all(r["reason"] is not None for r in a["holding_periods"]["windows"][2:])
    assert a["risk_adjusted"]["calmar_3y"] is None
    assert all(v["reason"] == "history_under_12_months" for v in a["sip_backtest"]["variants"])
    assert not math.isnan(a["seasonality"]["years_of_history"])
