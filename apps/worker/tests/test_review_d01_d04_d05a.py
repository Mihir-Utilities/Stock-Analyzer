"""Review fixes for D01, D04 and D05a (RUNBOOK section "D01/D04/D05a review fixes").

One test per finding; each would have failed before the fix. IDs: MF-110..MF-118, SYS-33..SYS-35,
IND-93, RET-94..RET-96 (docs/07).
"""

from __future__ import annotations

import asyncio
import json
import math
import random
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any

import httpx  # noqa: TID251 - tests build mock transports
import numpy as np
import pytest
from conftest import FakeClock, MemoryHealthStore
from mfmemory import FakeAmfi, FakeMfapi, MemoryMfStore
from test_analysis_snapshot import make_bars, walk

from worker import egress, mf_jobs
from worker.adapters import amfi as amfi_mod
from worker.adapters import mfapi as mfapi_mod
from worker.adapters.amfi import AmfiClient, parse_navall
from worker.adapters.base import (
    SchemaError,
    SourceGuard,
    parse_date_dmon,
    parse_date_dmy,
    parse_nav,
    parse_scheme_code,
)
from worker.adapters.mfapi import MfapiClient, NavPoint, SchemeList
from worker.analytics import indicators as ind
from worker.analytics import mf as mf_analytics
from worker.analytics import returns as rt
from worker.analytics.mf import compute_mf_metrics
from worker.analytics.snapshot import Bars, build_snapshot
from worker.breaker import CircuitBreaker, SourceHealth
from worker.limiter import RateLimiter
from worker.mf_jobs import PgMfStore, run_ingest_mf_navs, run_sync_mf_schemes
from worker.retry import backoff_delay
from worker.runner import JobContext

pytestmark = pytest.mark.anyio

TODAY = date(2026, 10, 10)
HEADER = "Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Net Asset Value;Date"
SECTION = "Open Ended Schemes(Equity Scheme - Large Cap Fund)\nTest Mutual Fund"


def amfi_text(*rows: str) -> str:
    return "\n".join([HEADER, "", SECTION, *rows, ""])


def good_row(code: int = 100001, nav: str = "10.5", day: str = "09-Oct-2026") -> str:
    return f"{code};-;-;Good Fund {code} Direct Growth;{nav};{day}"


# ---------------------------------------------------------------- 1. Sharpe without a leap day
def test_mf110_sharpe_kept_for_a_three_year_series_without_leap_day() -> None:
    end = date(2027, 6, 30)
    start = date(2024, 6, 30)  # 1095 days = 2.998 years: no Feb 29 inside
    assert (end - start).days == 1095
    rng = random.Random(5)
    dates = [start + timedelta(days=i) for i in range(1096)]
    navs, v = [], 100.0
    for _ in dates:
        v *= 1 + rng.gauss(0.0004, 0.006)
        navs.append(v)
    m = compute_mf_metrics(dates, navs)
    assert m is not None and m["returns"]["3y"] is not None  # a base NAV exists at end-36M
    assert m["sharpe_like"] is not None and m["sharpe_reason"] is None
    # ... and still null when no base NAV exists at or before end-36M (history 1 day short)
    short = compute_mf_metrics(dates[1:], navs[1:])
    assert short is not None and short["returns"]["3y"] is None
    assert short["sharpe_like"] is None and short["sharpe_reason"] == "insufficient_history"


# ---------------------------------------------------------------- 2. hostile AMFI rows
def test_mf111_hostile_amfi_rows_reject_the_row_and_the_parse_continues() -> None:
    hostile = [
        "²;-;-;Superscript code;10.5;09-Oct-2026",  # str.isdigit() is True, int() raises
        "١٢٣;-;-;Arabic-Indic code;10.5;09-Oct-2026",
        "99999999999;-;-;Code too long for int4;10.5;09-Oct-2026",
        "200001;-;-;Arabic-Indic NAV;١٠.٥;09-Oct-2026",
        f"200002;-;-;Overflowing NAV;{'9' * 30};09-Oct-2026",
        "200003;-;-;Huge NAV;99999999999;09-Oct-2026",
        "200004;-;-;Arabic-Indic date;10.5;٠٩-Oct-2026",
        f"200005;-;-;{'x' * 5000};10.5;09-Oct-2026",  # over-long line
    ]
    f = parse_navall(amfi_text(good_row(100001), *hostile, good_row(100002)))
    assert [r.code for r in f.rows] == [100001, 100002]
    assert f.rejected == len(hostile)
    assert f.reasons["code"] == 3 and f.reasons["nav"] == 3
    assert f.reasons["date"] == 1 and f.reasons["line_too_long"] == 1


def test_mf111_ascii_only_digits_in_shared_parsers() -> None:
    assert parse_scheme_code("²") is None and parse_scheme_code("١٢٣") is None
    assert parse_scheme_code("123") == 123 and parse_scheme_code("0") is None
    assert parse_scheme_code(10**12) is None and parse_scheme_code(True) is None
    assert parse_nav("١٢.٥") is None and parse_nav("12.5") == Decimal("12.5")
    assert parse_date_dmy("٠١-٠١-٢٠٢٦") is None and parse_date_dmy("01-01-2026") == date(2026, 1, 1)
    assert parse_date_dmon("٠١-Jan-2026") is None and parse_date_dmon("01-Jan-2026") is not None


def test_mf112_oversized_nav_is_rejected_not_passed_to_the_database() -> None:
    assert parse_nav("10000000") == Decimal("10000000")
    assert parse_nav("10000001") is None
    assert parse_nav("1" + "0" * 13) is None
    payload = {
        "status": "SUCCESS",
        "meta": {"scheme_code": 1},
        "data": [{"date": "01-01-2026", "nav": "1" + "0" * 40}, {"date": "02-01-2026", "nav": "5"}],
    }
    h = mfapi_mod.parse_history(payload)
    assert [p.nav for p in h.points] == [Decimal("5")] and h.rejected == 1


# ---------------------------------------------------------------- 3. status floor
def _tiny_file(rows: int = 1) -> Any:
    return parse_navall(amfi_text(*[good_row(300000 + i) for i in range(rows)]))


# MF-85 variant: a truncated file never changes status
async def test_mf113_one_row_amfi_file_leaves_statuses_untouched() -> None:
    store = MemoryMfStore()
    for code in range(1, 6):
        store.add(code, last=TODAY - timedelta(days=500))  # would turn inactive
    c = JobContext(job="t")
    await run_sync_mf_schemes(
        c, store, FakeMfapi(listing=SchemeList([])), FakeAmfi(_tiny_file()), TODAY
    )
    assert all(s["status"] == "active" for k, s in store.schemes.items() if k < 10)
    assert "amfi_rows_below_floor" in c.extra["status_skipped"] and "status_changed" not in c.extra
    assert c.marked_partial
    # the rows themselves are still upserted
    assert 300000 in store.schemes


async def test_mf113_floor_is_half_of_the_previous_applied_file(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(mf_jobs, "AMFI_MIN_ROWS", 1)
    f = _tiny_file(9)

    async def run(previous: int | None) -> JobContext:
        store = MemoryMfStore()
        store.add(1, last=TODAY - timedelta(days=500))
        store.previous_rows = previous
        c = JobContext(job="t")
        await run_sync_mf_schemes(c, store, FakeMfapi(listing=SchemeList([])), FakeAmfi(f), TODAY)
        return c

    refused = await run(100)  # 9 < 50
    assert "status_skipped" in refused.extra
    ok = await run(18)  # 9 >= 9
    assert ok.extra["status_changed"] == 1 and ok.extra["amfi_status_rows"] == 9
    assert (await run(None)).extra["status_changed"] == 1  # first run: only the absolute floor


async def test_mf113_amfi_floor_default_is_5000() -> None:
    assert mf_jobs.AMFI_MIN_ROWS == 5000 and mf_jobs.AMFI_MIN_FRACTION == 0.5


async def test_mf118_duplicate_amfi_codes_counted_last_row_wins() -> None:
    f = parse_navall(amfi_text(good_row(7, "10.0"), good_row(7, "11.0"), good_row(8, "5")))
    assert f.duplicates == 1 and {r.code: r.nav for r in f.rows}[7] == Decimal("11.0")
    store = MemoryMfStore()
    c = JobContext(job="t")
    await run_sync_mf_schemes(c, store, FakeMfapi(listing=SchemeList([])), FakeAmfi(f), TODAY)
    assert c.extra["amfi_duplicates"] == 1


# ---------------------------------------------------------------- 4. response size caps
class _Routes(httpx.AsyncBaseTransport):
    def __init__(self, handler: Any) -> None:
        self.handler = handler
        self.n = 0

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.n += 1
        return self.handler(request)  # type: ignore[no-any-return]


class _Chunks(httpx.AsyncByteStream):
    """A body of unknown length (no Content-Length), delivered in chunks."""

    def __init__(self, chunks: int, size: int) -> None:
        self.chunks, self.size, self.sent = chunks, size, 0

    async def __aiter__(self) -> Any:
        for _ in range(self.chunks):
            self.sent += 1
            yield b"x" * self.size


def _guard(clock: FakeClock, store: MemoryHealthStore, source: str) -> SourceGuard:
    return SourceGuard(
        source, RateLimiter(0.0, clock=clock, sleep=clock.sleep), CircuitBreaker(source, store)
    )


async def test_mf114_declared_oversize_amfi_body_is_refused_without_a_source_failure(
    clock: FakeClock, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(amfi_mod, "MAX_BYTES", 1000)
    store = MemoryHealthStore()
    routes = _Routes(lambda r: httpx.Response(200, content=b"x" * 5000))
    client = egress.make_client(inner=routes)
    async with client:
        with pytest.raises(SchemaError, match="too large"):
            await AmfiClient(client, _guard(clock, store, "amfi")).latest_navs()
    assert routes.n == 1  # not retried
    assert "amfi" not in store.rows  # nothing recorded against the breaker


async def test_mf114_streamed_body_without_length_aborts_at_the_cap() -> None:
    stream = _Chunks(chunks=1000, size=1024)
    routes = _Routes(lambda r: httpx.Response(200, stream=stream))
    client = egress.make_client(inner=routes)
    async with client:
        with pytest.raises(egress.ResponseTooLarge):
            await egress.get_capped(client, "https://mfapi.in/mf", max_bytes=10_000)
    assert stream.sent < 20  # stopped reading right after the cap, not 1 MB later


async def test_mf114_get_capped_returns_a_normal_response_under_the_cap() -> None:
    routes = _Routes(lambda r: httpx.Response(200, json={"a": 1}))
    client = egress.make_client(inner=routes)
    async with client:
        r = await egress.get_capped(client, "https://mfapi.in/mf", max_bytes=1000)
    assert r.status_code == 200 and r.json() == {"a": 1}


async def test_mf114_mfapi_list_and_history_caps(
    clock: FakeClock, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(mfapi_mod, "MAX_LIST_BYTES", 100)
    body = json.dumps([{"schemeCode": i, "schemeName": "n" * 20} for i in range(50)])
    routes = _Routes(lambda r: httpx.Response(200, content=body.encode()))
    client = egress.make_client(inner=routes)
    mf = MfapiClient(client, _guard(clock, MemoryHealthStore(), "mfapi"), sleep=clock.sleep)
    async with client:
        with pytest.raises(SchemaError, match="too large"):
            await mf.list_schemes(page_size=50)
    # a single-scheme history has a smaller cap than a list page
    assert mfapi_mod.MAX_HISTORY_BYTES < 30 * 1024 * 1024


# ---------------------------------------------------------------- 5. NaN never reaches jsonb
def _walk_no_nonfinite(snap: dict[str, Any]) -> None:
    json.dumps(snap, allow_nan=False)  # raises on NaN / Infinity
    assert not [x for x in walk(snap) if isinstance(x, float) and not math.isfinite(x)]


def test_ret94_nan_volume_gives_null_obv_with_reason_never_nan() -> None:
    bars = make_bars(300)
    vol = bars.volume.copy()
    vol[150] = np.nan
    snap = build_snapshot(Bars(bars.dates, bars.close, bars.adj_close, bars.high, bars.low, vol))
    assert snap is not None
    _walk_no_nonfinite(snap)
    assert snap["technicals"]["obv"] is None and snap["null_reasons"]["obv"]
    assert snap["technicals"]["volume_z20"] is not None  # the NaN is outside the 20-day window
    # a NaN inside the ADV window nulls the metric with a reason
    vol2 = bars.volume.copy()
    vol2[-5] = np.nan
    s2 = build_snapshot(Bars(bars.dates, bars.close, bars.adj_close, bars.high, bars.low, vol2))
    assert s2 is not None
    _walk_no_nonfinite(s2)
    assert s2["returns"]["risk"]["adv_value_60_cr"] is None
    assert s2["null_reasons"]["adv_value_60_cr"]


def test_ret95_zero_close_does_not_raise_and_is_flagged() -> None:
    bars = make_bars(300)
    close, adj = bars.close.copy(), bars.adj_close.copy()
    close[100] = 0.0
    adj[100] = 0.0
    snap = build_snapshot(Bars(bars.dates, close, adj, bars.high, bars.low, bars.volume))
    assert snap is not None
    _walk_no_nonfinite(snap)
    assert snap["bars"] == 299
    assert any("dropped 1 bar" in w for w in snap["warnings"])
    assert snap["last_close"] is not None


def test_ret95_zero_close_on_the_last_bar_and_all_nan_prices() -> None:
    bars = make_bars(200)
    adj = bars.adj_close.copy()
    adj[-1] = 0.0
    snap = build_snapshot(Bars(bars.dates, bars.close, adj, bars.high, bars.low, bars.volume))
    assert snap is not None
    _walk_no_nonfinite(snap)
    assert snap["bars"] == 199
    nan = np.full(200, np.nan)
    assert build_snapshot(Bars(bars.dates, nan, nan, nan, nan, bars.volume)) is None


def test_ret96_infinite_return_cannot_break_histogram_or_calendar() -> None:
    from worker.analytics import analysis_series as ser

    close = np.array([0.0] + [100.0 + i for i in range(60)])
    d = [date(2026, 1, 1) + timedelta(days=i) for i in range(len(close))]
    h = ser.histogram(close)  # a 0 -> 100 move is an infinite return: filtered, not raised
    assert h is None or all(math.isfinite(e) for e in h["edges"])
    cal = ser.calendar_days(d, close)
    assert all(v is None or math.isfinite(v) for v in cal["values"])
    assert all(r[2] is None or math.isfinite(r[2]) for r in ser.month_year(d, close))


# ---------------------------------------------------------------- 6. allow_nan=False
async def test_mf115_save_cache_refuses_nan() -> None:
    class Pool:
        executed = 0

        async def execute(self, *a: Any) -> None:
            Pool.executed += 1

    store = PgMfStore(Pool())  # type: ignore[arg-type]
    with pytest.raises(ValueError):
        await store.save_cache(1, TODAY, {"volatility": float("nan")})
    with pytest.raises(ValueError):
        await store.save_cache(1, TODAY, {"x": float("inf")})
    assert Pool.executed == 0


# ---------------------------------------------------------------- 7. last stored date re-fetched
async def test_mf116_corrected_nav_for_the_last_stored_date_is_refreshed() -> None:
    store = MemoryMfStore()
    store.add(5, tracked=True)
    d0 = date(2026, 9, 1)
    pts = [NavPoint(d0 + timedelta(days=i), Decimal(100 + i)) for i in range(5)]
    api = FakeMfapi({5: pts})
    await run_ingest_mf_navs(JobContext(job="t"), store, api, FakeAmfi(_tiny_file()), TODAY)
    last = d0 + timedelta(days=4)
    assert store.navs[5][last] == 104.0
    api.history[5] = [*pts[:-1], NavPoint(last, Decimal("99.5"))]  # source corrected the NAV
    await run_ingest_mf_navs(JobContext(job="t"), store, api, FakeAmfi(_tiny_file()), TODAY)
    assert api.calls[-1][1] == last
    assert store.navs[5][last] == 99.5 and len(store.navs[5]) == 5


# ---------------------------------------------------------------- 8. breaker
class _YieldingStore(MemoryHealthStore):
    """get/save race like two connections would; ``update`` is the only atomic path."""

    def __init__(self) -> None:
        super().__init__()
        self.lock = asyncio.Lock()

    async def get(self, source: str) -> SourceHealth | None:
        await asyncio.sleep(0)
        return self.rows.get(source)

    async def save(self, health: SourceHealth) -> None:
        await asyncio.sleep(0)
        self.rows[health.source] = health

    async def update(self, source: str, fn: Any) -> SourceHealth:
        async with self.lock:
            cur = await self.get(source) or SourceHealth(source=source, ok=True)
            new = fn(cur)
            await self.save(new)
            return new


async def test_sys33_concurrent_failures_are_not_lost_in_memory() -> None:
    store = _YieldingStore()
    breakers = [CircuitBreaker("amfi", store) for _ in range(20)]
    await asyncio.gather(*(b.record_failure("x") for b in breakers))
    assert store.rows["amfi"].consecutive_failures == 20


async def test_sys34_probe_success_counter_is_in_memory_a_restart_needs_three_fresh() -> None:
    now = {"t": datetime(2026, 10, 17, 12, 0, tzinfo=UTC)}
    store = MemoryHealthStore()
    b = CircuitBreaker("mfapi", store, now=lambda: now["t"])
    for _ in range(5):
        await b.record_failure("boom")
    now["t"] += timedelta(minutes=31)
    await b.record_success()
    await b.record_success()  # 2 of 3 in this process
    restarted = CircuitBreaker("mfapi", store, now=lambda: now["t"])  # new process: counter is 0
    await restarted.record_success()
    await restarted.record_success()
    assert store.rows["mfapi"].consecutive_failures == 5  # still not closed
    await restarted.record_success()
    row = store.rows["mfapi"]
    assert row.consecutive_failures == 0 and row.ok and row.disabled_until is None


async def test_sys19_escalation_levels_are_derived_from_consecutive_failures() -> None:
    now = {"t": datetime(2026, 10, 17, 12, 0, tzinfo=UTC)}
    store = MemoryHealthStore()
    b = CircuitBreaker("x", store, now=lambda: now["t"])
    got = []
    for _ in range(8):
        await b.record_failure()
        row = store.rows["x"]
        got.append(None if row.disabled_until is None else row.disabled_until - now["t"])
    assert got[:4] == [None] * 4
    assert got[4:] == [
        timedelta(minutes=30),
        timedelta(hours=2),
        timedelta(hours=12),
        timedelta(hours=12),
    ]


# ---------------------------------------------------------------- nice-to-have
def test_ind93_adx_first_value_exists_with_exactly_two_n_bars() -> None:
    rng = np.random.default_rng(3)
    close = 100 + np.cumsum(rng.normal(0, 1, 60))
    high, low = close + 1.0, close - 1.0
    n = 14
    full = ind.adx(high, low, close)
    exact = ind.adx(high[: 2 * n], low[: 2 * n], close[: 2 * n])
    assert np.isnan(exact.adx[: 2 * n - 1]).all() and not np.isnan(exact.adx[2 * n - 1])
    assert exact.adx[2 * n - 1] == pytest.approx(full.adx[2 * n - 1])  # same value, just earlier
    short = ind.adx(high[: 2 * n - 1], low[: 2 * n - 1], close[: 2 * n - 1])
    assert np.isnan(short.adx).all()


def test_mf117_one_shared_subtract_months_with_month_end_clamping() -> None:
    assert mf_analytics.subtract_months is rt.subtract_months
    sm = rt.subtract_months
    assert sm(date(2026, 3, 31), 1) == date(2026, 2, 28)
    assert sm(date(2024, 3, 31), 1) == date(2024, 2, 29)
    assert sm(date(2024, 2, 29), 12) == date(2023, 2, 28)
    assert sm(date(2026, 10, 31), 4) == date(2026, 6, 30)
    assert sm(date(2026, 1, 31), 2) == date(2025, 11, 30)
    assert sm(date(2026, 1, 15), 13) == date(2024, 12, 15)


@pytest.mark.parametrize("raw", ["inf", "nan", "-inf", "1e999", "Infinity"])
def test_sys35_retry_after_inf_and_nan_are_capped(raw: str) -> None:
    from worker.errors import RetryableError

    with pytest.raises(RetryableError) as exc:
        egress.raise_if_retryable(httpx.Response(429, headers={"Retry-After": raw}))
    hint = exc.value.retry_after
    delay = backoff_delay(1, random.Random(1), hint)
    assert math.isfinite(delay) and 2.0 <= delay <= 60.0


# ---------------------------------------------------------------- real files stay untouched
def test_fixture_file_still_parses_after_hardening() -> None:
    p = Path(__file__).resolve().parents[3] / "fixtures" / "amfi" / "NAVAll_sample.txt"
    f = parse_navall(p.read_text(encoding="utf-8"))
    assert len(f.rows) == 9 and f.duplicates == 0
