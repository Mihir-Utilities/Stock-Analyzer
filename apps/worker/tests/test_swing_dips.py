"""SWD-W rows (docs/07; golden vectors SW1-SW4 of docs/05 12.13). Windows are arguments."""

from __future__ import annotations

import json
import logging
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


SW1 = [100, 100, 100, 95, 88, 92, 85, 99, 100, 104, 93, 92, 105, 94, 96]
SW2 = [100, 80, 70, 60, 65, 50, 55]
SW4 = [100, 88, 95, 80, 90, 70, 77, 60, 66, 50]


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
    r = row(run(SW1), 10)
    assert (r["dips"], r["recovered"], r["open"]) == (3, 2, 1)
    d3, d2, d1 = r["records"]  # newest first
    assert d1["peak_date"] == "2024-01-03" and d1["peak_close"] == 100.0
    assert d1["start_date"] == "2024-01-05" and d1["low_date"] == "2024-01-07"
    assert d1["low_close"] == 85.0 and d1["depth_pct"] == -15.0
    assert (d1["days_peak_to_low"], d1["recovery_date"], d1["days_low_to_recovery"]) == (
        4,
        "2024-01-09",
        2,
    )
    assert (
        d1["status"] == "recovered" and "days_low_to_recovery_reason" not in d1
    )  # null reasons are omitted
    assert d2["peak_date"] == "2024-01-10" and d2["depth_pct"] == pytest.approx(-11.5385, abs=1e-4)
    assert (d2["days_peak_to_low"], d2["days_low_to_recovery"]) == (2, 1)
    assert d3["status"] == "open" and d3["depth_pct"] == pytest.approx(-10.4762, abs=1e-4)
    assert d3["recovery_date"] is None and d3["days_low_to_recovery"] is None
    assert d3["days_low_to_recovery_reason"] == "open_dip"


def test_swd_w02_sw1_summary_default_minimum() -> None:
    r = row(run(SW1), 10)
    assert r["recovered_share_pct"] == pytest.approx(66.6667, abs=1e-4)
    assert r["median_depth_pct"] == pytest.approx(-11.5385, abs=1e-4)
    assert r["worst_depth_pct"] == -15.0
    assert r["median_days_peak_to_low"] == 2.0 and r["longest_open_days"] == 2
    assert r["small_sample"] is True
    assert r["median_days_to_recover"] is None
    assert r["median_days_to_recover_reason"] == "too_few_episodes"


def test_swd_w03_completed_only_median() -> None:
    r = row(run(SW1, settings=replace(S, min_episodes=2)), 10)
    assert r["median_days_to_recover"] == 1.5


def test_swd_w04_no_dip() -> None:
    r = row(run(SW1), 20)
    assert (r["dips"], r["recovered"], r["open"]) == (0, 0, 0)
    assert r["median_depth_pct"] is None and r["median_depth_reason"] == "too_few_episodes"
    assert r["worst_depth_pct"] is None and r["worst_depth_reason"] == "no_dips"
    assert r["longest_open_days"] is None and r["longest_open_reason"] == "no_open_dip"
    assert r["recovered_share_pct"] is None and r["records"] == []


@pytest.mark.parametrize("x", [10, 20])
def test_swd_w05_sw2_never_recovers(x: int) -> None:
    r = row(run(SW2), x)
    assert (r["dips"], r["recovered"], r["open"]) == (1, 0, 1)
    (rec,) = r["records"]
    assert rec["peak_date"] == "2024-01-01" and rec["start_date"] == "2024-01-03"
    assert rec["low_date"] == "2024-01-06" and rec["depth_pct"] == -50.0
    assert rec["days_peak_to_low"] == 5 and rec["status"] == "open"
    assert r["longest_open_days"] == 6 and r["worst_depth_pct"] == -50.0
    assert r["median_depth_pct"] is None and r["median_days_to_recover"] is None
    assert r["median_days_to_recover_reason"] == "too_few_episodes"


def test_swd_w06_fall_recovered_before_window_is_not_seen() -> None:
    assert row(run([100, 80, 100, 100]), 10)["dips"] == 0


def test_swd_w07_insufficient_history() -> None:
    b = run([100, 90], w=3)
    for r in b["thresholds"]:
        assert r["reason"] == "insufficient_history" and r["dips"] is None
        assert r["records"] == [] and r["worst_depth_reason"] == "insufficient_history"
    assert leg(b, 10)["legs"] == 1  # the swing legs need only 2 rows
    one = swd.swing_dips(days(1), np.array([100.0]), S, w52=3)
    assert all(r["reason"] == "insufficient_history" and r["legs"] is None for r in one["zigzag"])


def test_swd_w08_tolerance_and_equal_recovery() -> None:
    r = row(run([100, 90], w=2), 10)
    assert r["dips"] == 1 and r["records"][0]["depth_pct"] == -10.0
    again = row(run([100, 90, 100], w=2), 10)  # a close equal to the reference high recovers
    assert again["recovered"] == 1 and again["open"] == 0


def test_swd_w09_ties() -> None:
    # Two equal highs: the peak is the latest; two equal lows: the earliest low is kept.
    b = run([100, 100, 80, 80, 90, 100], w=3)
    rec = row(b, 10)["records"][0]
    assert rec["peak_date"] == "2024-01-02" and rec["low_date"] == "2024-01-03"
    assert rec["status"] == "recovered" and rec["recovery_date"] == "2024-01-06"


def test_swd_w10_records_limit_and_order() -> None:
    closes: list[float] = [100, 100]
    for _ in range(12):  # twelve separate 15% dips, each recovered
        closes += [85, 100]
    b = run(closes, w=2)
    r = row(b, 10)
    assert r["dips"] == 12 and r["recovered"] == 12 and len(r["records"]) == 8
    starts = [x["start_date"] for x in r["records"]]
    assert starts == sorted(starts, reverse=True)
    assert r["recovered_share_pct"] == 100.0 and r["small_sample"] is False
    assert r["median_days_to_recover"] == 1.0


def test_swd_w11_sw4_rule_a_long_decline() -> None:
    b = run(SW4)
    a10, a20 = row(b, 10), row(b, 20)
    assert a10["dips"] == 1 and a10["open"] == 1
    assert a10["records"][0]["peak_close"] == 95.0
    assert a10["worst_depth_pct"] == pytest.approx(-47.3684, abs=1e-4)
    assert a10["records"][0]["days_peak_to_low"] == 7 and a10["longest_open_days"] == 7
    assert a20["records"][0]["peak_close"] == 90.0
    assert a20["worst_depth_pct"] == pytest.approx(-44.4444, abs=1e-4)
    assert a20["records"][0]["days_peak_to_low"] == 5


def test_swd_w12_sw4_rule_b_swings() -> None:
    z = leg(run(SW4), 10)
    assert (z["legs"], z["bounced"], z["open"]) == (4, 3, 1)
    assert z["median_depth_pct"] == pytest.approx(-22.1501, abs=1e-4)
    assert z["worst_depth_pct"] == pytest.approx(-24.2424, abs=1e-4)
    assert z["median_days_peak_to_low"] == 1.0 and z["median_days_to_bounce"] == 1.0
    assert z["small_sample"] is True


def test_swd_w13_rule_b_other_vectors() -> None:
    z20 = leg(run(SW4), 20)
    assert (z20["legs"], z20["open"], z20["worst_depth_pct"]) == (1, 1, -50.0)
    assert z20["median_depth_pct"] is None
    z1 = leg(run(SW1), 10)
    assert (z1["legs"], z1["bounced"], z1["open"]) == (3, 2, 1)
    assert z1["median_days_to_bounce"] is None
    assert z1["median_days_to_bounce_reason"] == "too_few_episodes"
    z1b = leg(run(SW1, settings=replace(S, min_episodes=2)), 10)
    assert z1b["median_days_to_bounce"] == 1.0
    assert leg(run(SW1), 20)["legs"] == 0


def test_swd_w14_units_and_json_safety() -> None:
    # A weekend gap counts its calendar days; nothing is NaN, Infinity or -0.0.
    d = [date(2024, 1, 5), date(2024, 1, 8), date(2024, 1, 9), date(2024, 1, 10)]
    b = swd.swing_dips(d, np.array([100.0, 100.0, 85.0, 100.0]), S, w52=2)
    rec = row(b, 10)["records"][0]
    assert rec["days_peak_to_low"] == 1 and rec["days_low_to_recovery"] == 1
    text = json.dumps(run(SW1), allow_nan=False)
    assert "-0.0," not in text and "NaN" not in text
    flat = json.dumps(run([100.0] * 10), allow_nan=False)
    assert row(json.loads(flat), 10)["dips"] == 0  # a flat stock has no dip


def test_swd_w15_failure_is_isolated(monkeypatch: pytest.MonkeyPatch, caplog: Any) -> None:
    def boom(*_a: Any, **_k: Any) -> dict[str, Any]:
        raise ValueError("secret-token-123")

    monkeypatch.setattr(swd, "swing_dips", boom)
    with caplog.at_level(logging.WARNING, logger="worker.swing_dips"):
        block, reason = swd.swing_dips_safe(days(3), np.array([1.0, 2.0, 3.0]), S)
    assert block is None and reason == "compute_error"
    assert "ValueError" in caplog.text and "secret-token-123" not in caplog.text

    out = snap.build_snapshot(make_bars(400))
    assert out is not None and out["analysis"]["swing_dips"] is None
    assert out["analysis"]["swing_dips_reason"] == "compute_error"
    assert out["analysis"]["drawdown_profile"]["bars"] == 400  # the rest stands


def test_swd_w16_drawdown_profile_unchanged() -> None:
    bars = make_bars(400)
    c, d = bars.adj_close, bars.dates
    direct = inv.drawdown_profile(d, c, S)
    out = snap.build_snapshot(bars)
    assert out is not None
    assert out["analysis"]["drawdown_profile"] == direct
    vd1 = [100, 90, 80, 85, 100, 95, 100, 110, 99, 88, 99, 110, 105]
    p = inv.drawdown_profile(days(13), np.array(vd1, dtype=np.float64), replace(S, min_episodes=2))
    assert p["max_dd"]["depth_pct"] == -20.0 and p["recovery"][0]["median_days"] == 3.0


def test_swd_w17_snapshot_wiring_and_size() -> None:
    out = snap.build_snapshot(make_bars(1500))
    assert out is not None
    a = out["analysis"]
    b = a["swing_dips"]
    assert a["swing_dips_reason"] is None and b["window_rows"] == 252 and b["bars"] == 1500
    assert [r["threshold_pct"] for r in b["thresholds"]] == [10, 20]
    assert [r["threshold_pct"] for r in b["zigzag"]] == [10, 20]
    assert len(json.dumps(b)) < 6_000
    json.dumps(a, allow_nan=False)


def test_swd_w14b_null_reasons_are_omitted() -> None:
    # Absent means null (RET-89 size budget): no `reason`/`*_reason` key holds None anywhere.
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

    assert walk(run(SW1)) == [] and walk(run(SW4)) == []
    assert "start_close" not in run(SW1)["thresholds"][0]["records"][0]
