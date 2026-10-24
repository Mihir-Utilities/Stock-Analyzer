"""Alert evaluator, pure part (docs/04 3.9; ALR-02, 04, 09, 17, 18 and the kind rules)."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any

import numpy as np

from worker.alerts_eval import (
    AlertRow,
    evaluate_bar_alert,
    evaluate_holding_change,
    evaluate_results_declared,
    evaluate_results_upcoming,
    fmt_date,
    fmt_num,
)
from worker.analytics.snapshot import Bars

NOW = datetime(2026, 10, 9, 14, 30, tzinfo=UTC)


def days(n: int, start: date = date(2024, 1, 1)) -> list[date]:
    out: list[date] = []
    d = start
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d)
        d += timedelta(days=1)
    return out


def bars_of(
    close: list[float], *, high: list[float] | None = None, low: list[float] | None = None
) -> Bars:
    c = np.array(close, dtype=np.float64)
    return Bars(
        dates=days(len(close)),
        close=c,
        adj_close=c.copy(),
        high=np.array(high, dtype=np.float64) if high else c * 1.0,
        low=np.array(low, dtype=np.float64) if low else c * 1.0,
        volume=np.zeros(len(close)),
    )


def alert(kind: str, params: dict[str, Any], **kw: Any) -> AlertRow:
    base: dict[str, Any] = {
        "id": 12,
        "kind": kind,
        "params": params,
        "one_shot": True,
        "cooldown_minutes": 1440,
        "label": "TCS",
    }
    base.update(kw)
    return AlertRow(**base)


def state_at(bars: Bars, index: int, **extra: Any) -> dict[str, Any]:
    return {"last_bar_date": bars.dates[index].isoformat(), **extra}


# --------------------------------------------------------------------------- formatting
def test_number_and_date_formatting() -> None:
    assert fmt_num(Decimal("4012.5")) == "4,012.50"
    assert fmt_num(Decimal("4000"), strip=True) == "4,000"
    assert fmt_num(Decimal("1234567.891")) == "12,34,567.89"
    assert fmt_num(Decimal("-2.345"), sign=True) == "-2.35"
    assert fmt_num(Decimal("2.3"), sign=True) == "+2.30"
    assert fmt_date(date(2026, 10, 9)) == "09 Oct 2026"


# --------------------------------------------------------------------------- price
def test_alr02_overnight_gap_fires_on_next_evaluation_with_manual_mode_message() -> None:
    b = bars_of([3900.0, 3950.0, 4012.5])
    res = evaluate_bar_alert(
        alert("price_above", {"price": 4000}, last_state=state_at(b, 1)), b, NOW
    )
    assert len(res.fires) == 1 and res.final
    fire = res.fires[0]
    assert fire.text == (
        "<b>TCS</b> above 4,000 | close 4,012.50, as of the last price import "
        f"({fmt_date(b.dates[2])}). Alert #12"
    )
    assert fire.dedupe_key == f"12|price_above|{b.dates[2].isoformat()}|4000"
    assert res.state is not None and res.state["last_bar_date"] == b.dates[2].isoformat()


def test_alr18_only_bars_newer_than_the_last_evaluated_bar_can_fire() -> None:
    b = bars_of([3900.0, 4100.0, 4200.0])
    # the 4100 bar was already evaluated (and did not fire, e.g. paused then resumed)
    nothing_new = evaluate_bar_alert(
        alert("price_above", {"price": 4000}, last_state=state_at(b, 2)), b, NOW
    )
    assert nothing_new.fires == [] and nothing_new.state == state_at(b, 2)
    # a NULL state (new alert or params edit) looks at the latest bar only, never at history
    first = evaluate_bar_alert(alert("price_above", {"price": 4150}, last_state=None), b, NOW)
    assert [f.payload["bar_date"] for f in first.fires] == [b.dates[2].isoformat()]
    older = evaluate_bar_alert(
        alert("price_above", {"price": 4000}, last_state=state_at(b, 0)), b, NOW
    )
    assert older.fires[0].payload["bar_date"] == b.dates[1].isoformat()  # first bar that crossed


def test_alr18_same_bar_gives_same_dedupe_key_on_a_rerun() -> None:
    b = bars_of([3900.0, 4100.0])
    one = evaluate_bar_alert(
        alert("price_above", {"price": 4000}, last_state=state_at(b, 0)), b, NOW
    )
    two = evaluate_bar_alert(
        alert("price_above", {"price": 4000}, last_state=state_at(b, 0)), b, NOW
    )
    assert one.fires[0].dedupe_key == two.fires[0].dedupe_key


def test_price_below_and_nav_wording() -> None:
    b = bars_of([100.0, 94.0])
    res = evaluate_bar_alert(alert("price_below", {"price": 95}, last_state=state_at(b, 0)), b, NOW)
    assert "below 95 | close 94.00" in res.fires[0].text
    nav = evaluate_bar_alert(
        alert("nav_above", {"nav": 50.5}, label="Fund <Growth>", last_state=state_at(b, 0)),
        bars_of([49.0, 51.2345]),
        NOW,
    )
    assert (
        "<b>Fund &lt;Growth&gt;</b> above 50.5 | NAV 51.23, as of the latest NAV ("
        in nav.fires[0].text
    )


def test_alr04_recurring_needs_half_percent_move_back_and_the_cooldown() -> None:
    closes = [99.0, 101.0, 100.4, 99.0, 101.0, 101.5]
    b = bars_of(closes)
    a = alert("price_above", {"price": 100}, one_shot=False, cooldown_minutes=60, last_state=None)
    # bar 1: fires, disarms
    r1 = evaluate_bar_alert(
        AlertRow(**{**a.__dict__, "last_state": state_at(b, 0)}), bars_of(closes[:2]), NOW
    )
    assert len(r1.fires) == 1 and not r1.final and r1.state is not None
    assert r1.state["armed"] is False
    # 100.4 is back below T but not by 0.5%: still disarmed; 99.0 re-arms
    r2 = evaluate_bar_alert(
        AlertRow(**{**a.__dict__, "last_state": r1.state, "last_fired_at": NOW}),
        bars_of(closes[:3]),
        NOW + timedelta(hours=3),
    )
    assert r2.fires == [] and r2.state is not None and r2.state["armed"] is False
    # re-armed at 99.0, then 101.0 fires once the cooldown (60 min) has passed...
    r3 = evaluate_bar_alert(
        AlertRow(**{**a.__dict__, "last_state": r2.state, "last_fired_at": NOW}),
        bars_of(closes[:5]),
        NOW + timedelta(hours=3),
    )
    assert [f.payload["bar_date"] for f in r3.fires] == [b.dates[4].isoformat()]
    # ...and is swallowed while still inside it
    r4 = evaluate_bar_alert(
        AlertRow(**{**a.__dict__, "last_state": r2.state, "last_fired_at": NOW}),
        bars_of(closes[:5]),
        NOW + timedelta(minutes=30),
    )
    assert r4.fires == [] and r4.state is not None and r4.state["armed"] is True


# --------------------------------------------------------------------------- other bar kinds
def test_day_change_direction_and_threshold() -> None:
    b = bars_of([100.0, 103.0])
    up = evaluate_bar_alert(
        alert("day_change_pct", {"pct": 3, "direction": "up"}, last_state=state_at(b, 0)), b, NOW
    )
    assert len(up.fires) == 1 and "day change +3.00%" in up.fires[0].text
    down = evaluate_bar_alert(
        alert("day_change_pct", {"pct": 3, "direction": "down"}, last_state=state_at(b, 0)), b, NOW
    )
    assert down.fires == []
    either = evaluate_bar_alert(
        alert("day_change_pct", {"pct": 3.5, "direction": "either"}, last_state=state_at(b, 0)),
        b,
        NOW,
    )
    assert either.fires == []


def test_wk52_needs_a_full_prior_window_and_uses_highs_excluding_today() -> None:
    n = 252
    close = [100.0] * n + [105.0]
    high = [110.0] * n + [106.0]
    b = bars_of(close, high=high)
    res = evaluate_bar_alert(alert("wk52_high", {}, last_state=state_at(b, n - 1)), b, NOW)
    assert res.fires == []  # 105 < prior high 110
    b2 = bars_of([100.0] * n + [111.0], high=[110.0] * n + [112.0])
    res2 = evaluate_bar_alert(alert("wk52_high", {}, last_state=state_at(b2, n - 1)), b2, NOW)
    assert len(res2.fires) == 1 and "new 52-week high" in res2.fires[0].text
    thin = bars_of([100.0] * 100 + [500.0])
    assert evaluate_bar_alert(alert("wk52_high", {}, last_state=None), thin, NOW).fires == []
    low = bars_of([100.0] * n + [89.0], low=[90.0] * n + [88.0])
    res3 = evaluate_bar_alert(alert("wk52_low", {}, last_state=state_at(low, n - 1)), low, NOW)
    assert len(res3.fires) == 1 and "new 52-week low" in res3.fires[0].text


def test_ma_cross_golden_and_death_once_per_cross_date() -> None:
    close = [10.0] * 30 + [9.0] * 12 + [20.0] * 3  # fast SMA(5) rises through SMA(20)
    b = bars_of(close)
    hit = None
    for t in range(1, len(close)):
        r = evaluate_bar_alert(
            alert(
                "ma_cross",
                {"fast": 5, "slow": 20, "direction": "golden"},
                last_state=state_at(b, t - 1),
            ),
            Bars(
                b.dates[: t + 1],
                b.close[: t + 1],
                b.adj_close[: t + 1],
                b.high[: t + 1],
                b.low[: t + 1],
                b.volume[: t + 1],
            ),
            NOW,
        )
        if r.fires:
            assert hit is None  # exactly one cross date
            hit = t
            assert "golden cross SMA5/SMA20" in r.fires[0].text
    assert hit is not None
    death = evaluate_bar_alert(
        alert(
            "ma_cross",
            {"fast": 5, "slow": 20, "direction": "death"},
            last_state=state_at(b, hit - 1),
        ),
        Bars(
            b.dates[: hit + 1],
            b.close[: hit + 1],
            b.adj_close[: hit + 1],
            b.high[: hit + 1],
            b.low[: hit + 1],
            b.volume[: hit + 1],
        ),
        NOW,
    )
    assert death.fires == []


def test_rsi_crossing_between_consecutive_values() -> None:
    close = [100.0 - i for i in range(30)] + [60.0 + 3 * i for i in range(10)]
    b = bars_of(close)
    fired: list[int] = []
    for t in range(1, len(close)):
        sub = Bars(
            *(
                getattr(b, f)[: t + 1]
                for f in ("dates", "close", "adj_close", "high", "low", "volume")
            )
        )
        r = evaluate_bar_alert(
            alert("rsi_above", {"level": 50}, last_state=state_at(b, t - 1)), sub, NOW
        )
        if r.fires:
            fired.append(t)
            assert "RSI(14) crossed above 50" in r.fires[0].text
    assert len(fired) == 1
    below = evaluate_bar_alert(
        alert("rsi_below", {"level": 50}, last_state=state_at(b, fired[0] - 1)),
        Bars(
            *(
                getattr(b, f)[: fired[0] + 1]
                for f in ("dates", "close", "adj_close", "high", "low", "volume")
            )
        ),
        NOW,
    )
    assert below.fires == []


# --------------------------------------------------------------------------- owner data kinds
def test_alr17_results_upcoming_relies_on_the_owner_calendar() -> None:
    today = date(2026, 10, 9)
    a = alert("results_upcoming", {"days_before": 3}, one_shot=False)
    assert evaluate_results_upcoming(a, [], today).fires == []  # no event, no alert
    far = evaluate_results_upcoming(a, [(1, today + timedelta(days=4))], today)
    assert far.fires == []
    past = evaluate_results_upcoming(a, [(1, today - timedelta(days=1))], today)
    assert past.fires == []
    near = evaluate_results_upcoming(a, [(7, today + timedelta(days=3))], today)
    assert len(near.fires) == 1 and near.fires[0].dedupe_key == "12|results_upcoming|event:7"
    assert "results on 12 Oct 2026 (in 3 days)" in near.fires[0].text
    same_day = evaluate_results_upcoming(a, [(7, today)], today)
    assert "(today)" in same_day.fires[0].text


def test_results_declared_initialises_silently_then_fires_on_a_newer_period() -> None:
    a = alert("results_declared", {})
    first = evaluate_results_declared(a, date(2026, 6, 30))
    assert first.fires == [] and first.state == {"latest_period": "2026-06-30", "initialised": True}
    same = evaluate_results_declared(
        alert("results_declared", {}, last_state=first.state), date(2026, 6, 30)
    )
    assert same.fires == []
    newer = evaluate_results_declared(
        alert("results_declared", {}, last_state=first.state), date(2026, 9, 30)
    )
    assert len(newer.fires) == 1 and newer.final
    assert newer.state == {"latest_period": "2026-09-30", "initialised": True}
    none_yet = evaluate_results_declared(a, None)  # nothing entered yet: remembered as such
    assert none_yet.fires == [] and none_yet.state == {"initialised": True}
    first_ever = evaluate_results_declared(
        alert("results_declared", {}, last_state=none_yet.state), date(2026, 6, 30)
    )
    assert len(first_ever.fires) == 1


def test_holding_change_compares_with_the_previous_quarter() -> None:
    def q(end: date, promoter: float | None) -> tuple[date, dict[str, float | None]]:
        return end, {"promoter_pct": promoter, "fii_pct": 10.0, "dii_pct": 5.0, "mf_pct": 2.0}

    a = alert(
        "holding_change",
        {"holder": "promoter", "delta_pct": 1.0},
        last_state={"latest_quarter": "2026-03-31"},
    )
    hit = evaluate_holding_change(a, [q(date(2026, 6, 30), 51.2), q(date(2026, 3, 31), 50.0)])
    assert (
        len(hit.fires) == 1
        and "promoter holding changed +1.20 points to 51.20%" in hit.fires[0].text
    )
    small = evaluate_holding_change(a, [q(date(2026, 6, 30), 50.4), q(date(2026, 3, 31), 50.0)])
    assert small.fires == [] and small.state == {"latest_quarter": "2026-06-30"}
    unknown = evaluate_holding_change(a, [q(date(2026, 6, 30), None), q(date(2026, 3, 31), 50.0)])
    assert unknown.fires == []  # unknown is never treated as 0
    fresh = evaluate_holding_change(
        alert("holding_change", {"holder": "promoter", "delta_pct": 1.0}),
        [q(date(2026, 6, 30), 60.0), q(date(2026, 3, 31), 50.0)],
    )
    assert fresh.fires == [] and fresh.state == {
        "latest_quarter": "2026-06-30",
        "initialised": True,
    }


def test_alr09_dynamic_text_is_html_escaped() -> None:
    b = bars_of([3900.0, 4100.0])
    res = evaluate_bar_alert(
        alert("price_above", {"price": 4000}, label="M&M <x>", last_state=state_at(b, 0)), b, NOW
    )
    assert res.fires[0].text.startswith("<b>M&amp;M &lt;x&gt;</b> above 4,000")
    assert "M&M" not in res.fires[0].text
    holder = evaluate_holding_change(
        alert(
            "holding_change",
            {"holder": "promoter", "delta_pct": 0.1},
            label="A&B",
            last_state={"latest_quarter": "2026-03-31"},
        ),
        [(date(2026, 6, 30), {"promoter_pct": 55.0}), (date(2026, 3, 31), {"promoter_pct": 50.0})],
    )
    assert "<b>A&amp;B</b>" in holder.fires[0].text
