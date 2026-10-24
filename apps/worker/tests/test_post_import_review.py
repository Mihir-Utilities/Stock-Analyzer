"""Review fixes for B09/D03: SYS-12b..12f (stale queued kinds, hard cap keeps progress, reaper,
stage, notifier wiring, concurrent batches, 3.5-minute stop with a symbol in flight)."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Sequence
from typing import Any

import asyncpg
import httpx  # noqa: TID251 - mock transport for the notifier
import pytest
from pricegen import make_series

from worker import egress, jobs, notify, post_import
from worker.db import PgJobQueue
from worker.jobs import HttpJob, HttpJobResult
from worker.notify import TelegramNotifier
from worker.post_import import (
    STOP_AFTER_S,
    Hooks,
    PgPostImportStore,
    SymbolProcessor,
    process_queued_work,
    run_post_import,
)
from worker.runner import JobContext

pytestmark = pytest.mark.anyio


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


class Rec:
    def __init__(self) -> None:
        self.sent: list[str] = []

    async def send_html(self, text: str) -> None:
        self.sent.append(text)


async def _noop(symbol: str) -> None:
    return None


def _hooks() -> Hooks:
    async def screener(symbols: Sequence[str]) -> None:
        return None

    return Hooks(_noop, _noop, screener)


# --------------------------------------------------------------------------- SYS-12b
@pytest.mark.integration
async def test_sys12b_stale_queued_mf_refresh_is_run_and_young_or_unknown_kinds_are_not(
    pg_full: asyncpg.Pool,
) -> None:
    await pg_full.execute(
        "INSERT INTO refresh_job (kind, target, status, requested_at) VALUES "
        "('mf_refresh', '119551', 'queued', now() - interval '1 hour'),"
        "('mf_refresh', '119552', 'queued', now() - interval '1 minute'),"
        "('stock_refresh', 'TCS', 'queued', now() - interval '1 hour')"
    )
    seen: list[HttpJob] = []

    async def handler(job: HttpJob) -> HttpJobResult:
        seen.append(job)
        return HttpJobResult("ok", {"rows_written": 3})

    async def step(symbol: str) -> dict[str, Any]:
        raise AssertionError("no post_import in this test")

    out = await process_queued_work(
        PgPostImportStore(pg_full),
        step,
        JobContext(job="pq"),
        hooks=_hooks(),
        handlers={"mf_refresh": handler},
    )
    assert [(j.kind, j.target) for j in seen] == [("mf_refresh", "119551")]
    assert out == [{"job_id": seen[0].job_id, "kind": "mf_refresh", "status": "ok"}]
    rows = await pg_full.fetch("SELECT target, status, result FROM refresh_job ORDER BY id")
    assert [(r["target"], r["status"]) for r in rows] == [
        ("119551", "ok"),
        ("119552", "queued"),  # younger than 15 minutes
        ("TCS", "queued"),  # no handler (broker mode, inactive)
    ]
    assert json.loads(rows[0]["result"]) == {"rows_written": 3}


@pytest.mark.integration
async def test_sys12b_a_failing_stale_handler_marks_the_row_failed_and_frees_the_index(
    pg_full: asyncpg.Pool,
) -> None:
    await pg_full.execute(
        "INSERT INTO refresh_job (kind, target, status, requested_at) VALUES "
        "('mf_refresh', '1', 'queued', now() - interval '1 hour')"
    )

    async def boom(job: HttpJob) -> HttpJobResult:
        raise RuntimeError("source down")

    async def step(symbol: str) -> dict[str, Any]:
        return {}

    await process_queued_work(
        PgPostImportStore(pg_full),
        step,
        JobContext(job="pq"),
        hooks=_hooks(),
        handlers={"mf_refresh": boom},
    )
    assert await pg_full.fetchval("SELECT status FROM refresh_job") == "failed"
    # the unique active-job index no longer blocks a new row
    await pg_full.execute("INSERT INTO refresh_job (kind, target) VALUES ('mf_refresh', '1')")


# --------------------------------------------------------------------------- reaper
@pytest.mark.integration
async def test_sys12c_reaper_frees_stale_running_rows(pg_full: asyncpg.Pool) -> None:
    await pg_full.execute(
        "INSERT INTO refresh_job (kind, target, status, started_at, result) VALUES "
        "('mf_refresh', '10', 'running', now() - interval '41 minutes', NULL),"
        "('mf_refresh', '11', 'running', now() - interval '5 minutes', NULL),"
        "('post_import', 'batch:1', 'running', now() - interval '2 hours', $1::jsonb)",
        json.dumps({"remaining": ["B", "C"], "all": ["A", "B", "C"], "symbols_done": 1}),
    )
    reaped = await PgPostImportStore(pg_full).reap_stale_running()
    assert len(reaped) == 2
    rows = {
        r["target"]: r for r in await pg_full.fetch("SELECT target, status, error FROM refresh_job")
    }
    assert rows["10"]["status"] == "failed" and "reaped" in rows["10"]["error"]
    assert rows["11"]["status"] == "running"  # young: a live job is never reaped
    assert rows["batch:1"]["status"] == "partial"  # progress kept, resumable
    # the unique index is free again and the partial post_import is picked up
    await pg_full.execute("INSERT INTO refresh_job (kind, target) VALUES ('mf_refresh', '10')")
    work = await PgPostImportStore(pg_full).queued_work()
    assert [(w[1], w[2], w[3]) for w in work] == [("post_import", "batch:1", "partial")]


# --------------------------------------------------------------------------- hard cap keeps progress
@pytest.mark.integration
async def test_sys12d_hard_cap_mid_symbol_keeps_remaining_and_job_resumes(
    pg_full: asyncpg.Pool,
) -> None:
    symbols = ["AAA", "BBB", "CCC"]
    await _seed_symbols(pg_full, symbols)
    job_id = await pg_full.fetchval(
        "INSERT INTO refresh_job (kind, target, status, result) "
        "VALUES ('post_import', 'batch:1', 'queued', $1::jsonb) RETURNING id",
        json.dumps({"remaining": symbols, "symbols_total": 3, "symbols_done": 0}),
    )
    store = PgPostImportStore(pg_full)
    queue = PgJobQueue(pg_full)
    assert await queue.claim(job_id)
    inner = SymbolProcessor(pg_full, hooks=_hooks())

    async def hang_on_second(symbol: str) -> dict[str, Any]:
        if symbol == "BBB":
            await asyncio.sleep(30)  # in flight when the hard cap fires
        return await inner(symbol)

    with pytest.raises(TimeoutError):
        await asyncio.wait_for(
            run_post_import(
                store,
                job_id=job_id,
                target="batch:1",
                step=hang_on_second,
                should_stop=lambda: False,
                hooks=_hooks(),
            ),
            timeout=1.0,
        )
    # worker-http's timeout path: status partial for a resumable kind, result untouched (None)
    await queue.finish(job_id, status="partial", result=None, error="hard_timeout")
    row = await pg_full.fetchrow(
        "SELECT status, error, result FROM refresh_job WHERE id = $1", job_id
    )
    assert row is not None and row["status"] == "partial" and row["error"] == "hard_timeout"
    kept = json.loads(row["result"])
    assert kept["remaining"] == ["BBB", "CCC"] and kept["symbols_done"] == 1

    # resumable: process_queued_jobs continues the partial row without redoing AAA
    done: list[str] = []

    async def counting(symbol: str) -> dict[str, Any]:
        done.append(symbol)
        return await inner(symbol)

    out = await process_queued_work(store, counting, JobContext(job="pq"), hooks=_hooks())
    assert done == ["BBB", "CCC"] and [o["status"] for o in out] == ["ok"]
    assert await pg_full.fetchval("SELECT count(*) FROM corporate_action") == 3


@pytest.mark.integration
async def test_sys12e_stage_is_written_at_each_phase(pg_full: asyncpg.Pool) -> None:
    await _seed_symbols(pg_full, ["AAA"])
    job_id = await pg_full.fetchval(
        "INSERT INTO refresh_job (kind, target, status, result) "
        "VALUES ('post_import', 'batch:1', 'running', $1::jsonb) RETURNING id",
        json.dumps({"remaining": ["AAA"], "symbols_total": 1, "symbols_done": 0}),
    )
    stages: list[str] = []

    class Spy(PgPostImportStore):
        async def set_stage(self, job_id: int, stage: str) -> None:
            stages.append(stage)
            await super().set_stage(job_id, stage)

    seen_mid: dict[str, str | None] = {}

    async def alerts(symbol: str) -> None:
        raw = await pg_full.fetchval("SELECT result FROM refresh_job WHERE id = $1", job_id)
        seen_mid["stage"] = json.loads(raw).get("stage")

    hooks = Hooks(_noop, alerts, _hooks().recompute_screener)
    res = await run_post_import(
        Spy(pg_full),
        job_id=job_id,
        target="batch:1",
        step=SymbolProcessor(pg_full, hooks=hooks),
        should_stop=lambda: False,
        hooks=hooks,
    )
    assert stages == ["detect_actions", "compute_analysis", "alerts"]
    assert seen_mid["stage"] == "alerts"  # visible in refresh_job.result while the job runs
    assert res.result["stage"] == "alerts" and res.status == "ok"


# --------------------------------------------------------------------------- notifier wiring
def _mock_telegram(monkeypatch: pytest.MonkeyPatch, calls: list[httpx.Request]) -> None:
    def handle(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(200, json={"ok": True})

    real = egress.make_client
    monkeypatch.setattr(
        notify, "make_client", lambda inner=None: real(inner=httpx.MockTransport(handle))
    )


@pytest.mark.integration
async def test_sys12f_production_wiring_sends_one_note_per_new_action_and_none_without_token(
    pg_full: asyncpg.Pool, monkeypatch: pytest.MonkeyPatch
) -> None:
    await _seed_symbols(pg_full, ["AAA", "BBB"])
    await pg_full.execute(
        "INSERT INTO app_user (password_hash, telegram_chat_id) VALUES ('x', 4242)"
    )
    calls: list[httpx.Request] = []
    _mock_telegram(monkeypatch, calls)
    monkeypatch.setattr(post_import, "_pool", pg_full)
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "123:test-token")

    async def run(target: str, remaining: list[str]) -> HttpJobResult:
        job_id = await pg_full.fetchval(
            "INSERT INTO refresh_job (kind, target, status, result) "
            "VALUES ('post_import', $1, 'running', $2::jsonb) RETURNING id",
            target,
            json.dumps({"remaining": remaining}),
        )
        return await post_import.post_import_handler(HttpJob(job_id, "post_import", target))

    first = await run("batch:1", ["AAA", "BBB"])
    assert first.status == "ok" and len(calls) == 2  # one note per new action
    body = json.loads(calls[0].content)
    assert body["chat_id"] == 4242 and body["parse_mode"] == "HTML"
    assert body["text"].startswith("Possible split/bonus on AAA")
    again = await run("batch:2", ["AAA", "BBB"])  # idempotent: nothing new, nothing sent
    assert again.status == "ok" and len(calls) == 2

    # no token: skipped with a clear status, never a crash, no HTTP call
    await pg_full.execute("DELETE FROM corporate_action")
    monkeypatch.delenv("TELEGRAM_BOT_TOKEN")
    third = await run("batch:3", ["AAA"])
    assert third.status == "ok" and len(calls) == 2
    notifier = TelegramNotifier(pg_full)
    await notifier.send_html("x")
    assert notifier.last_status == "no_token"


@pytest.mark.integration
async def test_notifier_not_linked_and_failed_send_never_raise(
    pg_full: asyncpg.Pool, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[httpx.Request] = []
    _mock_telegram(monkeypatch, calls)
    n = TelegramNotifier(pg_full, token_provider=lambda: "t")
    await n.send_html("x")
    assert n.last_status == "not_linked" and calls == []
    await pg_full.execute("INSERT INTO app_user (password_hash, telegram_chat_id) VALUES ('x', 1)")

    def boom(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("down")

    real = egress.make_client
    monkeypatch.setattr(
        notify, "make_client", lambda inner=None: real(inner=httpx.MockTransport(boom))
    )
    await n.send_html("x")
    assert n.last_status == "failed"


# --------------------------------------------------------------------------- concurrency
@pytest.mark.integration
async def test_sys12g_two_batches_same_symbols_run_at_once_create_one_action_each(
    pg_full: asyncpg.Pool,
) -> None:
    symbols = ["AAA", "BBB", "CCC"]
    await _seed_symbols(pg_full, symbols)
    for target in ("batch:1", "batch:2"):
        await pg_full.execute(
            "INSERT INTO refresh_job (kind, target, status, result, requested_at) VALUES "
            "('post_import', $1, 'queued', $2::jsonb, now() - interval '1 hour')",
            target,
            json.dumps({"remaining": symbols}),
        )
    rec = Rec()
    store = PgPostImportStore(pg_full)
    step = SymbolProcessor(pg_full, notifier=rec, hooks=_hooks())
    first_id = await pg_full.fetchval("SELECT min(id) FROM refresh_job")
    assert await store.claim(first_id)  # worker-http took batch:1 ...

    http_side = run_post_import(
        store, job_id=first_id, target="batch:1", step=step, should_stop=lambda: False,
        hooks=_hooks(),
    )  # fmt: skip
    cron_side = process_queued_work(store, step, JobContext(job="pq"), hooks=_hooks())
    res, summaries = await asyncio.gather(http_side, cron_side)  # ... while the cron runs batch:2
    await store.finish(first_id, res.status, res.result, res.error)
    assert res.status == "ok" and [s["status"] for s in summaries] == ["ok"]
    assert await pg_full.fetchval("SELECT count(*) FROM corporate_action") == 3
    assert len(rec.sent) == 3  # exactly one note per action, not per batch
    assert await pg_full.fetchval("SELECT count(*) FROM refresh_job WHERE status = 'ok'") == 2


# --------------------------------------------------------------------------- 3.5-minute stop
async def test_sys12h_stop_at_3_5_minutes_lets_the_symbol_in_flight_finish(clock) -> None:  # type: ignore[no-untyped-def]
    class Store:
        def __init__(self) -> None:
            self.result: dict[str, Any] = {"remaining": ["A", "B", "C"], "symbols_total": 3}
            self.partial: dict[str, Any] | None = None
            self.continuation: dict[str, Any] | None = None

        async def job_result(self, job_id: int) -> dict[str, Any] | None:
            return self.result

        async def mark_partial(self, job_id: int, result: dict[str, Any]) -> None:
            self.partial = result

        async def checkpoint(self, job_id: int, result: dict[str, Any]) -> None:
            self.result = result

        async def set_stage(self, job_id: int, stage: str) -> None:
            return None

        async def enqueue_continuation(self, target: str, result: dict[str, Any]) -> int | None:
            self.continuation = result
            return 2

    started: list[str] = []
    finished: list[str] = []
    start = clock.t

    async def step(symbol: str) -> dict[str, Any]:
        started.append(symbol)
        if symbol == "B":
            clock.t += STOP_AFTER_S - 10  # B starts at 100 s... and runs past the 210 s mark
            clock.t += 120
        else:
            clock.t += 100
        finished.append(symbol)
        return {"detect": {"new_actions": []}}

    store = Store()
    res = await run_post_import(
        store,
        job_id=1,
        target="batch:1",
        step=step,
        should_stop=lambda: clock.t - start >= STOP_AFTER_S,
        hooks=_hooks(),
    )
    # B was in flight when 3.5 min passed: it completes (never abandoned), C is not started
    assert started == ["A", "B"] and finished == ["A", "B"]
    assert res.status == "partial" and res.result["remaining"] == ["C"]
    assert store.partial is not None and store.continuation == res.result
    assert res.result["symbols_done"] == 2
    assert jobs.RESUMABLE_KINDS == {"post_import"}
