"""Postgres access (asyncpg): ingestion_run lock, source_health, refresh_job.

Parameterised queries only. ``statement_cache_size=0`` keeps it compatible with Neon's pooled
endpoint. One retry with backoff on the first connect covers Neon's scale-to-zero wake-up (SYS-01).
"""

from __future__ import annotations

import asyncio
import json
import os
from datetime import datetime
from typing import Any

import asyncpg

from worker.breaker import SourceHealth


async def create_pool(dsn: str | None = None) -> asyncpg.Pool:
    url = dsn or os.environ.get("DATABASE_URL", "")
    if not url:
        raise RuntimeError("DATABASE_URL is not set")
    try:
        return await _pool(url)
    except (OSError, asyncpg.PostgresError, TimeoutError):
        await asyncio.sleep(3)
        return await _pool(url)


async def _pool(url: str) -> asyncpg.Pool:
    return await asyncpg.create_pool(
        url, min_size=1, max_size=4, statement_cache_size=0, command_timeout=60, timeout=30
    )


class PgRunStore:
    """``RunStore`` over ``ingestion_run`` (docs/04 section 1 rule 1)."""

    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool

    async def fail_stale(self, job: str, older_than: datetime) -> int:
        status = await self._pool.execute(
            "UPDATE ingestion_run SET status = 'failed', finished_at = now(), error = 'stale_run' "
            "WHERE job = $1 AND status = 'running' AND started_at < $2",
            job,
            older_than,
        )
        return int(status.split()[-1])

    async def try_lock(self, job: str) -> int | None:
        row = await self._pool.fetchrow(
            "INSERT INTO ingestion_run (job, status) VALUES ($1, 'running') "
            "ON CONFLICT (job) WHERE status = 'running' DO NOTHING RETURNING id",
            job,
        )
        return None if row is None else int(row["id"])

    async def record_skipped(self, job: str, reason: str) -> int:
        row = await self._pool.fetchrow(
            "INSERT INTO ingestion_run (job, status, finished_at, details) "
            "VALUES ($1, 'skipped', now(), $2::jsonb) RETURNING id",
            job,
            json.dumps({"reason": reason}),
        )
        if row is None:  # INSERT ... RETURNING always yields a row
            raise RuntimeError("ingestion_run insert returned no row")
        return int(row["id"])

    async def finish(
        self,
        run_id: int,
        *,
        status: str,
        rows_written: int,
        items_total: int | None,
        items_failed: int,
        error: str | None,
        details: dict[str, Any],
    ) -> None:
        await self._pool.execute(
            "UPDATE ingestion_run SET status = $2, finished_at = now(), rows_written = $3, "
            "items_total = $4, items_failed = $5, error = $6, details = $7::jsonb WHERE id = $1",
            run_id,
            status,
            rows_written,
            items_total,
            items_failed,
            error,
            json.dumps(details, default=str),
        )


class PgSourceHealthStore:
    """``SourceHealthStore`` over ``source_health`` (docs/01 section 1 rule 5)."""

    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool

    async def get(self, source: str) -> SourceHealth | None:
        row = await self._pool.fetchrow(
            "SELECT source, ok, consecutive_failures, disabled_until, latency_ms, note, checked_at "
            "FROM source_health WHERE source = $1",
            source,
        )
        return None if row is None else SourceHealth(**dict(row))

    async def save(self, health: SourceHealth) -> None:
        await self._pool.execute(
            "INSERT INTO source_health "
            "(source, checked_at, ok, latency_ms, consecutive_failures, disabled_until, note) "
            "VALUES ($1, COALESCE($2, now()), $3, $4, $5, $6, $7) "
            "ON CONFLICT (source) DO UPDATE SET checked_at = EXCLUDED.checked_at, "
            "ok = EXCLUDED.ok, latency_ms = EXCLUDED.latency_ms, "
            "consecutive_failures = EXCLUDED.consecutive_failures, "
            "disabled_until = EXCLUDED.disabled_until, note = EXCLUDED.note",
            health.source,
            health.checked_at,
            health.ok,
            health.latency_ms,
            health.consecutive_failures,
            health.disabled_until,
            health.note,
        )


class PgJobQueue:
    """``JobQueue`` over ``refresh_job`` (docs/04 section 4)."""

    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool

    async def get(self, job_id: int) -> tuple[str, str, str] | None:
        row = await self._pool.fetchrow(
            "SELECT kind, target, status FROM refresh_job WHERE id = $1", job_id
        )
        return None if row is None else (row["kind"], row["target"], row["status"])

    async def claim(self, job_id: int) -> bool:
        row = await self._pool.fetchrow(
            "UPDATE refresh_job SET status = 'running', started_at = now() "
            "WHERE id = $1 AND status = 'queued' RETURNING id",
            job_id,
        )
        return row is not None

    async def finish(
        self, job_id: int, *, status: str, result: dict[str, Any] | None, error: str | None
    ) -> None:
        await self._pool.execute(
            "UPDATE refresh_job SET status = $2, finished_at = now(), error = $3, "
            "result = $4::jsonb WHERE id = $1",
            job_id,
            status,
            error,
            None if result is None else json.dumps(result, default=str),
        )
