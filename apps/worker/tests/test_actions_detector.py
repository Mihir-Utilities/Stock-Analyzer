"""Split/bonus detector, soft flag and adjustment maths (pure): ACT-01/02/03/05/07/08/10/13/14/15,
D-T volume window, BRK-18 (IST dates), BRK-19 (duplicate bars)."""

from __future__ import annotations

import csv
from datetime import UTC, date, datetime
from decimal import Decimal
from pathlib import Path

import pytest
from pricegen import make_series, trading_days

from worker.analytics.actions import (
    FLAG_LARGE_DROP,
    Bar,
    DetectorConfig,
    adj_close,
    adjustment_steps,
    detect_splits,
    match_fraction,
    normalize_bars,
    qty_multiplier,
    soft_drop_flags,
)
from worker.marketdate import ist_date, ist_today

REPO = Path(__file__).resolve().parents[3]
CFG = DetectorConfig()


def flat_then_jump(ratio: float, *, volume_at_jump: int, n_before: int = 30) -> list[Bar]:
    """Exact (noise-free) closes so the ratio under test is precise."""
    days = trading_days(n_before + 5)
    bars = [Bar(d, 1000.0, 100_000) for d in days[:n_before]]
    bars.append(Bar(days[n_before], 1000.0 * ratio, volume_at_jump))
    bars += [Bar(d, 1000.0 * ratio, 100_000) for d in days[n_before + 1 :]]
    return bars


# --------------------------------------------------------------------------- ACT-01 / ACT-02
def test_act01_fifty_percent_fall_with_volume_spike_is_detected() -> None:
    bars = make_series(60, jumps={40: (0.5, 3.0)})
    [det] = detect_splits(bars)
    assert det.ex_date == bars[40].trade_date
    assert (det.ratio_num, det.ratio_den) == (1, 2)
    assert det.conflict is False
    assert det.change_pct == pytest.approx(-50.0, abs=1.5)


@pytest.mark.parametrize(
    ("ratio", "num_den"),
    [(1 / 3, (1, 3)), (0.25, (1, 4)), (0.2, (1, 5)), (0.1, (1, 10)), (0.05, (1, 20))],
)
def test_act01_each_reachable_fraction_is_matched(ratio: float, num_den: tuple[int, int]) -> None:
    [det] = detect_splits(flat_then_jump(ratio, volume_at_jump=400_000))
    assert (det.ratio_num, det.ratio_den) == num_den


def test_act01_wizard_sample_has_too_little_history_for_the_volume_rule() -> None:
    """fixtures/.../prices_synthetic_split.csv has only 14 bars before the 5:1 split."""
    path = REPO / "fixtures" / "import-samples" / "prices_synthetic_split.csv"
    with path.open(encoding="utf-8", newline="") as fh:
        bars = [
            Bar(date.fromisoformat(r["date"]), float(r["close"]), int(r["volume"]))
            for r in csv.DictReader(fh)
        ]
    assert [b.trade_date for b in bars if b.close < 500][0] == date(2026, 2, 10)
    assert detect_splits(bars) == []  # fewer than 20 prior bars: no volume judgement (D03-A1)
    # the same split with a long enough history is found
    assert len(detect_splits(make_series(60, jumps={30: (0.2, 10.0)}))) == 1


def test_act02_real_crash_without_volume_spike_or_fraction_is_not_detected() -> None:
    # 40% crash, ratio 0.60 is not within 3% of any fraction: no detection
    assert detect_splits(flat_then_jump(0.60, volume_at_jump=900_000)) == []
    # ratio exactly 1/2 but quiet volume: no detection
    assert detect_splits(flat_then_jump(0.5, volume_at_jump=100_000)) == []
    # volume exactly 1.5x the average is not "more than" 1.5x
    assert detect_splits(flat_then_jump(0.5, volume_at_jump=150_000)) == []
    assert len(detect_splits(flat_then_jump(0.5, volume_at_jump=150_001))) == 1


def test_act02_tolerance_is_three_percent_relative_to_the_fraction() -> None:
    assert match_fraction(0.5 * 1.03, CFG) == (1, 2)
    assert match_fraction(0.5 * 1.031, CFG) is None
    assert match_fraction(0.5 * 0.97, CFG) == (1, 2)
    assert match_fraction(0.5 * 0.969, CFG) is None


# --------------------------------------------------------------------------- ACT-07 / 13 / 14
@pytest.mark.parametrize("ratio", [0.70, 0.75, 0.80, 0.85, 0.90, 0.65, 1.0, 1.2])
def test_act07_small_splits_and_bonus_ratio_065_to_1_are_not_detected(ratio: float) -> None:
    assert detect_splits(flat_then_jump(ratio, volume_at_jump=900_000)) == []


@pytest.mark.parametrize("ratio", [10.0, 5.0, 2.0, 1.36, 20.0])
def test_act13_reverse_split_is_never_matched(ratio: float) -> None:
    assert detect_splits(flat_then_jump(ratio, volume_at_jump=900_000)) == []


def test_act14_fractions_above_trigger_are_unreachable_and_pinned() -> None:
    """Pins the threshold interplay so a change is deliberate (S8, OQ-13/D-O)."""
    for num, den in [(3, 4), (4, 5), (5, 6)]:
        f = num / den
        for r in (f * 0.97, f, f * 1.03):  # whole tolerance band
            assert detect_splits(flat_then_jump(r, volume_at_jump=900_000)) == [], (num, den, r)
    # 2/3 itself (a 1:2 bonus) is not detected ...
    assert detect_splits(flat_then_jump(2 / 3, volume_at_jump=900_000)) == []
    # ... only the sliver 0.6467..0.65 of its tolerance band passes the 0.35 trigger
    [det] = detect_splits(flat_then_jump(0.648, volume_at_jump=900_000))
    assert (det.ratio_num, det.ratio_den) == (2, 3)
    # lowering the trigger makes 3/4 reachable: the test fails loudly if defaults change
    lowered = DetectorConfig(trigger=0.20)
    assert len(detect_splits(flat_then_jump(0.75, volume_at_jump=900_000), lowered)) == 1
    assert CFG.trigger == 0.35 and CFG.tolerance == 0.03 and CFG.volume_multiple == 1.5


# --------------------------------------------------------------------------- D-T volume window
def test_dt_volume_average_is_the_prior_20_bars_excluding_day_t() -> None:
    # prior 20 bars average 100; day t volume 152: 1.52x excluding t, but only 1.48x if t were in
    bars = flat_then_jump(0.5, volume_at_jump=152, n_before=25)
    bars = [Bar(b.trade_date, b.close, 100 if b.volume == 100_000 else b.volume) for b in bars]
    assert len(detect_splits(bars)) == 1
    # a spike older than 20 bars before t is outside the window and does not inflate the average
    old = list(bars)
    old[2] = Bar(old[2].trade_date, old[2].close, 1_000_000)  # 23 bars before t
    assert len(detect_splits(old)) == 1
    # but one inside the window does
    inside = list(bars)
    inside[10] = Bar(inside[10].trade_date, inside[10].close, 1_000_000)
    assert detect_splits(inside) == []


def test_zero_volume_history_is_not_a_spike() -> None:
    bars = [
        Bar(b.trade_date, b.close, 0 if b.volume == 100_000 else 500)
        for b in flat_then_jump(0.5, volume_at_jump=500)
    ]
    assert detect_splits(bars) == []


# --------------------------------------------------------------------------- ACT-15 soft flag
def test_act15_soft_flag_for_drop_the_trigger_did_not_flag() -> None:
    bonus = make_series(60, jumps={40: (2 / 3, 3.0)})  # 1:2 bonus: invisible to the 0.35 trigger
    assert detect_splits(bonus) == []
    [flag] = soft_drop_flags(bonus)
    assert flag.flag_type == FLAG_LARGE_DROP and flag.trade_date == bonus[40].trade_date
    assert flag.change_pct == pytest.approx(-33.3, abs=1.5)
    crash = make_series(60, jumps={40: (0.6, 1.0)})  # real crash, quiet volume
    assert [f.trade_date for f in soft_drop_flags(crash)] == [crash[40].trade_date]


def test_act15_drop_under_20_percent_raises_nothing() -> None:
    assert soft_drop_flags(flat_then_jump(0.81, volume_at_jump=900_000)) == []
    assert len(soft_drop_flags(flat_then_jump(0.80, volume_at_jump=900_000))) == 1
    assert soft_drop_flags(flat_then_jump(1.5, volume_at_jump=900_000)) == []  # rises never flag


def test_act15_a_detected_date_does_not_also_get_the_soft_flag() -> None:
    bars = make_series(60, jumps={40: (0.5, 3.0)})
    dets = detect_splits(bars)
    assert len(dets) == 1
    assert soft_drop_flags(bars, [d.ex_date for d in dets]) == []


# --------------------------------------------------------------------------- BRK-19 / BRK-18
def test_brk19_duplicate_candles_are_collapsed_and_counts_are_stable() -> None:
    bars = make_series(60, jumps={40: (0.5, 3.0)})
    doubled = bars + bars[30:50]  # the same days delivered twice
    assert normalize_bars(doubled) == bars
    assert len(detect_splits(doubled)) == len(detect_splits(bars)) == 1
    # the last delivery of a date wins, like an upsert
    revised = bars + [Bar(bars[10].trade_date, 1.0, 1)]
    assert normalize_bars(revised)[10].close == 1.0


def test_brk18_market_date_is_ist_not_utc() -> None:
    # 2026-10-16 18:29 UTC is still 16 Oct 23:59 IST; one minute later it is 17 Oct IST
    assert ist_date(datetime(2026, 10, 16, 18, 29, tzinfo=UTC)) == date(2026, 10, 16)
    assert ist_date(datetime(2026, 10, 16, 18, 30, tzinfo=UTC)) == date(2026, 10, 17)
    assert ist_date(datetime(2026, 10, 17, 0, 0, tzinfo=UTC)) == date(2026, 10, 17)
    assert ist_today(datetime(2026, 12, 31, 20, 0, tzinfo=UTC)) == date(2027, 1, 1)
    assert ist_date(datetime(2026, 10, 16, 18, 30)) == date(2026, 10, 17)  # naive = UTC


# --------------------------------------------------------------------------- multipliers / factors
def test_act05_bonus_and_split_multipliers() -> None:
    d = Decimal
    assert qty_multiplier("bonus", d(1), d(1)) == 2  # 1:1
    assert qty_multiplier("bonus", d(1), d(2)) == d("1.5")  # 1:2
    assert qty_multiplier("split", d(10), d(2)) == 5
    for kind in ("rights", "buyback", "merger", "demerger", "dividend", "other", "split_or_bonus"):
        assert qty_multiplier(kind, d(1), d(2)) is None  # ACT-08: never auto-applied
    assert qty_multiplier("split", None, d(2)) is None
    assert qty_multiplier("split", d(10), d(0)) is None


def test_act03_adjustment_factors_and_src_adjusted_rule() -> None:
    d = Decimal
    steps = adjustment_steps([(date(2026, 2, 10), d(5))], as_of=date(2026, 6, 1))
    assert adj_close(1000.0, date(2026, 2, 9), False, steps) == pytest.approx(200.0)
    assert adj_close(204.0, date(2026, 2, 10), False, steps) == 204.0  # ex-date bar unchanged
    assert adj_close(1000.0, date(2026, 2, 9), True, steps) == 1000.0  # ACT-12: never twice


def test_act03_two_actions_compose_and_same_day_actions_combine() -> None:
    d = Decimal
    actions = [(date(2026, 3, 1), d(2)), (date(2026, 2, 1), d(5)), (date(2026, 3, 1), d(2))]
    steps = adjustment_steps(actions, as_of=date(2026, 12, 31))
    assert [s[0] for s in steps] == [date(2026, 2, 1), date(2026, 3, 1)]
    assert adj_close(100.0, date(2026, 1, 15), False, steps) == pytest.approx(100 / 20)
    assert adj_close(100.0, date(2026, 2, 15), False, steps) == pytest.approx(100 / 4)
    assert adj_close(100.0, date(2026, 3, 1), False, steps) == 100.0


def test_act10_future_ex_date_is_not_applied() -> None:
    steps = adjustment_steps([(date(2026, 11, 1), Decimal(2))], as_of=date(2026, 10, 17))
    assert steps == []
    assert adj_close(100.0, date(2026, 10, 1), False, steps) == 100.0
    on_day = adjustment_steps([(date(2026, 10, 17), Decimal(2))], as_of=date(2026, 10, 17))
    assert len(on_day) == 1  # ex_date <= as_of applies


# --------------------------------------------------------------------------- D03 review fixes
def test_act20_suspect_bars_are_excluded_from_the_volume_average() -> None:
    # 10 spiky bars inside the prior window would inflate the average to ~5.5M and hide the split.
    def bars(suspect: bool) -> list[Bar]:
        out = flat_then_jump(0.5, volume_at_jump=300_000, n_before=40)
        return [
            Bar(b.trade_date, b.close, 10_000_000, b.src_adjusted, suspect)
            if 20 <= i < 30
            else Bar(b.trade_date, b.close, b.volume, b.src_adjusted, False)
            for i, b in enumerate(out)
        ]

    assert detect_splits(bars(suspect=False), CFG) == []  # the spikes count as ordinary volume
    [det] = detect_splits(bars(suspect=True), CFG)  # flagged suspect: skipped, 20 clean bars remain
    assert (det.ratio_num, det.ratio_den) == (1, 2)


def test_act20_fewer_than_20_clean_prior_bars_means_no_detection() -> None:
    out = flat_then_jump(0.5, volume_at_jump=300_000, n_before=25)
    flagged = [Bar(b.trade_date, b.close, b.volume, False, i < 10) for i, b in enumerate(out)]
    assert detect_splits(flagged, CFG) == []  # only 15 non-suspect prior bars


def test_act20_the_suspect_split_day_bar_itself_is_still_detected() -> None:
    # docs/01 3.5: a >50% day-over-day change marks the bar suspect AND triggers detection (1/3).
    out = flat_then_jump(1 / 3, volume_at_jump=300_000)
    out = [Bar(b.trade_date, b.close, b.volume, False, i == 30) for i, b in enumerate(out)]
    [det] = detect_splits(out, CFG)
    assert (det.ratio_num, det.ratio_den) == (1, 3)


def test_act21_a_multi_month_hole_before_the_jump_is_flagged_low_confidence() -> None:
    days = trading_days(200)
    before = [Bar(d, 1000.0, 100_000) for d in days[:30]]
    after = [Bar(d, 500.0, 300_000 if d == days[170] else 100_000) for d in days[170:175]]
    [gap] = detect_splits(before + after, CFG)  # trigger unchanged: still a candidate
    assert gap.low_confidence is True
    [tight] = detect_splits(flat_then_jump(0.5, volume_at_jump=300_000), CFG)
    assert tight.low_confidence is False
