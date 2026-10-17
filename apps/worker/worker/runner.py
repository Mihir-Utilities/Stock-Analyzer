"""Job runner contract (docs/04 section 1 rules 1-4, 9).

* Lock: an ``ingestion_run(status='running')`` row; the partial unique index allows one running
  instance per job; a conflict records a ``skipped`` run (SYS-05). A ``running`` row older than
  2x the job timeout is marked ``failed`` by the next run.
* Timeout: when the deadline passes the job stops starting new items, finishes the current one,
  writes progress and the run is marked ``partial``.
* Per-item isolation: one item failing never fails the run; the first 50 errors are kept.
* Dry run: nothing is written, not even the lock row.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol, TypeVar

from worker.logs import scrub

log = logging.getLogger("worker.runner")

T = TypeVar("T")

MAX_ERRORS_KEPT = 50
STALE_FACTOR = 2


class RunStore(Protocol):
    async def fail_stale(self, job: str, older_than: datetime) -> int:
        """Mark ``running`` rows of ``job`` started before ``older_than`` as ``failed``."""
        ...

    async def try_lock(self, job: str) -> int | None:
        """Insert a ``running`` row; ``None`` if one already exists (unique-index conflict)."""
        ...

    async def record_skipped(self, job: str, reason: str) -> int: ...

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
    ) -> None: ...


@dataclass
class JobContext:
    job: str
    dry_run: bool = False
    record_fixtures: bool = False
    symbols: list[str] | None = None
    deadline: float | None = None  # on the runner clock; None = no timeout
    clock: Callable[[], float] = time.monotonic
    rows_written: int = 0
    items_total: int | None = None
    items_failed: int = 0
    errors: list[dict[str, str]] = field(default_factory=list)
    extra: dict[str, Any] = field(default_factory=dict)
    timed_out: bool = False
    remaining: list[Any] = field(default_factory=list)
    marked_partial: bool = False

    def past_deadline(self) -> bool:
        return self.deadline is not None and self.clock() >= self.deadline

    def add_rows(self, n: int) -> None:
        self.rows_written += n

    def mark_partial(self, reason: str) -> None:
        self.marked_partial = True
        self.extra["partial_reason"] = reason

    def record_item_error(self, item: object, exc: BaseException) -> None:
        self.items_failed += 1
        if len(self.errors) < MAX_ERRORS_KEPT:
            self.errors.append(
                {"item": scrub(str(item)), "error": scrub(f"{type(exc).__name__}: {exc}")}
            )

    async def run_item(self, item: object, fn: Callable[[], Awaitable[T]]) -> T | None:
        """Per-item isolation: an exception is recorded, never propagated."""
        try:
            return await fn()
        except Exception as exc:
            self.record_item_error(item, exc)
            log.warning("item failed", extra={"job": self.job, "item": str(item)})
            return None

    async def for_each(self, items: Sequence[T], fn: Callable[[T], Awaitable[object]]) -> None:
        """Process items in order with isolation; stop starting new items after the deadline."""
        self.items_total = len(items)
        for index, item in enumerate(items):
            if self.past_deadline():
                self.timed_out = True
                self.remaining = list(items[index:])
                return
            await self.run_item(item, lambda item=item: fn(item))  # type: ignore[misc]


JobFn = Callable[[JobContext], Awaitable[None]]


@dataclass(frozen=True)
class JobSpec:
    name: str
    timeout_s: float
    fn: JobFn


@dataclass(frozen=True)
class RunResult:
    job: str
    status: str  # ok | partial | failed | skipped
    run_id: int | None
    rows_written: int = 0
    items_total: int | None = None
    items_failed: int = 0
    error: str | None = None
    details: dict[str, Any] = field(default_factory=dict)


def _details(ctx: JobContext) -> dict[str, Any]:
    details: dict[str, Any] = dict(ctx.extra)
    details["errors"] = ctx.errors
    if ctx.timed_out:
        details["timed_out"] = True
        details["items_remaining"] = len(ctx.remaining)
    return details


async def run_job(
    spec: JobSpec,
    store: RunStore | None,
    *,
    dry_run: bool = False,
    symbols: list[str] | None = None,
    record_fixtures: bool = False,
    clock: Callable[[], float] = time.monotonic,
    now: Callable[[], datetime] = lambda: datetime.now(UTC),
) -> RunResult:
    run_id: int | None = None
    if not dry_run:
        if store is None:
            raise ValueError("a RunStore is required unless dry_run=True")
        await store.fail_stale(spec.name, now() - timedelta(seconds=STALE_FACTOR * spec.timeout_s))
        run_id = await store.try_lock(spec.name)
        if run_id is None:
            skipped_id = await store.record_skipped(spec.name, "already_running")
            log.info("job skipped", extra={"job": spec.name, "reason": "already_running"})
            return RunResult(
                spec.name, "skipped", skipped_id, details={"reason": "already_running"}
            )

    ctx = JobContext(
        job=spec.name,
        dry_run=dry_run,
        record_fixtures=record_fixtures,
        symbols=symbols,
        deadline=clock() + spec.timeout_s,
        clock=clock,
    )
    status, error = "ok", None
    try:
        await spec.fn(ctx)
        if ctx.timed_out or ctx.marked_partial:
            status = "partial"
    except asyncio.CancelledError:
        await _finish(store, run_id, ctx, "failed", "cancelled")
        raise
    except Exception as exc:
        status, error = "failed", scrub(f"{type(exc).__name__}: {exc}")
        log.error("job failed", extra={"job": spec.name, "error": error})
    await _finish(store, run_id, ctx, status, error)
    return RunResult(
        spec.name,
        status,
        run_id,
        ctx.rows_written,
        ctx.items_total,
        ctx.items_failed,
        error,
        _details(ctx),
    )


async def _finish(
    store: RunStore | None, run_id: int | None, ctx: JobContext, status: str, error: str | None
) -> None:
    if store is None or run_id is None:
        return
    await store.finish(
        run_id,
        status=status,
        rows_written=ctx.rows_written,
        items_total=ctx.items_total,
        items_failed=ctx.items_failed,
        error=error,
        details=_details(ctx),
    )
