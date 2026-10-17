"""``post_import`` (docs/04 3.12) and ``process_queued_jobs`` (docs/04 3.13), manual price mode.

Per symbol, in order: re-adjust history, ``detect_actions`` (3.2), then the ``compute_analysis``
hook (D05) and the alert-evaluation hook (D06). Per-item isolation; the job stops starting new
symbols at 3.5 minutes, records progress in ``refresh_job.result`` and enqueues the remainder.
"""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from typing import Any, Protocol

import asyncpg

from worker import actions_db
from worker.actions_db import Notifier, NullNotifier
from worker.jobs import HttpJob, HttpJobResult
from worker.logs import scrub
from worker.runner import JobContext

log = logging.getLogger("worker.post_import")

POST_IMPORT = "post_import"
STOP_AFTER_S = 3.5 * 60  # docs/04 3.12: stop starting new symbols at 3.5 minutes
MAX_FAILED_KEPT = 50
QUEUED_STALE_MIN = 15  # docs/04 3.13

SymbolHook = Callable[[str], Awaitable[None]]
SymbolsHook = Callable[[Sequence[str]], Awaitable[None]]
SymbolStep = Callable[[str], Awaitable[dict[str, Any]]]


async def _noop_symbol(symbol: str) -> None:
    return None


async def _noop_symbols(symbols: Sequence[str]) -> None:
    return None


@dataclass
class Hooks:
    """D05/D06 replace these; until then post_import only adjusts and detects."""

    compute_analysis: SymbolHook = _noop_symbol  # D05
    evaluate_alerts: SymbolHook = _noop_symbol  # D06
    recompute_screener: SymbolsHook = _noop_symbols  # D05 (docs/04 3.12 step 3)


HOOKS = Hooks()


class PostImportStore(Protocol):
    async def job_result(self, job_id: int) -> dict[str, Any] | None: ...

    async def mark_partial(self, job_id: int, result: dict[str, Any]) -> None: ...

    async def enqueue_continuation(self, target: str, result: dict[str, Any]) -> int | None: ...


@dataclass
class SymbolProcessor:
    """The production per-symbol step (re-adjust, detect, analysis hook, alert hook)."""

    pool: asyncpg.Pool
    notifier: Notifier = field(default_factory=NullNotifier)
    hooks: Hooks = field(default_factory=lambda: HOOKS)

    async def __call__(self, symbol: str) -> dict[str, Any]:
        adjusted = await actions_db.readjust_history(self.pool, symbol)
        detected = await actions_db.detect_actions(self.pool, symbol, notifier=self.notifier)
        await self.hooks.compute_analysis(symbol)
        await self.hooks.evaluate_alerts(symbol)
        return {"adjust": adjusted, "detect": detected.summary()}


async def run_post_import(
    store: PostImportStore,
    *,
    job_id: int,
    target: str,
    step: SymbolStep,
    should_stop: Callable[[], bool],
    hooks: Hooks | None = None,
) -> HttpJobResult:
    """Process ``refresh_job.result.remaining`` in order (docs/04 3.12 steps 1-4)."""
    hooks = hooks or HOOKS
    result_in = await store.job_result(job_id)
    if result_in is None or not isinstance(result_in.get("remaining"), list):
        return HttpJobResult("failed", {}, "no symbol list in refresh_job.result.remaining")
    remaining = [str(s) for s in result_in["remaining"]]
    all_symbols = [str(s) for s in result_in.get("all", remaining)]
    total = int(result_in.get("symbols_total", len(all_symbols)))
    done = int(result_in.get("symbols_done", total - len(remaining)))
    failed: list[dict[str, str]] = list(result_in.get("failed", []))
    new_actions = int(result_in.get("new_actions", 0))

    index = 0
    while index < len(remaining):
        if should_stop():
            break
        symbol = remaining[index]
        try:
            outcome = await step(symbol)
            new_actions += len(outcome.get("detect", {}).get("new_actions", []))
        except Exception as exc:  # per-item isolation (docs/04 rule 4)
            log.warning("post_import symbol failed", extra={"item": symbol})
            if len(failed) < MAX_FAILED_KEPT:
                failed.append({"symbol": symbol, "error": scrub(f"{type(exc).__name__}: {exc}")})
        index += 1
        done += 1

    left = remaining[index:]
    result: dict[str, Any] = {
        "symbols_total": total,
        "symbols_done": done,
        "remaining": left,
        "all": all_symbols,
        "failed": failed,
        "new_actions": new_actions,
    }
    if left:
        await store.mark_partial(job_id, result)
        await store.enqueue_continuation(target, result)
        return HttpJobResult("partial", result)
    try:
        await hooks.recompute_screener(all_symbols)
    except Exception as exc:
        result["screener_error"] = scrub(f"{type(exc).__name__}: {exc}")
    return HttpJobResult("ok", result)


class PgPostImportStore:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool

    async def job_result(self, job_id: int) -> dict[str, Any] | None:
        raw = await self._pool.fetchval("SELECT result FROM refresh_job WHERE id = $1", job_id)
        if raw is None:
            return None
        value = json.loads(raw) if isinstance(raw, str) else raw
        return value if isinstance(value, dict) else None

    async def mark_partial(self, job_id: int, result: dict[str, Any]) -> None:
        # The partial row must stop being queued/running before the continuation is inserted
        # (unique active-job index on kind, target).
        await self._pool.execute(
            "UPDATE refresh_job SET status = 'partial', finished_at = now(), result = $2::jsonb "
            "WHERE id = $1",
            job_id,
            json.dumps(result),
        )

    async def enqueue_continuation(self, target: str, result: dict[str, Any]) -> int | None:
        row = await self._pool.fetchrow(
            "INSERT INTO refresh_job (kind, target, status, result) "
            "VALUES ($1, $2, 'queued', $3::jsonb) "
            "ON CONFLICT (kind, target) WHERE status IN ('queued', 'running') DO NOTHING "
            "RETURNING id",
            POST_IMPORT,
            target,
            json.dumps(result),
        )
        return None if row is None else int(row["id"])

    async def claim(self, job_id: int) -> bool:
        row = await self._pool.fetchrow(
            "UPDATE refresh_job SET status = 'running', started_at = now() "
            "WHERE id = $1 AND status = 'queued' RETURNING id",
            job_id,
        )
        return row is not None

    async def finish(
        self, job_id: int, status: str, result: dict[str, Any], error: str | None
    ) -> None:
        await self._pool.execute(
            "UPDATE refresh_job SET status = $2, finished_at = now(), error = $3, "
            "result = $4::jsonb WHERE id = $1",
            job_id,
            status,
            error,
            json.dumps(result),
        )

    async def queued_work(self) -> list[tuple[int, str, str]]:
        """docs/04 3.13: ``queued`` > 15 min, or ``partial`` with work left and no successor."""
        rows = await self._pool.fetch(
            "SELECT r.id, r.target, r.status FROM refresh_job r WHERE r.kind = $1 AND ("
            " (r.status = 'queued' AND r.requested_at < now() - make_interval(mins => $2))"
            " OR (r.status = 'partial'"
            "     AND jsonb_array_length(COALESCE(r.result->'remaining', '[]'::jsonb)) > 0"
            "     AND NOT EXISTS (SELECT 1 FROM refresh_job j WHERE j.kind = r.kind"
            "                     AND j.target = r.target AND j.id > r.id))) ORDER BY r.id",
            POST_IMPORT,
            QUEUED_STALE_MIN,
        )
        return [(int(r["id"]), r["target"], r["status"]) for r in rows]


_pool: asyncpg.Pool | None = None


async def _shared_pool() -> asyncpg.Pool:
    global _pool
    if _pool is None:
        from worker.db import create_pool

        _pool = await create_pool()
    return _pool


async def post_import_handler(job: HttpJob) -> HttpJobResult:
    """worker-http handler for kind ``post_import``: stops starting symbols at 3.5 minutes."""
    pool = await _shared_pool()
    deadline = time.monotonic() + STOP_AFTER_S
    return await run_post_import(
        PgPostImportStore(pool),
        job_id=job.job_id,
        target=job.target,
        step=SymbolProcessor(pool),
        should_stop=lambda: time.monotonic() >= deadline,
    )


async def process_queued_work(
    store: PgPostImportStore,
    step: SymbolStep,
    ctx: JobContext,
    hooks: Hooks | None = None,
) -> list[dict[str, Any]]:
    """docs/04 3.13: continue stale ``queued`` / ``partial`` post_import jobs, no 4-minute cap.

    The runner's own deadline (the 20-minute workflow timeout) is the only stop; remaining work
    is re-enqueued by ``run_post_import``.
    """
    work = await store.queued_work()
    ctx.items_total = len(work)
    summaries: list[dict[str, Any]] = []
    for position, (job_id, target, status) in enumerate(work):
        if ctx.past_deadline():
            ctx.timed_out = True
            ctx.remaining = [w[0] for w in work[position:]]
            break
        if ctx.dry_run:
            summaries.append({"job_id": job_id, "target": target, "status": status})
            continue
        if status == "partial":  # crashed before the successor was enqueued
            partial = await store.job_result(job_id) or {}
            new_id = await store.enqueue_continuation(target, partial)
            if new_id is None:
                continue
            job_id = new_id
        if not await store.claim(job_id):
            continue
        try:
            res = await run_post_import(
                store,
                job_id=job_id,
                target=target,
                step=step,
                should_stop=ctx.past_deadline,
                hooks=hooks,
            )
        except Exception as exc:
            ctx.record_item_error(job_id, exc)
            await store.finish(job_id, "failed", {}, scrub(f"{type(exc).__name__}: {exc}"))
            continue
        await store.finish(job_id, res.status, res.result, res.error)
        summaries.append({"job_id": job_id, "status": res.status})
    return summaries
