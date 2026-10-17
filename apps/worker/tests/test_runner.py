"""Runner contract: lock/skip (SYS-05), timeout -> partial, per-item isolation, dry run, CLI."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

import pytest

from worker import jobs
from worker.__main__ import main
from worker.runner import JobContext, JobSpec, run_job

pytestmark = pytest.mark.anyio


async def _noop(ctx: JobContext) -> None:
    ctx.add_rows(3)


async def test_ok_run_writes_counts(run_store) -> None:  # type: ignore[no-untyped-def]
    res = await run_job(JobSpec("j", 60, _noop), run_store)
    assert res.status == "ok" and res.rows_written == 3
    assert run_store.runs[0]["status"] == "ok" and run_store.runs[0]["rows_written"] == 3


async def test_sys05_overlapping_runs_second_is_skipped(run_store) -> None:  # type: ignore[no-untyped-def]
    started, release = asyncio.Event(), asyncio.Event()

    async def slow(ctx: JobContext) -> None:
        started.set()
        await release.wait()

    spec = JobSpec("ingest_mf_navs", 60, slow)
    first = asyncio.create_task(run_job(spec, run_store))
    await started.wait()
    second = await run_job(spec, run_store)
    assert second.status == "skipped" and second.details["reason"] == "already_running"
    release.set()
    assert (await first).status == "ok"
    assert [r["status"] for r in run_store.runs] == ["ok", "skipped"]
    # lock is released afterwards
    assert (await run_job(spec, run_store)).status == "ok"


async def test_different_jobs_do_not_block_each_other(run_store) -> None:  # type: ignore[no-untyped-def]
    assert await run_store.try_lock("a") is not None
    assert (await run_job(JobSpec("b", 60, _noop), run_store)).status == "ok"


async def test_stale_running_row_older_than_twice_timeout_is_failed_and_replaced(run_store) -> None:  # type: ignore[no-untyped-def]
    await run_store.try_lock("j")
    run_store.runs[0]["started_at"] = datetime.now(UTC) - timedelta(seconds=121)
    res = await run_job(JobSpec("j", 60, _noop), run_store)
    assert res.status == "ok"
    assert run_store.runs[0]["status"] == "failed" and run_store.runs[0]["error"] == "stale_run"


async def test_fresh_running_row_is_not_taken_over(run_store) -> None:  # type: ignore[no-untyped-def]
    await run_store.try_lock("j")
    run_store.runs[0]["started_at"] = datetime.now(UTC) - timedelta(seconds=119)
    assert (await run_job(JobSpec("j", 60, _noop), run_store)).status == "skipped"


async def test_timeout_marks_partial_after_finishing_current_item(run_store, clock) -> None:  # type: ignore[no-untyped-def]
    done: list[int] = []

    async def work(ctx: JobContext) -> None:
        async def one(n: int) -> None:
            clock.t += 30  # each item takes 30 s on the fake clock
            done.append(n)

        await ctx.for_each(list(range(10)), one)

    res = await run_job(JobSpec("j", 100, work), run_store, clock=clock)
    assert done == [0, 1, 2, 3]  # item 3 started at t=90 < 100 and was allowed to finish
    assert res.status == "partial" and res.items_total == 10
    row = run_store.runs[0]
    assert row["status"] == "partial"
    assert row["details"]["timed_out"] is True and row["details"]["items_remaining"] == 6


async def test_per_item_isolation_keeps_first_50_errors(run_store) -> None:  # type: ignore[no-untyped-def]
    async def work(ctx: JobContext) -> None:
        async def one(n: int) -> None:
            if n % 2 == 0:
                raise ValueError(f"bad item {n} password=hunter2hunter2")
            ctx.add_rows(1)

        await ctx.for_each(list(range(200)), one)

    res = await run_job(JobSpec("j", 60, work), run_store)
    assert res.status == "ok" and res.items_failed == 100 and res.rows_written == 100
    errors = run_store.runs[0]["details"]["errors"]
    assert len(errors) == 50 and errors[0]["item"] == "0"
    assert "hunter2hunter2" not in str(errors)


async def test_exception_escaping_the_job_marks_failed_and_releases_lock(run_store) -> None:  # type: ignore[no-untyped-def]
    async def boom(ctx: JobContext) -> None:
        raise RuntimeError("db down postgres://u:topsecretpw@h/db")

    res = await run_job(JobSpec("j", 60, boom), run_store)
    assert res.status == "failed" and "topsecretpw" not in (res.error or "")
    assert run_store.runs[0]["status"] == "failed"
    assert (await run_job(JobSpec("j", 60, _noop), run_store)).status == "ok"


async def test_job_can_mark_itself_partial(run_store) -> None:  # type: ignore[no-untyped-def]
    async def work(ctx: JobContext) -> None:
        ctx.mark_partial("source_disabled")

    res = await run_job(JobSpec("j", 60, work), run_store)
    assert (
        res.status == "partial"
        and run_store.runs[0]["details"]["partial_reason"] == "source_disabled"
    )


async def test_cancellation_marks_failed_then_reraises(run_store) -> None:  # type: ignore[no-untyped-def]
    started = asyncio.Event()

    async def hang(ctx: JobContext) -> None:
        started.set()
        await asyncio.sleep(60)

    task = asyncio.create_task(run_job(JobSpec("j", 60, hang), run_store))
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert run_store.runs[0]["status"] == "failed" and run_store.runs[0]["error"] == "cancelled"


async def test_dry_run_writes_nothing(run_store) -> None:  # type: ignore[no-untyped-def]
    res = await run_job(JobSpec("j", 60, _noop), None, dry_run=True)
    assert res.status == "ok" and res.run_id is None
    assert run_store.runs == []


async def test_store_required_when_not_dry_run() -> None:
    with pytest.raises(ValueError):
        await run_job(JobSpec("j", 60, _noop), None)


# ------------------------------------------------------------------ CLI
def test_cli_run_unknown_job_is_usage_error(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["run", "no_such_job"]) == 2
    assert "unknown job" in capsys.readouterr().err


def test_cli_run_without_job_is_usage_error() -> None:
    assert main(["run"]) == 2


def test_cli_dry_run_executes_registered_job_without_a_database(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    seen: dict[str, object] = {}

    async def work(ctx: JobContext) -> None:
        seen.update(symbols=ctx.symbols, dry=ctx.dry_run, rec=ctx.record_fixtures)

    monkeypatch.setitem(jobs.CLI_JOBS, "demo_job", JobSpec("demo_job", 60, work))
    monkeypatch.delenv("DATABASE_URL", raising=False)
    rc = main(["run", "demo_job", "--symbols", "tcs, infy", "--dry-run", "--record-fixtures"])
    assert rc == 0
    assert seen == {"symbols": ["TCS", "INFY"], "dry": True, "rec": False}  # dry run never records
    assert '"dry_run": true' in capsys.readouterr().out


def test_cli_failed_job_exits_nonzero(monkeypatch: pytest.MonkeyPatch) -> None:
    async def boom(ctx: JobContext) -> None:
        raise RuntimeError("x")

    monkeypatch.setitem(jobs.CLI_JOBS, "bad_job", JobSpec("bad_job", 60, boom))
    assert main(["run", "bad_job", "--dry-run"]) == 1
