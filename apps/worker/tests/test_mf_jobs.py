"""D04 jobs on in-memory stores: MF-06, MF-08, MF-09, MF-17, MF-18, incremental fetch, dry run."""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path

import pytest
from mfmemory import FakeAmfi, FakeMfapi, MemoryMfStore

from worker.adapters.amfi import parse_navall
from worker.adapters.base import SchemaError
from worker.adapters.mfapi import NavPoint, SchemeList, SchemeListItem, parse_history
from worker.errors import RetryableError, SourceDisabled
from worker.fixtures import load_json
from worker.mf_jobs import (
    decide_status,
    mf_refresh_handler,
    run_ingest_mf_navs,
    run_sync_mf_schemes,
)
from worker.runner import JobContext

pytestmark = pytest.mark.anyio


@pytest.fixture(autouse=True)
def _small_amfi_floor(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("worker.mf_jobs.AMFI_MIN_ROWS", 1)  # the fixture file has 9 rows


TODAY = date(2026, 10, 10)
AMFI_FIXTURE = Path(__file__).resolve().parents[3] / "fixtures" / "amfi" / "NAVAll_sample.txt"


def amfi_file():  # type: ignore[no-untyped-def]
    return parse_navall(AMFI_FIXTURE.read_text(encoding="utf-8"))


def pts(start: date, values: list[str]) -> list[NavPoint]:
    return [NavPoint(start + timedelta(days=i), Decimal(v)) for i, v in enumerate(values)]


def item(code: int, name: str) -> SchemeListItem:
    return SchemeListItem(code, name, None, None, "unknown", "unknown")


def ctx(dry: bool = False) -> JobContext:
    return JobContext(job="t", dry_run=dry)


# --------------------------------------------------------------------------- MF-06 / MF-18
def test_decide_status_rule() -> None:
    old, fresh = TODAY - timedelta(days=61), TODAY - timedelta(days=60)
    assert decide_status(None, None, TODAY, "active") == "inactive"  # absent from AMFI, no NAV
    assert (
        decide_status(old, None, TODAY, "active") == "inactive"
    )  # listed but stale (discontinued)
    assert decide_status(fresh, None, TODAY, "inactive") == "active"  # reactivated
    assert decide_status(None, fresh, TODAY, "active") == "active"  # absent from AMFI, recent NAV
    assert decide_status(old, fresh, TODAY, "active") == "active"  # freshest evidence wins


# MF-85
async def test_mf06_mf18_sync_marks_inactive_and_keeps_active() -> None:
    store = MemoryMfStore()
    listing = SchemeList(
        [
            item(135762, "Axis Children's Fund Direct Growth"),
            item(111972, "Old Fund"),
            item(999001, "Never in AMFI"),
        ]
    )
    c = ctx()
    await run_sync_mf_schemes(c, store, FakeMfapi(listing=listing), FakeAmfi(amfi_file()), TODAY)
    st = store.schemes
    assert st[135762]["status"] == "active" and st[135762]["fund_house"] == "Axis Mutual Fund"
    assert st[130947]["status"] == "inactive"  # in AMFI, value date 2020
    assert st[999001]["status"] == "inactive" and st[111972]["status"] == "inactive"
    assert st[119368]["status"] == "active"  # MF-17: 11-Oct value date, after the file date, kept
    assert c.extra["schemes_listed"] == 3 and c.extra["amfi_rows"] == 9 and c.rows_written == 12
    assert not c.marked_partial


# MF-85 (failed file never changes status)
async def test_sync_amfi_failure_keeps_status_and_is_partial() -> None:
    store = MemoryMfStore()
    store.add(
        1, last=TODAY - timedelta(days=500)
    )  # would be inactive, but AMFI evidence is missing
    c = ctx()
    await run_sync_mf_schemes(
        c,
        store,
        FakeMfapi(listing=SchemeList([item(2, "B")])),
        FakeAmfi(error=SchemaError("header")),
        TODAY,
    )
    assert store.schemes[1]["status"] == "active" and store.schemes[2]["status"] == "active"
    assert c.marked_partial and c.extra["amfi_error"] == "SchemaError"


async def test_sync_mfapi_down_uses_amfi_only_and_both_down_fails() -> None:
    store = MemoryMfStore()
    c = ctx()
    api = FakeMfapi(listing=SchemeList([]))
    api.fail = RetryableError("HTTP 503")
    await run_sync_mf_schemes(c, store, api, FakeAmfi(amfi_file()), TODAY)
    assert (
        len(store.schemes) == 9 and c.extra["mfapi_error"] == "RetryableError" and c.marked_partial
    )
    with pytest.raises(RuntimeError):
        await run_sync_mf_schemes(
            ctx(), MemoryMfStore(), api, FakeAmfi(error=SourceDisabled("amfi", None)), TODAY
        )


async def test_sync_dry_run_writes_nothing() -> None:
    store = MemoryMfStore()
    c = ctx(dry=True)
    await run_sync_mf_schemes(
        c, store, FakeMfapi(listing=SchemeList([item(1, "A")])), FakeAmfi(amfi_file()), TODAY
    )
    assert store.schemes == {} and c.rows_written == 0 and c.extra["amfi_rows"] == 9


# --------------------------------------------------------------------------- ingest
# MF-83 (amended by D04R-2: start = last stored date)
async def test_ingest_full_history_for_new_scheme_then_incremental_start_date() -> None:
    store = MemoryMfStore()
    store.add(5, tracked=True)
    start = date(2025, 1, 1)
    api = FakeMfapi({5: pts(start, [str(100 + i) for i in range(10)])})
    c = ctx()
    await run_ingest_mf_navs(c, store, api, FakeAmfi(amfi_file()), TODAY)
    assert api.calls == [(5, None, None)]  # new scheme: full history
    assert len(store.navs[5]) == 10 and 5 in store.cache
    assert store.cache[5][0] == date(2025, 1, 10) and store.schemes[5]["last_nav_date"] == date(
        2025, 1, 10
    )
    # next run: more data exists; request startDate = last stored date (D04R-2) up to today
    api.history[5] += pts(date(2025, 1, 11), ["200", "201"])
    c2 = ctx()
    await run_ingest_mf_navs(c2, store, api, FakeAmfi(amfi_file()), TODAY)
    assert api.calls[-1] == (5, date(2025, 1, 10), TODAY)
    assert len(store.navs[5]) == 12 and c2.rows_written == 3  # last date re-upserted
    # re-running adds nothing and duplicates nothing
    await run_ingest_mf_navs(ctx(), store, api, FakeAmfi(amfi_file()), TODAY)
    assert len(store.navs[5]) == 12


async def test_ingest_skips_call_when_start_after_today() -> None:
    store = MemoryMfStore()
    store.add(5, tracked=True)
    await store.upsert_navs(5, pts(TODAY + timedelta(days=1), ["10"]))
    api = FakeMfapi({5: []})
    await run_ingest_mf_navs(ctx(), store, api, FakeAmfi(amfi_file()), TODAY)
    assert api.calls == []


async def test_mf08_jump_kept_and_flagged_in_details() -> None:
    store = MemoryMfStore()
    store.add(5, tracked=True)
    api = FakeMfapi({5: pts(date(2026, 1, 1), ["100", "101", "140", "141"])})
    c = ctx()
    await run_ingest_mf_navs(c, store, api, FakeAmfi(amfi_file()), TODAY)
    assert len(store.navs[5]) == 4  # kept
    assert c.extra["nav_jumps"]["5"] == [{"date": "2026-01-03", "change_pct": 38.61}]
    assert store.cache[5][1]["nav_jumps"][0]["date"] == "2026-01-03"


async def test_mf09_mfapi_down_falls_back_to_amfi_latest_with_db_history() -> None:
    store = MemoryMfStore()
    store.add(135762, tracked=True)
    await store.upsert_navs(135762, pts(date(2026, 10, 1), ["28.0", "28.5"]))
    api = FakeMfapi({})
    api.fail = RetryableError("HTTP 503")
    amfi = FakeAmfi(amfi_file())
    c = ctx()
    await run_ingest_mf_navs(c, store, api, amfi, TODAY)
    s = store.navs[135762]
    assert s[date(2026, 10, 9)] == 29.0745 and len(s) == 3  # DB history kept, AMFI NAV added
    assert c.extra["amfi_fallback"] == [135762] and c.marked_partial and c.items_failed == 0
    assert store.cache[135762][0] == date(2026, 10, 9)
    assert amfi.downloads == 1


# MF-82
async def test_mf09_one_amfi_download_per_run_and_missing_amfi_row_is_item_error() -> None:
    store = MemoryMfStore()
    for code in (135762, 135765, 424242):
        store.add(code, tracked=True)
    api = FakeMfapi({})
    api.fail = SourceDisabled("mfapi", None)
    amfi = FakeAmfi(amfi_file())
    c = ctx()
    await run_ingest_mf_navs(c, store, api, amfi, TODAY)
    assert amfi.downloads == 1 and c.items_failed == 1 and c.errors[0]["item"] == "424242"
    assert 135765 in store.navs


# MF-87
async def test_ingest_wrong_code_and_untracked_cap_and_only_filter() -> None:
    store = MemoryMfStore()
    store.add(1, tracked=True)
    store.add(2, tracked=False)
    api = FakeMfapi({2: pts(date(2026, 1, 1), ["10", "11"])})
    c = ctx()
    await run_ingest_mf_navs(c, store, api, FakeAmfi(amfi_file()), TODAY)
    assert c.items_failed == 1 and [call[0] for call in api.calls] == [
        1
    ]  # 404 is not a fallback case
    await run_ingest_mf_navs(ctx(), store, api, FakeAmfi(amfi_file()), TODAY, only=[2])
    assert 2 in store.navs


async def test_ingest_dry_run_writes_nothing() -> None:
    store = MemoryMfStore()
    store.add(5, tracked=True)
    api = FakeMfapi({5: pts(date(2026, 1, 1), ["10", "11"])})
    c = ctx(dry=True)
    await run_ingest_mf_navs(c, store, api, FakeAmfi(amfi_file()), TODAY)
    assert store.navs == {} and store.cache == {} and c.extra["would_write"] == {"5": 2}


async def test_ingest_fixture_history_end_to_end_metrics() -> None:
    hist = parse_history(load_json("mfapi", "history_122639_trimmed.json"))
    store = MemoryMfStore()
    store.add(122639, tracked=True)
    api = FakeMfapi({122639: hist.points})
    await run_ingest_mf_navs(ctx(), store, api, FakeAmfi(amfi_file()), TODAY)
    as_of, metrics = store.cache[122639]
    assert as_of == hist.points[-1].nav_date and metrics["end_nav"] == float(hist.points[-1].nav)
    assert metrics["returns"]["1m"] is not None and metrics["first_nav_date"] == "2013-05-28"


async def test_mf_refresh_handler_rejects_non_numeric_target() -> None:
    from worker.jobs import HttpJob

    res = await mf_refresh_handler(HttpJob(1, "mf_refresh", "abc"))
    assert res.status == "failed"
