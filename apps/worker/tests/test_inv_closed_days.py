"""INV-M14 (docs/07): market-closed days derived from the data (docs/05 12.1, D-INV3). Synthetic
multi-instrument calendars reproduce three real owner cases: a month ending on two consecutive
holidays (2018-03), a month ending on one holiday Monday (2020-11) and a genuine gap."""

from __future__ import annotations

from datetime import date, timedelta

import numpy as np

from worker.analytics.inv_months import (
    GAP_BEFORE,
    INCOMPLETE,
    NO_BASE,
    MonthModel,
    derive_closed_days,
)

PEERS = 4  # tracked instruments trading on every open day


def weekdays(a: date, b: date) -> list[date]:
    out: list[date] = []
    d = a
    while d <= b:
        if d.weekday() < 5:
            out.append(d)
        d += timedelta(days=1)
    return out


def market(a: date, b: date, shut: set[date], peers: int = PEERS) -> dict[date, int]:
    """Tracked instruments with a bar on each open weekday of ``[a, b]``."""
    return {d: peers for d in weekdays(a, b) if d not in shut}


def stock(
    counts: dict[date, int], first: date, *, lacks: frozenset[date] = frozenset()
) -> tuple[list[date], np.ndarray]:
    ds = [d for d in sorted(counts) if d >= first and d not in lacks]
    return ds, np.array([100.0 + i * 0.1 for i in range(len(ds))], dtype=np.float64)


def model_for(
    counts: dict[date, int],
    first: date,
    today: date,
    *,
    lacks: frozenset[date] = frozenset(),
    closed: bool = True,
) -> MonthModel:
    ds, c = stock(counts, first, lacks=lacks)
    return MonthModel(
        ds, c, today, frozenset(), derive_closed_days(counts, first) if closed else frozenset()
    )


def idx(y: int, m: int) -> int:
    return y * 12 + m - 1


def test_inv_m14a_month_ending_on_two_holidays_is_complete_2018_03_shape() -> None:
    shut = {date(2018, 3, 29), date(2018, 3, 30)}  # Mahavir Jayanti + Good Friday
    counts = market(date(2018, 1, 1), date(2018, 6, 29), shut)
    today = date(2018, 7, 10)
    assert derive_closed_days(counts, date(2018, 1, 1)) >= shut
    m = model_for(counts, date(2018, 1, 1), today)
    assert m.complete(idx(2018, 3))
    assert m.month_return(idx(2018, 3)).value is not None
    assert m.month_return(idx(2018, 4)).value is not None  # no gap_before
    old = model_for(counts, date(2018, 1, 1), today, closed=False)  # the pre-D-INV3 behaviour
    assert old.month_return(idx(2018, 3)).reason == INCOMPLETE
    assert old.month_return(idx(2018, 4)).reason == GAP_BEFORE
    assert m.months_excluded_incomplete() == 0 and old.months_excluded_incomplete() == 1


def test_inv_m14b_month_ending_on_a_single_holiday_monday_2020_11_shape() -> None:
    shut = {date(2020, 11, 30)}  # Monday
    counts = market(date(2020, 9, 1), date(2021, 1, 29), shut)
    m = model_for(counts, date(2020, 9, 1), date(2021, 2, 3))
    assert m.end_date[idx(2020, 11)] == date(2020, 11, 27)
    assert m.month_return(idx(2020, 11)).value is not None
    assert m.month_return(idx(2020, 12)).value is not None
    expected = (m.end_close[idx(2020, 11)] / m.end_close[idx(2020, 10)] - 1.0) * 100.0
    assert m.month_return(idx(2020, 11)).value == expected


def test_inv_m14c_a_stock_lacking_a_day_others_traded_stays_incomplete() -> None:
    shut = {date(2018, 3, 29), date(2018, 3, 30)}
    counts = market(date(2018, 1, 1), date(2018, 6, 29), shut)
    lacks = frozenset({date(2018, 3, 28)})  # peers traded on 28 Mar, this stock has no bar
    m = model_for(counts, date(2018, 1, 1), date(2018, 7, 10), lacks=lacks)
    assert date(2018, 3, 28) not in derive_closed_days(counts, date(2018, 1, 1))
    r = m.month_return(idx(2018, 3))
    assert r.value is None and r.reason == INCOMPLETE  # a genuine gap stays visible
    assert m.month_return(idx(2018, 4)).reason == GAP_BEFORE
    assert m.months_excluded_incomplete() == 1


def test_inv_m14d_fewer_than_three_instruments_fall_back_to_the_holidays_file() -> None:
    shut = {date(2018, 3, 29), date(2018, 3, 30)}
    for peers in (1, 2):
        counts = market(date(2018, 1, 1), date(2018, 6, 29), shut, peers=peers)
        assert derive_closed_days(counts, date(2018, 1, 1)) == frozenset()
        m = model_for(counts, date(2018, 1, 1), date(2018, 7, 10))
        assert m.month_return(idx(2018, 3)).reason == INCOMPLETE
    ds, c = stock(market(date(2018, 1, 1), date(2018, 6, 29), shut, 1), date(2018, 1, 1))
    with_file = MonthModel(ds, c, date(2018, 7, 10), frozenset(shut))  # the holidays file works
    assert with_file.month_return(idx(2018, 3)).value is not None


def test_inv_m14e_a_long_market_wide_outage_is_missing_data_not_closure() -> None:
    outage = set(weekdays(date(2018, 3, 19), date(2018, 3, 30)))  # ten weekdays, nobody has bars
    counts = market(date(2018, 1, 1), date(2018, 6, 29), outage)
    assert derive_closed_days(counts, date(2018, 1, 1)) == frozenset()
    m = model_for(counts, date(2018, 1, 1), date(2018, 7, 10))
    assert m.month_return(idx(2018, 3)).reason == INCOMPLETE
    short = set(weekdays(date(2018, 3, 26), date(2018, 3, 30)))  # five weekdays: still closures
    assert (
        derive_closed_days(market(date(2018, 1, 1), date(2018, 6, 29), short), date(2018, 1, 1))
        == short
    )


def test_inv_m14f_weekdays_after_the_newest_market_bar_are_never_presumed_closed() -> None:
    counts = market(date(2020, 9, 1), date(2020, 11, 27), set())  # imports stop on Fri 27 Nov
    closed = derive_closed_days(counts, date(2020, 9, 1))
    assert closed == frozenset()
    m = model_for(counts, date(2020, 9, 1), date(2020, 12, 5))  # November is closed by today
    assert m.month_return(idx(2020, 11)).reason == INCOMPLETE  # 30 Nov may be a missing import


def test_inv_m14g_thin_month_is_not_judged() -> None:
    counts = market(date(2018, 1, 1), date(2018, 2, 28), set())
    counts.update(market(date(2018, 3, 1), date(2018, 3, 28), set(), peers=2))  # only two active
    counts.update(market(date(2018, 4, 2), date(2018, 6, 29), set()))
    assert date(2018, 3, 29) not in derive_closed_days(counts, date(2018, 1, 1))


def test_inv_m14h_newly_listed_stock_first_partial_month() -> None:
    shut = {date(2018, 3, 29), date(2018, 3, 30)}
    counts = market(date(2018, 1, 1), date(2018, 6, 29), shut)
    listed = date(2018, 3, 14)
    m = model_for(counts, listed, date(2018, 7, 10))
    assert m.month_return(idx(2018, 3)).reason == NO_BASE  # first month: no return
    assert m.complete(idx(2018, 3))  # but it is a valid base thanks to the closed days
    assert m.month_return(idx(2018, 4)).value is not None
    assert derive_closed_days(counts, listed) >= shut  # days before the listing are not judged
    assert all(d >= listed for d in derive_closed_days(counts, listed))


def test_inv_m14i_weekends_and_unrelated_days_are_never_returned() -> None:
    counts = market(date(2018, 1, 1), date(2018, 6, 29), {date(2018, 3, 30)})
    closed = derive_closed_days(counts, date(2018, 1, 1))
    assert closed == {date(2018, 3, 30)}
    assert derive_closed_days({}, date(2018, 1, 1)) == frozenset()
