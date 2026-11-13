"""RST-I, RST-P and RST-B rows (docs/07): relative strength against the NIFTY50 and sector peers
(docs/05 12.14; golden vectors RA1-RA3 and RP1-RP3, hand computed). Pure: no database, no clock."""

from __future__ import annotations

import json
import logging
import math
from datetime import date, timedelta
from typing import Any

import numpy as np
import pytest

from worker.analytics import relative_strength as rst
from worker.analytics.inv_common import F64, PeerData, median
from worker.analytics.snapshot import Bars, build_snapshot

D = date
START = D(2024, 1, 1)


def arr(*v: float) -> F64:
    return np.array(v, dtype=np.float64)


def days(n: int, start: date = START) -> list[date]:
    return [start + timedelta(days=i) for i in range(n)]


def approx(v: float | None, expected: float) -> None:
    assert v is not None and v == pytest.approx(expected, abs=1e-4)


# RA1: stock 01-01, 01-02, 01-03, 01-05, 01-06; index 01-01, 01-02, 01-04, 01-05, 01-06, 01-08
RA1_D = [D(2024, 1, 1), D(2024, 1, 2), D(2024, 1, 3), D(2024, 1, 5), D(2024, 1, 6)]
RA1_C = arr(100, 110, 105, 121, 99)
RA1_IDX = {
    D(2024, 1, 1): 1000.0,
    D(2024, 1, 2): 1100.0,
    D(2024, 1, 4): 1050.0,
    D(2024, 1, 5): 1210.0,
    D(2024, 1, 6): 1100.0,
    D(2024, 1, 8): 1200.0,
}
RA1_WINDOWS = (("w1", 1), ("w2", 2), ("w3", 3), ("w4", 4), ("w6", 6))


def ra1() -> dict[str, Any]:
    block, reason = rst.vs_index(RA1_D, RA1_C, RA1_IDX, RA1_D, windows=RA1_WINDOWS, min_aligned=2)
    assert reason is None and block is not None
    return block


# ---------------------------------------------------------------- RST-I
def test_rst_i01_ra1_alignment_and_dropped_dates() -> None:
    b = ra1()
    assert b["aligned_rows"] == 4
    assert b["dropped_stock_dates"] == 1  # 01-03
    assert b["dropped_index_dates"] == 1  # 01-04; 01-08 is outside the stock's span
    assert (b["first_aligned"], b["last_aligned"]) == ("2024-01-01", "2024-01-06")
    assert (
        b["index_code"] == "NIFTY50" and b["index_rows"] == 6 and b["index_as_of"] == "2024-01-08"
    )


def test_rst_i02_i03_ra1_windows_and_limits() -> None:
    rows = {r["key"]: r for r in ra1()["windows"]}
    approx(rows["w1"]["stock_pct"], -18.1818)
    approx(rows["w1"]["index_pct"], -9.0909)
    approx(rows["w1"]["excess_pp"], -9.0909)
    approx(rows["w2"]["excess_pp"], -10.0)
    approx(rows["w3"]["stock_pct"], -1.0)
    approx(rows["w3"]["index_pct"], 10.0)
    approx(rows["w3"]["excess_pp"], -11.0)
    assert rows["w4"]["reason"] == "insufficient_overlap" and rows["w4"]["excess_pp"] is None
    assert rows["w6"]["reason"] == "insufficient_history" and rows["w6"]["stock_pct"] is None
    assert rows["w1"]["reason"] is None


def test_rst_i04_ra1_rebased_ratio_is_aligned_to_the_stock_dates() -> None:
    b = ra1()
    assert b["ratio_rebased"] == [100.0, 100.0, None, 100.0, 90.0]
    assert b["ratio_base_date"] == "2024-01-01" and b["ratio_reason"] is None
    # the chart window starts later: the base is its first aligned row, not the first bar
    block, _ = rst.vs_index(RA1_D, RA1_C, RA1_IDX, RA1_D[3:], windows=RA1_WINDOWS, min_aligned=2)
    assert block is not None
    assert block["ratio_rebased"] == [100.0, 90.0]
    # one aligned row in the window: no line, with the reason
    block, _ = rst.vs_index(RA1_D, RA1_C, RA1_IDX, RA1_D[4:], windows=RA1_WINDOWS, min_aligned=2)
    assert block is not None
    assert block["ratio_rebased"] is None and block["ratio_reason"] == "insufficient_overlap"


def ra2(rows: int, min_windows: int = 4) -> dict[str, Any]:
    stock = arr(100, 95, 90, 100, 110, 120, 126, 132)[:rows]
    d = days(rows)
    idx = dict.fromkeys(d, 100.0)
    al = rst.align(d, stock, idx)
    return rst.rolling_year(al, w=2, min_windows=min_windows)


def test_rst_i05_ra2_a_stock_that_lags_then_leads() -> None:
    r = ra2(8)
    assert r["windows"] == 6 and r["independent_periods"] == 3 and r["small_sample"] is False
    approx(r["share_beat_pct"], 83.3333)
    approx(r["median_excess_pp"], 12.2727)
    assert r["reason"] is None


def test_rst_i06_ra2_short_history_small_sample_and_too_few_windows() -> None:
    r = ra2(6)
    assert r["windows"] == 4 and r["independent_periods"] == 2 and r["small_sample"] is True
    approx(r["share_beat_pct"], 75.0)
    hidden = ra2(6, min_windows=5)
    assert hidden["share_beat_pct"] is None and hidden["reason"] == "too_few_windows"
    assert hidden["windows"] == 4  # the count stays visible


def test_rst_i07_a_tie_is_not_a_win() -> None:
    d = days(8)
    c = arr(100, 101, 103, 102, 105, 104, 107, 110)
    al = rst.align(d, c, dict(zip(d, c.tolist(), strict=True)))  # the index equals the stock
    r = rst.rolling_year(al, w=2, min_windows=4)
    assert r["windows"] == 6 and r["share_beat_pct"] == 0.0 and r["median_excess_pp"] == 0.0


def synthetic(n: int, m: int) -> tuple[list[date], F64, dict[date, float]]:
    d = days(n)
    c = 100 * 1.002 ** np.arange(n)
    idx = {d[n - m + i]: float(100 * 1.001**i) for i in range(m)}  # index covers the last m days
    return d, c, idx


def test_rst_i08_short_index_and_missing_index() -> None:
    d, c, idx = synthetic(300, 10)
    assert rst.vs_index(d, c, idx, d[-50:]) == (None, "no_index_series")
    assert rst.vs_index(d, c, {}, d[-50:]) == (None, "no_index_series")
    assert rst.vs_index(d, c, {d[0]: float("nan"), d[1]: 0.0, d[2]: -3.0}, d) == (
        None,
        "no_index_series",
    )
    d, c, idx = synthetic(300, 100)
    block, reason = rst.vs_index(d, c, idx, d[-50:])
    assert reason is None and block is not None and block["aligned_rows"] == 100
    rows = {r["key"]: r for r in block["windows"]}
    assert rows["1m"]["reason"] is None and rows["3m"]["reason"] is None
    assert rows["6m"]["reason"] == "insufficient_overlap"
    assert rows["1y"]["reason"] == "insufficient_overlap" and rows["1y"]["excess_pp"] is None
    # 1M: stock +0.2%/day compounded over 21 days against the index at +0.1%/day (closed form)
    approx(rows["1m"]["excess_pp"], ((1.002**21 - 1) - (1.001**21 - 1)) * 100)
    assert block["rolling_year"]["reason"] == "insufficient_overlap"
    assert block["rolling_year"]["windows"] == 0
    # a stock with under a year of its own bars: its own shortage, not the index's
    d, c, idx = synthetic(200, 200)
    block, _ = rst.vs_index(d, c, idx, d)
    assert block is not None
    assert {r["key"]: r["reason"] for r in block["windows"]}["1y"] == "insufficient_history"


def test_rst_i09_non_finite_index_values_are_not_rows() -> None:
    idx = dict(RA1_IDX)
    idx[D(2024, 1, 3)] = float("nan")  # would align with the stock's 01-03 if it were a row
    idx[D(2024, 1, 7)] = float("inf")
    idx[D(2024, 1, 9)] = -5.0
    block, _ = rst.vs_index(RA1_D, RA1_C, idx, RA1_D, windows=RA1_WINDOWS, min_aligned=2)
    assert block is not None
    assert block["aligned_rows"] == 4 and block["index_rows"] == 6
    assert block["dropped_stock_dates"] == 1 and block["dropped_index_dates"] == 1


def test_rst_i10_calendar_years() -> None:
    # 2022: no previous year (no row); 2023 full; 2024 year to date
    d = [D(2022, 6, 1), D(2022, 12, 30), D(2023, 3, 1), D(2023, 12, 29), D(2024, 2, 15)]
    c = arr(50, 100, 120, 150, 135)
    x = arr(1000, 2000, 2200, 2400, 2640)
    al = rst.align(d, c, dict(zip(d, x.tolist(), strict=True)))
    rows = rst.calendar_years(al)
    assert [r["year"] for r in rows] == [2023, 2024]
    assert [r["kind"] for r in rows] == ["full", "ytd"]
    r23, r24 = rows
    assert (r23["base_date"], r23["end_date"]) == ("2022-12-30", "2023-12-29")
    approx(r23["stock_pct"], 50.0)
    approx(r23["index_pct"], 20.0)
    approx(r23["excess_pp"], 30.0)
    assert (r24["base_date"], r24["end_date"]) == ("2023-12-29", "2024-02-15")
    approx(r24["stock_pct"], -10.0)
    approx(r24["index_pct"], 10.0)
    approx(r24["excess_pp"], -20.0)
    # a year whose previous year has no aligned row has no row
    gap = rst.align(d[2:], c[2:], dict(zip(d, x.tolist(), strict=True)))
    assert [r["year"] for r in rst.calendar_years(gap)] == [2024]
    # at most 10 years
    many = [D(2000 + i, 12, 29) for i in range(15)]
    cm = arr(*[100.0 + i for i in range(15)])
    al15 = rst.align(many, cm, dict.fromkeys(many, 10.0))
    assert len(rst.calendar_years(al15)) == 10


def test_rst_i11_unit_rounding_and_strict_json() -> None:
    d, c, idx = synthetic(400, 400)
    block, _ = rst.vs_index(d, c, idx, d[-100:])
    assert block is not None
    text = json.dumps(block, allow_nan=False)
    assert "-0.0," not in text and "NaN" not in text and "Infinity" not in text
    for row in block["windows"]:
        assert row["excess_pp"] == round(row["excess_pp"], 4)
    assert block["ratio_rebased"][-100] == 100.0 and len(block["ratio_rebased"]) == 100


# ---------------------------------------------------------------- RST-P
def peers_of(returns_by_peer: dict[int, tuple[float, float, float]], w: int = 2) -> PeerData:
    """Peers whose last three closes are (100, 100, 100 * (1 + ret/100)) on ``days(3)``."""
    d = days(3)
    return PeerData(
        sector="Banks",
        closes={pid: (d, arr(a, b, c)) for pid, (a, b, c) in returns_by_peer.items()},
        peers_in_sector=len(returns_by_peer),
    )


W2 = (("w2", 2),)
SELF = arr(100, 100, 110)  # +10.0


def block_p(peers: PeerData | None) -> tuple[dict[str, Any] | None, str | None]:
    return rst.vs_peers(days(3), SELF, peers, windows=W2)


def test_rst_p01_two_peers_are_hidden() -> None:
    b, reason = block_p(peers_of({1: (100, 100, 120), 2: (100, 100, 105)}))
    assert reason is None and b is not None
    row = b["windows"][0]
    assert row["n_peers"] == 2 and row["n_total"] == 3
    assert row["rank"] is None and row["percentile"] is None and row["reason"] == "too_few_peers"
    assert row["peer_median_pct"] is None and row["vs_median_pp"] is None
    approx(row["stock_pct"], 10.0)


def test_rst_p02_three_peers_rank_percentile_median() -> None:
    b, _ = block_p(peers_of({1: (100, 100, 120), 2: (100, 100, 105), 3: (100, 100, 115)}))
    assert b is not None
    row = b["windows"][0]
    assert (row["rank"], row["n_total"], row["n_peers"]) == (3, 4, 3)
    approx(row["percentile"], 37.5)
    approx(row["peer_median_pct"], 15.0)
    approx(row["vs_median_pp"], -5.0)
    assert row["small_sample"] is True and row["reason"] is None
    assert b["sector"] == "Banks" and b["as_of"] == "2024-01-03" and b["excluded"] == 0


def test_rst_p03_a_tie_shares_the_better_rank() -> None:
    b, _ = block_p(peers_of({1: (100, 100, 120), 2: (100, 100, 105), 3: (100, 100, 110)}))
    assert b is not None
    row = b["windows"][0]
    assert row["rank"] == 2
    approx(row["percentile"], 50.0)
    approx(row["peer_median_pct"], 10.0)
    approx(row["vs_median_pp"], 0.0)
    assert median(arr(20, 5, 10)) == 10.0


def test_rst_p04_peers_without_a_bar_on_the_date_or_too_short_are_left_out() -> None:
    p = peers_of({1: (100, 100, 120), 2: (100, 100, 105), 3: (100, 100, 115), 4: (100, 100, 90)})
    d = days(3)
    closes = dict(p.closes)
    closes[4] = (d[:2], arr(100, 100))  # no bar dated on the stock's last date
    closes[5] = (d[2:], arr(110))  # too short for a 2-row window
    b, _ = block_p(
        PeerData(sector="Banks", closes=closes, peers_in_sector=6)  # peer 6 has no prices at all
    )
    assert b is not None
    row = b["windows"][0]
    assert row["n_peers"] == 3 and row["rank"] == 3
    assert b["peers_in_sector"] == 6 and b["excluded"] == 3  # peers 4, 5 and 6


def test_rst_p05_the_stock_itself_is_shorter_than_the_window() -> None:
    d = days(3)
    peers = PeerData(
        sector="Banks",
        closes={i: (d, arr(100, 100, 100 + i)) for i in (1, 2, 3)},
        peers_in_sector=3,
    )
    b, _ = rst.vs_peers(d, SELF, peers, windows=(("w2", 2), ("w5", 5)))
    assert b is not None
    ok, short = b["windows"]
    assert ok["rank"] is not None
    assert short["reason"] == "insufficient_history" and short["stock_pct"] is None
    assert short["rank"] is None


def test_rst_p06_no_sector_and_no_peers() -> None:
    assert block_p(None) == (None, "no_sector")
    assert block_p(PeerData(sector=None)) == (None, "no_sector")
    assert block_p(PeerData(sector="Banks", failed=True)) == (None, "compute_error")
    b, _ = block_p(PeerData(sector="Banks"))
    assert b is not None and b["peers_in_sector"] == 0
    assert b["windows"][0]["reason"] == "too_few_peers" and b["windows"][0]["n_peers"] == 0


def test_rst_p07_peers_are_measured_on_the_stocks_last_bar_date() -> None:
    d = days(5)
    # the peers have two newer bars with wild moves; they must not change the 3-bar result
    newer = {
        1: (d, arr(100, 100, 120, 300, 10)),
        2: (d, arr(100, 100, 105, 50, 400)),
        3: (d, arr(100, 100, 115, 70, 60)),
    }
    b, _ = rst.vs_peers(
        d[:3], SELF, PeerData(sector="Banks", closes=newer, peers_in_sector=3), windows=W2
    )
    assert b is not None
    row = b["windows"][0]
    assert row["rank"] == 3
    approx(row["peer_median_pct"], 15.0)


# ---------------------------------------------------------------- RST-B
def small_inputs() -> tuple[list[date], F64, dict[date, float], PeerData]:
    d, c, idx = synthetic(300, 300)
    peers = PeerData(
        sector="Banks",
        closes={i: (d, 100 * (1.0 + 0.0003 * i) ** np.arange(300)) for i in (1, 2, 3)},
        peers_in_sector=3,
    )
    return d, c, idx, peers


def test_rst_b01_each_half_fails_alone(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    d, c, idx, peers = small_inputs()

    def boom(*_a: Any, **_k: Any) -> Any:
        raise ValueError("secret-price-9999")

    with monkeypatch.context() as m, caplog.at_level(logging.WARNING, "worker.relative_strength"):
        m.setattr(rst, "vs_index", boom)
        out = rst.build(d, c, idx, d[-50:], peers, symbol="AAA")
    assert out["vs_index"] is None and out["vs_index_reason"] == "compute_error"
    assert out["vs_peers"] is not None and out["vs_peers_reason"] is None
    rec = [r for r in caplog.records if r.message == "relative_strength_failed"]
    assert len(rec) == 1 and rec[0].half == "vs_index" and rec[0].symbol == "AAA"  # type: ignore[attr-defined]
    assert rec[0].error == "ValueError"  # type: ignore[attr-defined]
    assert "9999" not in caplog.text

    with monkeypatch.context() as m:
        m.setattr(rst, "vs_peers", boom)
        out = rst.build(d, c, idx, d[-50:], peers)
    assert out["vs_peers"] is None and out["vs_peers_reason"] == "compute_error"
    assert out["vs_index"] is not None and out["vs_index_reason"] is None


def bars_for(n: int) -> Bars:
    d = days(n, D(2022, 1, 3))
    c = 100 * np.cumprod(1 + np.random.default_rng(7).normal(0.0004, 0.01, n))
    return Bars(d, c, c, c * 1.01, c * 0.99, np.full(n, 1e6))


def test_rst_b02_existing_analysis_keys_are_untouched_and_the_snapshot_survives_a_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bars = bars_for(320)
    idx = {d: 1000.0 + i for i, d in enumerate(bars.dates)}
    snap = build_snapshot(bars, idx)
    assert snap is not None
    keys = set(snap["analysis"])
    assert "relative_strength" in keys
    assert snap["analysis"]["relative_strength"]["vs_index"]["aligned_rows"] == 320

    def boom(*_a: Any, **_k: Any) -> Any:
        raise RuntimeError("x")

    with monkeypatch.context() as m:
        m.setattr(rst, "vs_index", boom)
        m.setattr(rst, "vs_peers", boom)
        broken = build_snapshot(bars, idx)
    assert broken is not None  # the snapshot is still produced
    others = {k: v for k, v in snap["analysis"].items() if k != "relative_strength"}
    assert {k: v for k, v in broken["analysis"].items() if k != "relative_strength"} == others
    assert broken["analysis"]["relative_strength"]["vs_index_reason"] == "compute_error"
    json.dumps(snap, allow_nan=False)


def test_rst_b05_deterministic_without_a_clock() -> None:
    d, c, idx, peers = small_inputs()
    a = json.dumps(rst.build(d, c, idx, d[-100:], peers), sort_keys=True)
    b = json.dumps(rst.build(d, c, idx, d[-100:], peers), sort_keys=True)
    assert a == b
    assert math.isfinite(
        rst.build(d, c, idx, d[-100:], peers)["vs_index"]["windows"][0]["excess_pp"]
    )


# ---------------------------------------------------------------- review fixes (S2, S3, S7, N1-N3)
def covered(n: int, m: int) -> tuple[list[date], F64, dict[date, float]]:
    return synthetic(n, m)


def test_rst_i12_real_defaults_at_252_versus_253_aligned_rows() -> None:
    """RST-2: 252 aligned one-day returns need 253 aligned rows (kills the `m > w` mutation)."""
    d, c, idx = covered(300, 252)
    b252, _ = rst.vs_index(d, c, idx, d[-50:], min_windows=1)
    assert b252 is not None
    one_year = {r["key"]: r for r in b252["windows"]}["1y"]
    assert one_year["reason"] == "insufficient_overlap" and one_year["excess_pp"] is None
    assert b252["rolling_year"]["reason"] == "insufficient_overlap"
    assert b252["rolling_year"]["windows"] == 0
    d, c, idx = covered(300, 253)
    b253, _ = rst.vs_index(d, c, idx, d[-50:], min_windows=1)
    assert b253 is not None
    one_year = {r["key"]: r for r in b253["windows"]}["1y"]
    assert one_year["reason"] is None
    approx(one_year["excess_pp"], ((1.002**252 - 1) - (1.001**252 - 1)) * 100)
    assert one_year["base_date"] == d[-253].isoformat()
    assert b253["rolling_year"]["windows"] == 1
    assert b253["rolling_year"]["independent_periods"] == 1
    approx(b253["rolling_year"]["share_beat_pct"], 100.0)
    # the default minimum of 20 windows hides it with the count still shown
    hidden, _ = rst.vs_index(d, c, idx, d[-50:])
    assert hidden is not None and hidden["rolling_year"]["reason"] == "too_few_windows"
    assert hidden["rolling_year"]["windows"] == 1


def test_rst_i13_window_keys_and_row_counts() -> None:
    d, c, idx = covered(400, 400)
    block, _ = rst.vs_index(d, c, idx, d[-50:])
    assert block is not None
    assert [(r["key"], r["rows"]) for r in block["windows"]] == [
        ("1m", 21),
        ("3m", 63),
        ("6m", 126),
        ("1y", 252),
    ]
    assert [r["base_date"] for r in block["windows"]] == [
        d[-1 - w].isoformat() for w in (21, 63, 126, 252)
    ]
    peers, _ = rst.vs_peers(d, c, PeerData(sector="Banks"))
    assert peers is not None
    assert [(r["key"], r["rows"]) for r in peers["windows"]] == [
        ("3m", 63),
        ("6m", 126),
        ("1y", 252),
    ]


def test_rst_i14_min_windows_comes_from_the_setting() -> None:
    from worker.analytics.inv_common import InvContext, InvSettings

    bars = bars_for(262)  # 262 aligned rows: 10 rolling windows
    idx = {d: 1000.0 + i for i, d in enumerate(bars.dates)}
    default = build_snapshot(bars, idx)
    assert default is not None
    roll = default["analysis"]["relative_strength"]["vs_index"]["rolling_year"]
    assert roll["windows"] == 10 and roll["reason"] == "too_few_windows"
    ctx = InvContext(today=bars.dates[-1], settings=InvSettings(min_windows=5))
    lowered = build_snapshot(bars, idx, inv_ctx=ctx)
    assert lowered is not None
    roll = lowered["analysis"]["relative_strength"]["vs_index"]["rolling_year"]
    assert roll["reason"] is None and roll["share_beat_pct"] is not None
    ctx = InvContext(today=bars.dates[-1], settings=InvSettings(min_windows=11))
    raised = build_snapshot(bars, idx, inv_ctx=ctx)
    assert raised is not None
    assert raised["analysis"]["relative_strength"]["vs_index"]["rolling_year"]["reason"] == (
        "too_few_windows"
    )


def test_rst_i15_exact_scalar_multiples_tie() -> None:
    """N1: an index that is an exact multiple of the stock never wins or loses by float noise."""
    rng = np.random.default_rng(3)
    c = 100 * np.cumprod(1 + rng.normal(0.0004, 0.01, 40))
    d = days(40)
    for k in (3.0, 7.3, 0.1, 1234.5678):
        al = rst.align(d, c, dict(zip(d, (c * k).tolist(), strict=True)))
        r = rst.rolling_year(al, w=5, min_windows=4)
        assert r["share_beat_pct"] == 0.0 and r["windows"] == 35


def test_rst_p09_a_peer_with_exactly_w_rows_is_excluded() -> None:
    d = days(3)
    base = {1: (d, arr(100, 100, 120)), 2: (d, arr(100, 100, 105)), 3: (d, arr(100, 100, 115))}
    full = PeerData(sector="Banks", closes={**base}, peers_in_sector=4)
    short = PeerData(
        sector="Banks", closes={**base, 4: (d[1:], arr(100, 90))}, peers_in_sector=4
    )  # exactly w = 2 rows, ends on the stock's last date: no wrap to p_close[-1]
    a, _ = block_p(full)
    b, _ = block_p(short)
    assert a is not None and b is not None
    assert b["windows"][0]["n_peers"] == 3 and b["windows"][0]["rank"] == a["windows"][0]["rank"]
    assert b["excluded"] == 1


def test_rst_p10_no_stock_return_leaves_n_total_null_and_base_date_is_the_stocks() -> None:
    """N2: without a stock return the window has no `n_total`; `n_peers` stays."""
    d = days(3)
    peers = PeerData(
        sector="Banks",
        closes={i: (d, arr(100, 100, 100 + i)) for i in (1, 2, 3)},
        peers_in_sector=3,
    )
    b, _ = rst.vs_peers(d, SELF, peers, windows=(("w2", 2), ("w5", 5)))
    assert b is not None
    ok, short = b["windows"]
    assert ok["base_date"] == d[0].isoformat() and ok["n_total"] == 4
    assert short["n_total"] is None and short["base_date"] is None
    assert short["n_peers"] == 0 and short["reason"] == "insufficient_history"


def test_rst_p11_sector_normalisation_matches_sql_trim() -> None:
    assert rst.norm_sector("  Banks\t") == "Banks"
    assert rst.norm_sector("\u00a0Banks\u00a0\n") == "Banks"
    assert rst.norm_sector(" \t\u00a0") is None and rst.norm_sector(None) is None
    assert rst.norm_sector("Private Banks") == "Private Banks"
