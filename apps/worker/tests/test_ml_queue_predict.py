"""ML-30: the `predict` step of `process_queued_jobs` (docs/04 3.13): namespaced result, skipped
without a new bar, traceback logged on failure, cancellation never swallowed."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import pytest

from worker import job_defs
from worker.ml import jobs as ml_jobs
from worker.runner import JobContext

pytestmark = pytest.mark.anyio


def patch(
    monkeypatch: pytest.MonkeyPatch, *, models: bool = True, new_bar: bool = True, run: Any = None
) -> list[JobContext]:
    seen: list[JobContext] = []

    async def has_models(_pool: object) -> bool:
        return models

    async def has_new_bar(_pool: object) -> bool:
        return new_bar

    async def run_predict(_pool: object, sub: JobContext) -> None:
        seen.append(sub)
        if run is not None:
            await run(sub)
        else:
            sub.extra["status"] = "ok"
            sub.extra["predictions"] = {"built": 3, "written": 3}
            sub.add_rows(3)

    monkeypatch.setattr(ml_jobs, "has_models", has_models)
    monkeypatch.setattr(ml_jobs, "has_new_bar", has_new_bar)
    monkeypatch.setattr(ml_jobs, "run_predict", run_predict)
    return seen


async def test_ml30_result_is_namespaced_and_rows_are_added(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    patch(monkeypatch)
    ctx = JobContext(job="process_queued_jobs")
    ctx.extra["status"] = "queue-status"
    await job_defs._predict_after_queue(object(), ctx)  # type: ignore[arg-type]
    assert ctx.extra["status"] == "queue-status"  # the queue run's own keys are untouched
    assert ctx.extra["predict"]["status"] == "ok" and ctx.rows_written == 3


async def test_ml30_skipped_without_a_model_or_without_a_new_bar(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen = patch(monkeypatch, models=False)
    ctx = JobContext(job="q")
    await job_defs._predict_after_queue(object(), ctx)  # type: ignore[arg-type]
    assert ctx.extra["predict"] == {"status": "skipped", "reason": "no_model"} and not seen
    seen = patch(monkeypatch, new_bar=False)
    ctx = JobContext(job="q")
    await job_defs._predict_after_queue(object(), ctx)  # type: ignore[arg-type]
    assert ctx.extra["predict"] == {"status": "skipped", "reason": "no_new_bar"} and not seen


async def test_ml30_a_failure_is_logged_with_traceback_and_never_fails_the_queue(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    async def boom(_sub: JobContext) -> None:
        raise RuntimeError("model blew up")

    patch(monkeypatch, run=boom)
    ctx = JobContext(job="q")
    with caplog.at_level(logging.ERROR, logger="worker.job_defs"):
        await job_defs._predict_after_queue(object(), ctx)  # type: ignore[arg-type]
    assert ctx.extra["predict"]["status"] == "error"
    assert "RuntimeError" in ctx.extra["predict"]["error"]
    rec = next(r for r in caplog.records if r.name == "worker.job_defs")
    assert rec.exc_info is not None and rec.exc_info[0] is RuntimeError  # traceback kept
    assert ctx.items_failed == 0 and "predict_error" not in ctx.extra


async def test_ml30_cancellation_is_not_swallowed(monkeypatch: pytest.MonkeyPatch) -> None:
    async def cancelled(_sub: JobContext) -> None:
        raise asyncio.CancelledError

    patch(monkeypatch, run=cancelled)
    ctx = JobContext(job="q")
    with pytest.raises(asyncio.CancelledError):
        await job_defs._predict_after_queue(object(), ctx)  # type: ignore[arg-type]
    assert "predict" not in ctx.extra
