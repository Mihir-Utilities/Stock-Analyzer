"""Integration tests against Postgres 16 (TEST_DATABASE_URL): SYS-05 lock, breaker store, job queue."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

import asyncpg
import pytest

from worker.breaker import CircuitBreaker
from worker.db import PgJobQueue, PgRunStore, PgSourceHealthStore
from worker.errors import SourceDisabled
from worker.runner import JobContext, JobSpec, run_job

pytestmark = [pytest.mark.anyio, pytest.mark.integration]


async def test_sys05_unique_index_allows_one_running_instance(pg_pool: asyncpg.Pool) -> None:
    store = PgRunStore(pg_pool)
    results = await asyncio.gather(*(store.try_lock("ingest_mf_navs") for _ in range(8)))
    assert sum(r is not None for r in results) == 1
    assert await store.try_lock("sync_mf_schemes") is not None  # other jobs unaffected


async def test_sys05_second_overlapping_run_is_recorded_skipped(pg_pool: asyncpg.Pool) -> None:
    store = PgRunStore(pg_pool)
    started, release = asyncio.Event(), asyncio.Event()

    async def slow(ctx: JobContext) -> None:
        started.set()
        await release.wait()

    spec = JobSpec("evaluate_alerts", 60, slow)
    first = asyncio.create_task(run_job(spec, store))
    await started.wait()
    second = await run_job(spec, store)
    release.set()
    assert second.status == "skipped" and (await first).status == "ok"
    rows = await pg_pool.fetch("SELECT status, details FROM ingestion_run ORDER BY id")
    assert [r["status"] for r in rows] == ["ok", "skipped"]


async def test_finish_writes_counts_and_details(pg_pool: asyncpg.Pool) -> None:
    store = PgRunStore(pg_pool)

    async def work(ctx: JobContext) -> None:
        async def one(n: int) -> None:
            if n == 1:
                raise ValueError("bad")
            ctx.add_rows(10)

        await ctx.for_each([0, 1, 2], one)

    res = await run_job(JobSpec("j", 60, work), store)
    row = await pg_pool.fetchrow("SELECT * FROM ingestion_run WHERE id = $1", res.run_id)
    assert row is not None
    assert (row["status"], row["rows_written"], row["items_total"], row["items_failed"]) == (
        "ok",
        20,
        3,
        1,
    )
    assert row["finished_at"] is not None and "bad" in row["details"]


# SYS-20
async def test_stale_running_row_is_failed_by_next_run(pg_pool: asyncpg.Pool) -> None:
    store = PgRunStore(pg_pool)
    await pg_pool.execute(
        "INSERT INTO ingestion_run (job, status, started_at) VALUES ('j', 'running', $1)",
        datetime.now(UTC) - timedelta(minutes=5),
    )

    async def work(ctx: JobContext) -> None:
        return None

    assert (await run_job(JobSpec("j", 60, work), store)).status == "ok"
    statuses = [
        r["status"] for r in await pg_pool.fetch("SELECT status FROM ingestion_run ORDER BY id")
    ]
    assert statuses == ["failed", "ok"]


# SYS-19 (state survives a new process)
async def test_breaker_persists_in_source_health(pg_pool: asyncpg.Pool) -> None:
    store = PgSourceHealthStore(pg_pool)
    breaker = CircuitBreaker("mfapi", store)
    for _ in range(5):
        await breaker.before_call()
        await breaker.record_failure("boom")
    row = await pg_pool.fetchrow("SELECT * FROM source_health WHERE source = 'mfapi'")
    assert row is not None and row["consecutive_failures"] == 5 and row["ok"] is False
    assert row["disabled_until"] > datetime.now(UTC) + timedelta(minutes=29)
    with pytest.raises(SourceDisabled):
        await CircuitBreaker("mfapi", store).before_call()  # fresh instance reads the same row
    await pg_pool.execute("UPDATE source_health SET disabled_until = now() - interval '1 second'")
    probe = CircuitBreaker("mfapi", store)
    await probe.before_call()
    for _ in range(3):
        await probe.record_success(latency_ms=40)
    row = await pg_pool.fetchrow("SELECT * FROM source_health WHERE source = 'mfapi'")
    assert row is not None and row["consecutive_failures"] == 0 and row["ok"] is True
    assert row["disabled_until"] is None and row["latency_ms"] == 40


async def test_job_queue_claim_is_atomic(pg_pool: asyncpg.Pool) -> None:
    queue = PgJobQueue(pg_pool)
    job_id = await pg_pool.fetchval(
        "INSERT INTO refresh_job (kind, target) VALUES ('post_import', 'batch:7') RETURNING id"
    )
    assert await queue.get(job_id) == ("post_import", "batch:7", "queued")
    claims = await asyncio.gather(*(queue.claim(job_id) for _ in range(5)))
    assert sum(claims) == 1
    await queue.finish(job_id, status="partial", result={"remaining": ["TCS"]}, error=None)
    row = await pg_pool.fetchrow(
        "SELECT status, result, finished_at FROM refresh_job WHERE id = $1", job_id
    )
    assert row is not None and row["status"] == "partial" and "TCS" in row["result"]
    assert row["finished_at"] is not None
    assert await queue.get(99999) is None


# SYS-32: concurrent jobs must not lose breaker updates (row-locked read-modify-write)
async def test_sys32_concurrent_breaker_failures_are_all_counted(pg_pool: asyncpg.Pool) -> None:
    store = PgSourceHealthStore(pg_pool)
    breakers = [CircuitBreaker("cas-test", store) for _ in range(20)]
    await asyncio.gather(*(b.record_failure("x") for b in breakers))
    row = await pg_pool.fetchrow("SELECT * FROM source_health WHERE source = 'cas-test'")
    assert row is not None and row["consecutive_failures"] == 20 and row["ok"] is False
    await asyncio.gather(*(b.record_success() for b in breakers[:3]))
    row = await pg_pool.fetchrow("SELECT * FROM source_health WHERE source = 'cas-test'")
    assert row is not None and row["consecutive_failures"] == 20  # probes counted per instance
