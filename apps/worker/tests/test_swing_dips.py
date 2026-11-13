"""SWD-W rows (docs/07; golden vectors SW1-SW7 of docs/05 12.13). Windows are arguments."""

from __future__ import annotations

import inspect
import json
import logging
import math
import re
from dataclasses import replace
from datetime import date, timedelta
from typing import Any

import numpy as np
import pytest

from worker.analytics import investing as inv
from worker.analytics import snapshot as snap
from worker.analytics import swing_dips as swd
from worker.analytics.inv_common import InvSettings

S = InvSettings()


def make_bars(n: int) -> snap.Bars:
    """Deterministic weekday bars (a random walk)."""
    rng = np.random.default_rng(42)
    close = 100 * np.cumprod(1 + rng.normal(0.0003, 0.01, n))
    dates: list[date] = []
    d = date(2024, 1, 1)
    while len(dates) < n:
        if d.weekday() < 5:
            dates.append(d)
        d += timedelta(days=1)
    return snap.Bars(
        dates=dates,
        close=close,
        adj_close=close,
        high=close * 1.01,
        low=close * 0.99,
        volume=rng.integers(100_000, 900_000, n).astype(np.float64),
    )


# The vectors of docs/05 12.13 (W = window used by the vector). SW1 is padded with 7 flat rows so a
# window of 10 rows does not change the three dips the unpadded series would show.
SW1 = [100.0] * 7 + [100, 100, 100, 95, 88, 92, 85, 99, 100, 104, 93, 92, 105, 94, 96]
SW1_W = 10
SW2 = [100.0] * 10 + [80, 70, 60, 65, 50, 55]
SW2_W = 10
SW3 = [100, 80, 70, 60, 65, 50, 55]
SW5 = [100, 88, 95, 80, 90, 70, 77, 60, 66, 50]  # also SW4 for the zig-zag rule
SW7 = [100, 80, 70, 60, 85, 84]


def days(n: int, start: date = date(2024, 1, 1)) -> list[date]:
    return [start + timedelta(days=i) for i in range(n)]


def run(
    closes: list[float], w: int = 3, settings: InvSettings = S, dates: list[date] | None = None
) -> dict[str, Any]:
    c = np.array(closes, dtype=np.float64)
    return swd.swing_dips(dates or days(len(c)), c, settings, w52=w)


def row(block: dict[str, Any], x: int) -> dict[str, Any]:
    return next(r for r in block["thresholds"] if r["threshold_pct"] == x)


def leg(block: dict[str, Any], x: int) -> dict[str, Any]:
    return next(r for r in block["zigzag"] if r["threshold_pct"] == x)


def test_swd_w01_sw1_records() -> None:
    r = row(run(SW1, SW1_W), 10)
    assert (r["dips"], r["recovered"], r["superseded"], r["open"]) == (3, 2, 0, 1)
    d3, d2, d1 = r["records"]  # newest first
    assert d1["peak_date"] == "2024-01-10" and d1["peak_close"] == 100.0
    assert d1["low_date"] == "2024-01-14"
    assert d1["low_close"] == 85.0 and d1["depth_pct"] == -15.0  # a second fall under one peak
    assert (d1["days_peak_to_low"], d1["recovery_date"], d1["days_low_to_recovery"]) == (
        4,
        "2024-01-16",
        2,
    )
    assert (
        d1["status"] == "recovered" and "days_low_to_recovery_reason" not in d1
    )  # status explains
    assert d2["peak_date"] == "2024-01-17" and d2["depth_pct"] == pytest.approx(-11.5385, abs=1e-4)
    assert (d2["days_peak_to_low"], d2["days_low_to_recovery"]) == (2, 1)
    assert d3["status"] == "open" and d3["depth_pct"] == pytest.approx(-10.4762, abs=1e-4)
    assert d3["recovery_date"] is None and d3["days_low_to_recovery"] is None
    assert d3["days_low_to_recovery_reason"] == "open_dip"


def test_swd_w02_sw1_summary_default_minimum() -> None:
    r = row(run(SW1, SW1_W), 10)
    assert r["recovered_share_pct"] == pytest.approx(66.6667, abs=1e-4)
    assert r["median_depth_pct"] == pytest.approx(-11.5385, abs=1e-4)
    assert r["worst_depth_pct"] == -15.0
    assert r["median_days_peak_to_low"] == 2.0 and r["longest_open_days"] == 2
    assert r["small_sample"] is True
    assert r["median_days_to_recover"] is None
    assert r["median_days_to_recover_reason"] == "too_few_episodes"


def test_swd_w03_completed_only_median() -> None:
    r = row(run(SW1, SW1_W, replace(S, min_episodes=2)), 10)
    assert r["median_days_to_recover"] == 1.5  # the open dip is excluded


def test_swd_w04_no_dip() -> None:
    r = row(run(SW1, SW1_W), 20)
    assert (r["dips"], r["recovered"], r["superseded"], r["open"]) == (0, 0, 0, 0)
    assert r["median_depth_pct"] is None and r["median_depth_reason"] == "too_few_episodes"
    assert r["worst_depth_pct"] is None and r["worst_depth_reason"] == "no_dips"
    assert r["longest_open_days"] is None and r["longest_open_reason"] == "no_open_dip"
    assert r["recovered_share_pct"] is None and r["records"] == []


@pytest.mark.parametrize("x", [10, 20])
def test_swd_w05_sw2_never_recovers_peak_still_in_window(x: int) -> None:
    r = row(run(SW2, SW2_W), x)
    assert (r["dips"], r["recovered"], r["superseded"], r["open"]) == (1, 0, 0, 1)
    (rec,) = r["records"]
    assert rec["peak_date"] == "2024-01-10"
    assert rec["low_date"] == "2024-01-15" and rec["depth_pct"] == -50.0
    assert rec["days_peak_to_low"] == 5 and rec["status"] == "open"
    assert r["longest_open_days"] == 6 and r["worst_depth_pct"] == -50.0
    assert r["median_depth_pct"] is None and r["median_days_to_recover"] is None


@pytest.mark.parametrize("x", [10, 20])
def test_swd_w05b_sw3_start_at_first_window_then_superseded(x: int) -> None:
    # w = 3: the fall began at row 1 but is only seen at row 2; its peak (row 0) leaves the
    # window at row 3 and the dip is superseded; each new window high starts a new dip.
    r = row(run(SW3), x)
    assert (r["dips"], r["recovered"], r["superseded"], r["open"]) == (3, 0, 2, 1)
    d3, d2, d1 = r["records"]
    assert (d1["status"], d1["peak_date"]) == (
        "superseded",
        "2024-01-01",
    )
    assert (d1["low_date"], d1["depth_pct"], d1["days_peak_to_low"]) == ("2024-01-04", -40.0, 3)
    assert d1["recovery_date"] is None and d1["days_low_to_recovery_reason"] == "superseded"
    assert (d2["status"], d2["peak_close"], d2["depth_pct"]) == ("superseded", 80.0, -25.0)
    assert (d3["status"], d3["peak_close"]) == ("open", 65.0)
    assert d3["depth_pct"] == pytest.approx(-23.0769, abs=1e-4)
    assert r["median_depth_pct"] == -25.0 and r["worst_depth_pct"] == -40.0
    assert r["median_days_peak_to_low"] == 2.0 and r["longest_open_days"] == 2
    assert r["recovered_share_pct"] == 0.0 and r["median_days_to_recover"] is None


def test_swd_w06_fall_recovered_before_window_is_not_seen() -> None:
    assert row(run([100, 80, 100, 100]), 10)["dips"] == 0


def test_swd_w07_insufficient_history() -> None:
    b = run([100, 90], w=3)
    for r in b["thresholds"]:
        assert r["reason"] == "insufficient_history" and r["dips"] is None
        assert r["records"] == [] and r["worst_depth_reason"] == "insufficient_history"
    assert leg(b, 10)["legs"] == 1  # the swings need only 2 rows
    one = swd.swing_dips(days(1), np.array([100.0]), S, w52=3)
    assert all(r["reason"] == "insufficient_history" and r["legs"] is None for r in one["zigzag"])


def test_swd_w08_tolerance_and_equal_recovery() -> None:
    r = row(run([100, 90], w=2), 10)
    assert r["dips"] == 1 and r["records"][0]["depth_pct"] == -10.0
    again = row(run([100, 90, 100], w=2), 10)  # a close equal to the reference high recovers
    assert again["recovered"] == 1 and again["open"] == 0


def test_swd_w09_ties() -> None:
    # Equal highs: the peak is the latest; equal lows: the earliest low is kept.
    rec = row(run([100, 100, 100, 80, 80, 90, 100], w=4), 10)["records"][0]
    assert rec["peak_date"] == "2024-01-03" and rec["low_date"] == "2024-01-04"
    assert rec["status"] == "recovered" and rec["recovery_date"] == "2024-01-07"


def test_swd_w10_records_limit_and_order() -> None:
    closes: list[float] = [100, 100]
    for _ in range(12):  # twelve separate 15% dips, each recovered
        closes += [85, 100]
    r = row(run(closes, w=2), 10)
    assert r["dips"] == 12 and r["recovered"] == 12 and len(r["records"]) == 8
    starts = [x["low_date"] for x in r["records"]]
    assert starts == sorted(starts, reverse=True)
    assert r["recovered_share_pct"] == 100.0 and r["small_sample"] is False
    assert r["median_days_to_recover"] == 1.0


def test_swd_w11_sw5_long_decline_many_superseded_dips() -> None:
    b = run(SW5)
    a10, a20 = row(b, 10), row(b, 20)
    assert (a10["dips"], a10["recovered"], a10["superseded"], a10["open"]) == (4, 0, 3, 1)
    assert [x["status"] for x in a10["records"]] == [
        "open",
        "superseded",
        "superseded",
        "superseded",
    ]
    assert [x["peak_close"] for x in a10["records"]] == [66.0, 77.0, 90.0, 95.0]
    assert a10["median_depth_pct"] == pytest.approx(-29.8246, abs=1e-4)
    assert a10["worst_depth_pct"] == pytest.approx(-35.0649, abs=1e-4)
    assert a10["median_days_peak_to_low"] == 3.0 and a10["longest_open_days"] == 1
    assert a10["recovered_share_pct"] == 0.0
    assert (a20["dips"], a20["superseded"], a20["open"]) == (3, 2, 1)
    assert a20["median_depth_pct"] == pytest.approx(-33.3333, abs=1e-4)
    assert a20["worst_depth_pct"] == pytest.approx(-35.0649, abs=1e-4)


def test_swd_w11b_new_dip_under_new_window_high_and_recovery_of_the_new_peak() -> None:
    # SW7: dip A (ref 100) is superseded at row 3; the window high 80 starts dip B at the same
    # row; B regains 80 at row 4. A mutant that drops the supersession, or tests recovery against
    # anything but the dip's own reference high, changes these records.
    r = row(run(SW7), 10)
    assert (r["dips"], r["recovered"], r["superseded"], r["open"]) == (2, 1, 1, 0)
    b, a = r["records"]
    assert (a["status"], a["peak_close"], a["low_close"]) == ("superseded", 100.0, 60.0)
    assert (b["status"], b["peak_close"], b["recovery_date"]) == ("recovered", 80.0, "2024-01-05")
    assert b["days_low_to_recovery"] == 1 and b["depth_pct"] == -25.0


def test_swd_w11c_supersession_boundary_order_and_weekend_gap() -> None:
    # The peak (row 1) leaves the 3-row window at row 4 = peak + w. A close >= ref at that very
    # row recovers the dip (recovery is tested first); one below it supersedes it.
    ds = [date(2024, 1, 3) + timedelta(days=i) for i in (0, 1, 2, 5, 6)]  # Wed..Fri, Mon, Tue
    rec = row(swd.swing_dips(ds, np.array([100, 100, 85, 90, 100.0]), S, w52=3), 10)
    (d,) = rec["records"]
    assert d["status"] == "recovered" and d["recovery_date"] == "2024-01-09"
    # weekend gap: calendar days between bar dates (Fri 01-05 low, Tue 01-09 recovery)
    assert d["days_peak_to_low"] == 1 and d["days_low_to_recovery"] == 4
    late = row(swd.swing_dips(ds, np.array([100, 100, 85, 90, 99.0]), S, w52=3), 10)
    assert late["records"][0]["status"] == "superseded"
    assert late["records"][0]["low_date"] == "2024-01-05"


def test_swd_w12_sw4_rule_b_swings() -> None:
    z = leg(run(SW5), 10)
    assert (z["legs"], z["bounced"], z["open"]) == (4, 3, 1)
    assert z["median_depth_pct"] == pytest.approx(-22.1501, abs=1e-4)
    assert z["worst_depth_pct"] == pytest.approx(-24.2424, abs=1e-4)
    assert z["median_days_peak_to_low"] == 1.0 and z["median_days_to_bounce"] == 1.0
    assert z["small_sample"] is True


def test_swd_w13_rule_b_other_vectors() -> None:
    z20 = leg(run(SW5), 20)
    assert (z20["legs"], z20["open"], z20["worst_depth_pct"]) == (1, 1, -50.0)
    assert z20["median_depth_pct"] is None
    z1 = leg(run(SW1, SW1_W), 10)
    assert (z1["legs"], z1["bounced"], z1["open"]) == (3, 2, 1)
    assert z1["median_days_to_bounce"] is None
    assert z1["median_days_to_bounce_reason"] == "too_few_episodes"
    z1b = leg(run(SW1, SW1_W, replace(S, min_episodes=2)), 10)
    assert z1b["median_days_to_bounce"] == 1.0
    assert leg(run(SW1, SW1_W), 20)["legs"] == 0


def _floats(o: Any) -> list[float]:
    if isinstance(o, float):
        return [o]
    if isinstance(o, dict):
        return [f for v in o.values() for f in _floats(v)]
    if isinstance(o, list):
        return [f for v in o for f in _floats(v)]
    return []


def test_swd_w14_units_and_json_safety() -> None:
    for closes, w in ((SW1, SW1_W), (SW5, 3), (SW3, 3), ([100.0] * 10, 3)):
        b = run(closes, w)
        json.dumps(b, allow_nan=False)  # NaN / Infinity raise
        fl = _floats(b)
        assert all(math.isfinite(f) for f in fl) and (fl or closes[0] == closes[-1])
        assert not any(f == 0 and math.copysign(1, f) < 0 for f in fl)  # no -0.0 anywhere
    assert row(run([100.0] * 10, 3), 10)["dips"] == 0  # a flat stock has no dip


def test_swd_w14b_null_reasons_are_omitted() -> None:
    def walk(o: Any) -> list[str]:
        bad: list[str] = []
        if isinstance(o, dict):
            for k, v in o.items():
                if v is None and k.endswith("reason"):
                    bad.append(k)
                bad += walk(v)
        elif isinstance(o, list):
            for v in o:
                bad += walk(v)
        return bad

    assert walk(run(SW1, SW1_W)) == [] and walk(run(SW5)) == []
    assert "start_close" not in run(SW1, SW1_W)["thresholds"][0]["records"][0]


def test_swd_w14c_invariants_on_random_walks() -> None:
    # A second shape: noisy series. The counts add up, at most one dip is open and every dip and
    # swing is at least X deep.
    for seed in range(6):
        rng = np.random.default_rng(seed)
        c = 100 * np.cumprod(1 + rng.normal(0, 0.03, 700))
        b = swd.swing_dips(days(700), c, S, w52=60)
        for r in b["thresholds"]:
            assert r["dips"] == r["recovered"] + r["superseded"] + r["open"]
            assert r["open"] in (0, 1)
            assert all(x["depth_pct"] <= -r["threshold_pct"] + 1e-6 for x in r["records"])
            assert [x["status"] for x in r["records"][1:]].count("open") == 0
        for z in b["zigzag"]:
            assert z["legs"] == z["bounced"] + z["open"] and z["open"] in (0, 1)
            assert z["worst_depth_pct"] <= -z["threshold_pct"] + 1e-6


def test_swd_w15_failure_is_isolated_and_logged_without_the_message(
    monkeypatch: pytest.MonkeyPatch, caplog: Any
) -> None:
    def boom(*_a: Any, **_k: Any) -> dict[str, Any]:
        raise ValueError("secret-token-123")

    raise_line = inspect.getsourcelines(boom)[1] + 1
    monkeypatch.setattr(swd, "swing_dips", boom)
    with caplog.at_level(logging.WARNING, logger="worker.swing_dips"):
        block, reason = swd.swing_dips_safe(days(3), np.array([1.0, 2.0, 3.0]), S, "ABC")
    assert block is None and reason == "compute_error"
    assert "symbol=ABC" in caplog.text and "bars=3" in caplog.text and "ValueError" in caplog.text
    assert f"test_swing_dips.py:{raise_line}" in caplog.text  # the innermost frame
    assert "secret-token-123" not in caplog.text

    out = snap.build_snapshot(make_bars(400), symbol="ABC")
    assert out is not None and out["analysis"]["swing_dips"] is None
    assert out["analysis"]["swing_dips_reason"] == "compute_error"
    assert out["analysis"]["drawdown_profile"]["bars"] == 400  # the rest stands


def test_swd_w16_drawdown_profile_unchanged() -> None:
    # A literal result for the VD1 vector of docs/05 12.4 (the profile is untouched by this block).
    vd1 = [100, 90, 80, 85, 100, 95, 100, 110, 99, 88, 99, 110, 105]
    p = inv.drawdown_profile(days(13), np.array(vd1, dtype=np.float64), replace(S, min_episodes=2))
    assert p["current_dd_pct"] == pytest.approx(-4.5455, abs=1e-4)
    assert p["days_since_high"] == 1 and p["episodes_total"] == 4
    assert p["time_under_water_pct"] == pytest.approx(61.5385, abs=1e-4)
    assert p["avg_underwater_depth_pct"] == pytest.approx(-11.8182, abs=1e-4)
    assert p["max_dd"]["depth_pct"] == -20.0 and p["max_dd"]["trough_date"] == "2024-01-03"
    assert [r["median_days"] for r in p["recovery"]] == [3.0, 2.0]
    assert set(p) == {
        "as_of",
        "bars",
        "first_date",
        "current_dd_pct",
        "days_since_high",
        "max_dd",
        "underwater_rows",
        "time_under_water_pct",
        "avg_underwater_depth_pct",
        "avg_underwater_depth_reason",
        "episodes_total",
        "recovery",
    }
    bars = make_bars(400)
    full = snap.build_snapshot(bars)
    assert full is not None
    assert full["analysis"]["drawdown_profile"] == inv.drawdown_profile(
        bars.dates, bars.adj_close, S
    )


def test_swd_w17_snapshot_wiring_and_realistic_size() -> None:
    out = snap.build_snapshot(make_bars(6500))  # about 26 years of daily bars
    assert out is not None
    a = out["analysis"]
    b = a["swing_dips"]
    assert "swing_dips_reason" not in a  # a null reason is omitted
    assert b["window_rows"] == 252 and b["bars"] == 6500 and b["min_episodes"] == 3
    assert [r["threshold_pct"] for r in b["thresholds"]] == [10, 20]
    assert [r["threshold_pct"] for r in b["zigzag"]] == [10, 20]
    assert len(json.dumps(b)) < 7_000
    assert len(json.dumps(out)) < 250_000  # the whole stored indicators value (RET-89)
    json.dumps(a, allow_nan=False)
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", b["as_of"])
