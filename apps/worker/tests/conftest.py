"""Shared test setup: sockets disabled (SAF-13), in-memory stores, optional Postgres fixture."""

from __future__ import annotations

import os
import socket
from collections.abc import AsyncIterator, Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import asyncpg
import pytest

from worker.breaker import SourceHealth

REPO = Path(__file__).resolve().parents[3]


class SocketBlocked(OSError):  # noqa: N818
    """A test tried to open a non-loopback network connection."""


def _is_loopback(address: Any) -> bool:
    host = address[0] if isinstance(address, tuple) and address else address
    return isinstance(host, str) and (host.startswith("127.") or host in ("::1", "localhost"))


@pytest.fixture(autouse=True)
def _sockets_disabled(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """No test can reach the network. Loopback stays open (the asyncio loop and a local test
    database need it); name resolution of anything else is refused too."""
    real_connect = socket.socket.connect
    real_connect_ex = socket.socket.connect_ex
    real_getaddrinfo = socket.getaddrinfo

    def connect(self: socket.socket, address: Any) -> None:
        if not _is_loopback(address):
            raise SocketBlocked(f"network access is disabled in tests: {address!r}")
        real_connect(self, address)

    def connect_ex(self: socket.socket, address: Any) -> int:
        if not _is_loopback(address):
            raise SocketBlocked(f"network access is disabled in tests: {address!r}")
        return real_connect_ex(self, address)

    def getaddrinfo(host: Any, *args: Any, **kwargs: Any) -> Any:
        if not _is_loopback(host):
            raise SocketBlocked(f"name resolution is disabled in tests: {host!r}")
        return real_getaddrinfo(host, *args, **kwargs)

    monkeypatch.setattr(socket.socket, "connect", connect)
    monkeypatch.setattr(socket.socket, "connect_ex", connect_ex)
    monkeypatch.setattr(socket, "getaddrinfo", getaddrinfo)
    yield


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


class FakeClock:
    """Deterministic clock + sleeper: ``sleep`` advances time instead of waiting."""

    def __init__(self, start: float = 1000.0) -> None:
        self.t = start
        self.sleeps: list[float] = []

    def __call__(self) -> float:
        return self.t

    async def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.t += seconds


class MemoryHealthStore:
    def __init__(self) -> None:
        self.rows: dict[str, SourceHealth] = {}

    async def get(self, source: str) -> SourceHealth | None:
        return self.rows.get(source)

    async def save(self, health: SourceHealth) -> None:
        self.rows[health.source] = health


class MemoryRunStore:
    """Mimics ``ingestion_run`` including the one-running-per-job unique index."""

    def __init__(self) -> None:
        self.runs: list[dict[str, Any]] = []

    def _running(self, job: str) -> dict[str, Any] | None:
        return next((r for r in self.runs if r["job"] == job and r["status"] == "running"), None)

    async def fail_stale(self, job: str, older_than: datetime) -> int:
        n = 0
        for r in self.runs:
            if r["job"] == job and r["status"] == "running" and r["started_at"] < older_than:
                r["status"], r["error"] = "failed", "stale_run"
                n += 1
        return n

    async def try_lock(self, job: str) -> int | None:
        if self._running(job):
            return None
        row = {
            "id": len(self.runs) + 1,
            "job": job,
            "status": "running",
            "started_at": datetime.now(UTC),
            "error": None,
            "details": None,
        }
        self.runs.append(row)
        return int(row["id"])

    async def record_skipped(self, job: str, reason: str) -> int:
        row = {
            "id": len(self.runs) + 1,
            "job": job,
            "status": "skipped",
            "started_at": datetime.now(UTC),
            "error": None,
            "details": {"reason": reason},
        }
        self.runs.append(row)
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
        row = self.runs[run_id - 1]
        row.update(
            status=status,
            rows_written=rows_written,
            items_total=items_total,
            items_failed=items_failed,
            error=error,
            details=details,
        )


class MemoryQueue:
    def __init__(self, rows: dict[int, tuple[str, str, str]] | None = None) -> None:
        self.rows = dict(rows or {})
        self.finished: dict[int, dict[str, Any]] = {}

    async def get(self, job_id: int) -> tuple[str, str, str] | None:
        return self.rows.get(job_id)

    async def claim(self, job_id: int) -> bool:
        row = self.rows.get(job_id)
        if row is None or row[2] != "queued":
            return False
        self.rows[job_id] = (row[0], row[1], "running")
        return True

    async def finish(
        self, job_id: int, *, status: str, result: dict[str, Any] | None, error: str | None
    ) -> None:
        kind, target, _ = self.rows[job_id]
        self.rows[job_id] = (kind, target, status)
        self.finished[job_id] = {"status": status, "result": result, "error": error}


@pytest.fixture
def clock() -> FakeClock:
    return FakeClock()


# --------------------------------------------------------------------------- Postgres (integration)
def _ops_ddl() -> str:
    text = (REPO / "db" / "migrations" / "0008_ops.sql").read_text(encoding="utf-8")
    return text.split("-- +goose Up", 1)[1].split("-- +goose Down", 1)[0]


@pytest.fixture
async def pg_pool() -> AsyncIterator[asyncpg.Pool]:
    """Throwaway Postgres 16 from TEST_DATABASE_URL with the ops tables of migration 0008."""
    dsn = os.environ.get("TEST_DATABASE_URL")
    if not dsn:
        if os.environ.get("CI"):
            pytest.fail("TEST_DATABASE_URL must be set in CI")
        pytest.skip("TEST_DATABASE_URL not set (see docs/RUNBOOK.md section 3b)")
    pool = await asyncpg.create_pool(dsn, min_size=1, max_size=4, statement_cache_size=0)
    async with pool.acquire() as conn:
        await conn.execute("DROP TABLE IF EXISTS refresh_job, source_health, ingestion_run CASCADE")
        await conn.execute(_ops_ddl())
    try:
        yield pool
    finally:
        await pool.close()


def _all_migrations_ddl() -> list[str]:
    out: list[str] = []
    for path in sorted((REPO / "db" / "migrations").glob("*.sql")):
        text = path.read_text(encoding="utf-8")
        out.append(text.split("-- +goose Up", 1)[1].split("-- +goose Down", 1)[0])
    return out


@pytest.fixture
async def pg_full() -> AsyncIterator[asyncpg.Pool]:
    """Throwaway Postgres 16 with every migration of db/migrations applied to a clean schema."""
    dsn = os.environ.get("TEST_DATABASE_URL")
    if not dsn:
        if os.environ.get("CI"):
            pytest.fail("TEST_DATABASE_URL must be set in CI")
        pytest.skip("TEST_DATABASE_URL not set (see docs/RUNBOOK.md section 3b)")
    pool = await asyncpg.create_pool(dsn, min_size=1, max_size=4, statement_cache_size=0)
    async with pool.acquire() as conn:
        await conn.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public")
        for ddl in _all_migrations_ddl():
            await conn.execute(ddl)
    try:
        yield pool
    finally:
        await pool.close()


@pytest.fixture
def health_store() -> MemoryHealthStore:
    return MemoryHealthStore()


@pytest.fixture
def run_store() -> MemoryRunStore:
    return MemoryRunStore()


@pytest.fixture
def make_queue() -> type[MemoryQueue]:
    return MemoryQueue
