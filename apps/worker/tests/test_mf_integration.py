"""D04 against Postgres 16 with the real migrations: PgMfStore, ON CONFLICT idempotency, MF-18."""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path

import asyncpg
import pytest
from mfmemory import FakeAmfi, FakeMfapi

from worker.adapters.amfi import parse_navall
from worker.adapters.mfapi import NavPoint, SchemeList, SchemeListItem
from worker.errors import RetryableError
from worker.mf_jobs import PgMfStore, run_ingest_mf_navs, run_sync_mf_schemes
from worker.runner import JobContext

pytestmark = [pytest.mark.anyio, pytest.mark.integration]

TODAY = date(2026, 10, 10)
AMFI = Path(__file__).resolve().parents[3] / "fixtures" / "amfi" / "NAVAll_sample.txt"


def amfi() -> FakeAmfi:
    return FakeAmfi(parse_navall(AMFI.read_text(encoding="utf-8")))


async def test_sync_then_ingest_roundtrip(pg_full: asyncpg.Pool) -> None:
    store = PgMfStore(pg_full)
    listing = SchemeList(
        [
            SchemeListItem(
                135762,
                "Axis Children's Fund - Direct Plan - Growth",
                "INF846K01WO1",
                None,
                "direct",
                "growth",
            )
        ]
        + [
            SchemeListItem(900000 + i, f"Old scheme {i}", None, None, "unknown", "unknown")
            for i in range(30)
        ]
    )
    c = JobContext(job="sync")
    await run_sync_mf_schemes(c, store, FakeMfapi(listing=listing), amfi(), TODAY)
    row = await pg_full.fetchrow("SELECT * FROM mf_scheme WHERE code = 135762")
    assert row is not None and row["fund_house"] == "Axis Mutual Fund" and row["status"] == "active"
    assert (row["plan"], row["option_type"], row["category"]) == (
        "direct",
        "growth",
        "Children’s Fund - Childrens' Fund",
    )
    inactive = await pg_full.fetchval("SELECT count(*) FROM mf_scheme WHERE status = 'inactive'")
    assert inactive == 30 + 2  # 30 listed-only schemes + the two 2020/2022 ICICI rows
    # second run changes nothing (idempotent upsert)
    await run_sync_mf_schemes(
        JobContext(job="sync"), store, FakeMfapi(listing=listing), amfi(), TODAY
    )
    assert await pg_full.fetchval("SELECT count(*) FROM mf_scheme") == 31 + 8

    await pg_full.execute("UPDATE mf_scheme SET is_tracked = true WHERE code = 135762")
    start = date(2026, 9, 1)
    api = FakeMfapi(
        {
            135762: [
                NavPoint(start + timedelta(days=i), Decimal(f"{28 + i * 0.1:.4f}"))
                for i in range(30)
            ]
        }
    )
    ic = JobContext(job="ingest")
    await run_ingest_mf_navs(ic, store, api, amfi(), TODAY)
    assert await pg_full.fetchval("SELECT count(*) FROM mf_nav WHERE scheme_code = 135762") == 30
    last = await pg_full.fetchval("SELECT last_nav_date FROM mf_scheme WHERE code = 135762")
    assert last == start + timedelta(days=29)
    cache = await pg_full.fetchrow(
        "SELECT as_of, metrics FROM mf_return_cache WHERE scheme_code = 135762"
    )
    assert cache is not None and cache["as_of"] == last and '"returns"' in cache["metrics"]
    # incremental: only dates after last_nav_date are requested, no duplicates on re-run
    await run_ingest_mf_navs(JobContext(job="ingest"), store, api, amfi(), TODAY)
    assert api.calls[-1][1] == last + timedelta(days=1)
    assert await pg_full.fetchval("SELECT count(*) FROM mf_nav WHERE scheme_code = 135762") == 30


async def test_mf09_fallback_inserts_amfi_nav_in_db(pg_full: asyncpg.Pool) -> None:
    store = PgMfStore(pg_full)
    await run_sync_mf_schemes(
        JobContext(job="sync"), store, FakeMfapi(listing=SchemeList([])), amfi(), TODAY
    )
    await pg_full.execute("UPDATE mf_scheme SET is_tracked = true WHERE code = 135762")
    api = FakeMfapi({})
    api.fail = RetryableError("HTTP 503")
    c = JobContext(job="ingest")
    await run_ingest_mf_navs(c, store, api, amfi(), TODAY)
    nav = await pg_full.fetchval(
        "SELECT nav FROM mf_nav WHERE scheme_code = 135762 AND nav_date = '2026-10-09'"
    )
    assert nav == pytest.approx(29.0745) and c.marked_partial


async def test_risk_free_rate_from_app_setting(pg_full: asyncpg.Pool) -> None:
    store = PgMfStore(pg_full)
    await pg_full.execute(
        "INSERT INTO app_setting (key, value) VALUES ('RISK_FREE_RATE', '0.07'::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value"
    )
    assert await store.risk_free_rate() == pytest.approx(0.07)
    await pg_full.execute("DELETE FROM app_setting WHERE key = 'RISK_FREE_RATE'")
    assert await store.risk_free_rate() == pytest.approx(0.065)
