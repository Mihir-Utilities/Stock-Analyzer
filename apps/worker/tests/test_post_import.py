"""post_import (docs/04 3.12) and process_queued_jobs (3.13): SYS-12, SYS-09, per-item isolation."""

from __future__ import annotations

import json
from collections.abc import Sequence
from typing import Any

import asyncpg
import httpx  # noqa: TID251 - ASGI test transport
import pytest
from pricegen import make_series

from worker import jobs
from worker.http import create_app, sign
from worker.post_import import (
    STOP_AFTER_S,
    Hooks,
    PgPostImportStore,
    SymbolProcessor,
    post_import_handler,
    process_queued_work,
    run_post_import,
)
from worker.runner import JobContext

pytestmark = pytest.mark.anyio


class MemStore:
    """In-memory ``PostImportStore`` that mimics the unique active-job index."""

    def __init__(self, result: dict[str, Any] | None) -> None:
        self.rows: list[dict[str, Any]] = [{"id": 1, "status": "running", "result": result}]

    async def job_result(self, job_id: int) -> dict[str, Any] | None:
        return self.rows[job_id - 1]["result"]

    async def mark_partial(self, job_id: int, result: dict[str, Any]) -> None:
        self.rows[job_id - 1].update(status="partial", result=result)

    async def checkpoint(self, job_id: int, result: dict[str, Any]) -> None:
        self.rows[job_id - 1]["result"] = result

    async def set_stage(self, job_id: int, stage: str) -> None:
        self.rows[job_id - 1].setdefault("stages", []).append(stage)

    async def enqueue_continuation(self, target: str, result: dict[str, Any]) -> int | None:
        if any(r["status"] in ("queued", "running") for r in self.rows):
            raise AssertionError("continuation inserted while the job is still active")
        self.rows.append({"id": len(self.rows) + 1, "status": "queued", "result": result})
        return len(self.rows)


class Steps:
    def __init__(self, clock: Any, cost_s: float = 0.0, fail: set[str] | None = None) -> None:
        self.clock, self.cost_s, self.fail = clock, cost_s, fail or set()
        self.calls: list[str] = []

    async def __call__(self, symbol: str) -> dict[str, Any]:
        self.calls.append(symbol)
        self.clock.t += self.cost_s
        if symbol in self.fail:
            raise ValueError(f"boom {symbol}")
        return {"detect": {"new_actions": [symbol]}}


def _seed(symbols: Sequence[str]) -> dict[str, Any]:
    return {"remaining": list(symbols), "symbols_total": len(symbols), "symbols_done": 0}


async def test_sys12_stops_at_3_5_minutes_stores_progress_and_enqueues_the_rest(clock) -> None:  # type: ignore[no-untyped-def]
    assert STOP_AFTER_S == 210
    store = MemStore(_seed(["A", "B", "C", "D", "E"]))
    steps = Steps(clock, cost_s=60.0)
    start = clock.t
    res = await run_post_import(
        store,
        job_id=1,
        target="batch:7",
        step=steps,
        should_stop=lambda: clock.t - start >= STOP_AFTER_S,
    )
    assert res.status == "partial"
    assert steps.calls == ["A", "B", "C", "D"]  # the 5th would start at 240 s: not started
    assert res.result["symbols_total"] == 5 and res.result["symbols_done"] == 4
    assert res.result["remaining"] == ["E"]
    assert [r["status"] for r in store.rows] == ["partial", "queued"]
    assert store.rows[1]["result"]["remaining"] == ["E"]

    # the continuation (same target, new row) finishes the rest; no symbol ran twice
    store.rows[1]["status"] = "running"
    done = await run_post_import(
        store, job_id=2, target="batch:7", step=steps, should_stop=lambda: False
    )
    assert done.status == "ok" and done.result["remaining"] == []
    assert done.result["symbols_done"] == 5 and done.result["new_actions"] == 5
    assert steps.calls == ["A", "B", "C", "D", "E"]


async def test_symbols_are_processed_in_order_and_screener_runs_once_at_the_end(clock) -> None:  # type: ignore[no-untyped-def]
    seen: list[Sequence[str]] = []

    async def screener(symbols: Sequence[str]) -> None:
        seen.append(list(symbols))

    store = MemStore(_seed(["Z", "A", "M"]))
    steps = Steps(clock)
    res = await run_post_import(
        store,
        job_id=1,
        target="batch:1",
        step=steps,
        should_stop=lambda: False,
        hooks=Hooks(recompute_screener=screener),
    )
    assert steps.calls == ["Z", "A", "M"] and res.status == "ok"
    assert seen == [["Z", "A", "M"]]


async def test_partial_run_does_not_recompute_the_screener(clock) -> None:  # type: ignore[no-untyped-def]
    seen: list[Sequence[str]] = []

    async def screener(symbols: Sequence[str]) -> None:
        seen.append(list(symbols))

    store = MemStore(_seed(["A", "B"]))
    ticks = iter([False, True])
    res = await run_post_import(
        store,
        job_id=1,
        target="batch:1",
        step=Steps(clock),
        should_stop=lambda: next(ticks),
        hooks=Hooks(recompute_screener=screener),
    )
    assert res.status == "partial" and seen == []


async def test_one_symbol_failing_never_fails_the_job(clock) -> None:  # type: ignore[no-untyped-def]
    store = MemStore(_seed(["A", "BAD", "C"]))
    steps = Steps(clock, fail={"BAD"})
    res = await run_post_import(
        store, job_id=1, target="batch:1", step=steps, should_stop=lambda: False
    )
    assert res.status == "ok" and steps.calls == ["A", "BAD", "C"]
    assert res.result["symbols_done"] == 3
    assert [f["symbol"] for f in res.result["failed"]] == ["BAD"]
    assert "boom BAD" in res.result["failed"][0]["error"]


async def test_missing_symbol_list_fails_cleanly(clock) -> None:  # type: ignore[no-untyped-def]
    for result in (None, {}, {"remaining": "A,B"}):
        res = await run_post_import(
            MemStore(result),
            job_id=1,
            target="batch:1",
            step=Steps(clock),
            should_stop=lambda: False,
        )
        assert res.status == "failed" and res.error


async def test_empty_remaining_is_a_clean_ok(clock) -> None:  # type: ignore[no-untyped-def]
    res = await run_post_import(
        MemStore(_seed([])),
        job_id=1,
        target="batch:1",
        step=Steps(clock),
        should_stop=lambda: False,
    )
    assert res.status == "ok" and res.result["symbols_done"] == 0


# --------------------------------------------------------------------------- Postgres
class Recorder:
    def __init__(self) -> None:
        self.analysis: list[str] = []
        self.alerts: list[str] = []
        self.screener: list[list[str]] = []

    def hooks(self) -> Hooks:
        async def analysis(symbol: str) -> None:
            self.analysis.append(symbol)

        async def alerts(symbol: str) -> None:
            self.alerts.append(symbol)

        async def screener(symbols: Sequence[str]) -> None:
            self.screener.append(list(symbols))

        return Hooks(analysis, alerts, screener)


async def _seed_symbols(pool: asyncpg.Pool, symbols: Sequence[str]) -> None:
    for symbol in symbols:
        iid = await pool.fetchval(
            "INSERT INTO instrument (symbol, name) VALUES ($1, $1) RETURNING id", symbol
        )
        await pool.executemany(
            "INSERT INTO price_daily (instrument_id, trade_date, open, high, low, close, "
            "adj_close, volume, source) VALUES ($1, $2, $3, $3, $3, $3, $3, $4, 'import')",
            [
                (iid, b.trade_date, b.close, b.volume)
                for b in make_series(60, jumps={40: (0.5, 3.0)})
            ],
        )


@pytest.mark.integration
async def test_sys12_postgres_partial_continuation_and_process_queued_jobs(
    pg_full: asyncpg.Pool,
) -> None:
    symbols = ["AAA", "BBB", "CCC"]
    await _seed_symbols(pg_full, symbols)
    job_id = await pg_full.fetchval(
        "INSERT INTO refresh_job (kind, target, status, result) "
        "VALUES ('post_import', 'batch:1', 'running', $1::jsonb) RETURNING id",
        json.dumps({"remaining": symbols, "symbols_total": 3, "symbols_done": 0}),
    )
    store = PgPostImportStore(pg_full)
    rec = Recorder()
    step = SymbolProcessor(pg_full, hooks=rec.hooks())
    started: list[str] = []

    async def counting(symbol: str) -> dict[str, Any]:
        started.append(symbol)
        return await step(symbol)

    res = await run_post_import(
        store,
        job_id=job_id,
        target="batch:1",
        step=counting,
        should_stop=lambda: len(started) >= 2,  # the 3.5-minute stop, simulated
        hooks=rec.hooks(),
    )
    assert res.status == "partial" and started == ["AAA", "BBB"]
    rows = await pg_full.fetch("SELECT id, status, result FROM refresh_job ORDER BY id")
    assert [r["status"] for r in rows] == ["partial", "queued"]
    cont = json.loads(rows[1]["result"])
    assert cont["remaining"] == ["CCC"] and cont["symbols_done"] == 2 and cont["symbols_total"] == 3
    # only one active job per (kind, target): a second enqueue is refused by the unique index
    assert await store.enqueue_continuation("batch:1", cont) is None

    # not stale yet (< 15 min): process_queued_jobs leaves it alone
    ctx = JobContext(job="process_queued_jobs")
    assert await process_queued_work(store, step, ctx, hooks=rec.hooks()) == []
    await pg_full.execute("UPDATE refresh_job SET requested_at = now() - interval '16 minutes'")
    summaries = await process_queued_work(store, step, JobContext(job="pq"), hooks=rec.hooks())
    assert summaries == [{"job_id": rows[1]["id"], "kind": "post_import", "status": "ok"}]
    final = await pg_full.fetch("SELECT status, result FROM refresh_job ORDER BY id")
    assert [r["status"] for r in final] == ["partial", "ok"]
    assert json.loads(final[1]["result"])["symbols_done"] == 3

    # no duplicate actions or hook calls (idempotent), each symbol exactly once
    assert await pg_full.fetchval("SELECT count(*) FROM corporate_action") == 3
    assert await pg_full.fetchval("SELECT count(DISTINCT instrument_id) FROM corporate_action") == 3
    assert rec.analysis == symbols and rec.alerts == symbols
    assert rec.screener == [symbols]  # once, after the last symbol, for all affected symbols
    # a repeat pass finds nothing left to do
    assert await store.queued_work() == []


@pytest.mark.integration
async def test_process_queued_jobs_resumes_a_partial_row_without_successor(
    pg_full: asyncpg.Pool,
) -> None:
    await _seed_symbols(pg_full, ["AAA", "BBB"])
    await pg_full.execute(
        "INSERT INTO refresh_job (kind, target, status, result) VALUES "
        "('post_import', 'batch:9', 'partial', $1::jsonb)",
        json.dumps(
            {"remaining": ["BBB"], "all": ["AAA", "BBB"], "symbols_total": 2, "symbols_done": 1}
        ),
    )
    # a queued row of another target younger than 15 minutes must not be touched
    await pg_full.execute(
        "INSERT INTO refresh_job (kind, target, status, result) VALUES "
        "('post_import', 'batch:10', 'queued', $1::jsonb)",
        json.dumps({"remaining": ["AAA"]}),
    )
    store = PgPostImportStore(pg_full)
    rec = Recorder()
    summaries = await process_queued_work(
        store, SymbolProcessor(pg_full, hooks=rec.hooks()), JobContext(job="pq"), hooks=rec.hooks()
    )
    assert [s["status"] for s in summaries] == ["ok"]
    assert rec.analysis == ["BBB"]
    rows = await pg_full.fetch("SELECT target, status FROM refresh_job ORDER BY id")
    assert [(r["target"], r["status"]) for r in rows] == [
        ("batch:9", "partial"),
        ("batch:10", "queued"),
        ("batch:9", "ok"),
    ]
    assert rec.screener == [["AAA", "BBB"]]


@pytest.mark.integration
async def test_process_queued_jobs_stops_at_the_job_deadline_and_requeues(
    pg_full: asyncpg.Pool,
) -> None:
    await _seed_symbols(pg_full, ["AAA", "BBB", "CCC"])
    await pg_full.execute(
        "INSERT INTO refresh_job (kind, target, status, result, requested_at) VALUES "
        "('post_import', 'batch:1', 'queued', $1::jsonb, now() - interval '1 hour')",
        json.dumps({"remaining": ["AAA", "BBB", "CCC"]}),
    )
    t = {"now": 0.0}
    ctx = JobContext(job="pq", deadline=100.0, clock=lambda: t["now"])
    inner = SymbolProcessor(pg_full, hooks=Recorder().hooks())

    async def slow(symbol: str) -> dict[str, Any]:
        t["now"] += 60.0
        return await inner(symbol)

    store = PgPostImportStore(pg_full)
    summaries = await process_queued_work(store, slow, ctx, hooks=Recorder().hooks())
    assert [(x["kind"], x["status"]) for x in summaries] == [("post_import", "partial")]
    rows = await pg_full.fetch("SELECT status, result FROM refresh_job ORDER BY id")
    assert [r["status"] for r in rows] == ["partial", "queued"]
    assert json.loads(rows[1]["result"])["remaining"] == ["CCC"]


# --------------------------------------------------------------------------- worker-http wiring
async def test_post_import_handler_is_registered_for_worker_http() -> None:
    assert jobs.HTTP_HANDLERS["post_import"] is post_import_handler
    assert "post_import" in jobs.HTTP_ALLOWED_KINDS
    for name in ("detect_actions", "readjust_prices", "process_queued_jobs"):
        assert name in jobs.CLI_JOBS
    assert jobs.CLI_JOBS["process_queued_jobs"].timeout_s == 20 * 60


class _Queue:
    async def get(self, job_id: int) -> tuple[str, str, str] | None:
        return ("post_import", "batch:1", "queued")

    async def claim(self, job_id: int) -> bool:
        return True

    async def finish(self, *a: Any, **k: Any) -> None:
        return None


async def test_sys09_post_import_request_with_121_seconds_skew_is_rejected() -> None:
    key, now = "test-hmac-key-not-a-secret", 1_800_000_000.0

    async def queue() -> _Queue:
        return _Queue()

    app = create_app(queue_factory=queue, key_provider=lambda: key, clock=lambda: now)
    body = json.dumps({"job_id": 1}).encode()
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://worker.test"
    ) as client:
        for skew, status in ((121, 401), (-121, 401)):
            ts = str(int(now) + skew)
            headers = {"X-Timestamp": ts, "X-Signature": sign(key, ts, "POST", "/run", body)}
            r = await client.post("/run", content=body, headers=headers)
            assert r.status_code == status


# --------------------------------------------------------------------------- CLI jobs
@pytest.mark.integration
async def test_cli_jobs_detect_readjust_and_process_queued(
    pg_full: asyncpg.Pool, monkeypatch: pytest.MonkeyPatch, run_store
) -> None:  # type: ignore[no-untyped-def]
    import os

    from worker.runner import run_job

    monkeypatch.setenv("DATABASE_URL", os.environ["TEST_DATABASE_URL"])
    await _seed_symbols(pg_full, ["AAA", "BBB"])
    await pg_full.execute("UPDATE instrument SET is_tracked = true WHERE symbol = 'AAA'")

    dry = await run_job(jobs.CLI_JOBS["detect_actions"], None, dry_run=True, symbols=["AAA"])
    assert dry.status == "ok" and len(dry.details["new_actions"]["AAA"]) == 1
    assert await pg_full.fetchval("SELECT count(*) FROM corporate_action") == 0

    res = await run_job(jobs.CLI_JOBS["detect_actions"], run_store)  # default: tracked stocks
    assert res.status == "ok" and res.items_total == 1 and res.rows_written == 1
    assert await pg_full.fetchval("SELECT count(*) FROM corporate_action") == 1

    await pg_full.execute(
        "UPDATE corporate_action SET status = 'confirmed', action_type = 'split', "
        "ratio_num = 2, ratio_den = 1"
    )
    res = await run_job(jobs.CLI_JOBS["readjust_prices"], run_store, symbols=["AAA"])
    assert res.status == "ok" and res.rows_written == 40

    await pg_full.execute(
        "INSERT INTO refresh_job (kind, target, status, result, requested_at) VALUES "
        "('post_import', 'batch:3', 'queued', $1::jsonb, now() - interval '1 hour')",
        json.dumps({"remaining": ["BBB"]}),
    )
    res = await run_job(jobs.CLI_JOBS["process_queued_jobs"], run_store)
    assert res.status == "ok" and res.details["jobs"][0]["status"] == "ok"
    assert await pg_full.fetchval("SELECT status FROM refresh_job") == "ok"
