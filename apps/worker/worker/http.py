"""worker-http (docs/04 section 4): ``POST /run {job_id}`` and ``GET /health``.

Auth: ``X-Timestamp`` (unix seconds) and
``X-Signature = hex(HMAC_SHA256(WORKER_HMAC_KEY, f"{ts}.{method}.{path}.{sha256_hex(body)}"))``.
Rejected when the timestamp is more than 120 s off, the signature mismatches (constant-time), the
key is not configured, or the job row is not ``queued``. One job at a time; hard cap 4 minutes; the
target comes from the DB row, never from request input. ``POST /run`` answers 202 and runs the job
in the background (assumption D01-A3).
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import logging
import os
import time
from collections.abc import Callable
from contextlib import asynccontextmanager
from typing import Any, Protocol

from fastapi import BackgroundTasks, FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, StrictInt, ValidationError

from worker import job_defs, jobs
from worker.logs import scrub

log = logging.getLogger("worker.http")

MAX_SKEW_S = 120
HARD_CAP_S = 240.0


class JobQueue(Protocol):
    async def get(self, job_id: int) -> tuple[str, str, str] | None:
        """Return ``(kind, target, status)`` or ``None``."""
        ...

    async def claim(self, job_id: int) -> bool:
        """Atomically ``queued`` -> ``running``; ``False`` if it was not queued."""
        ...

    async def finish(
        self, job_id: int, *, status: str, result: dict[str, Any] | None, error: str | None
    ) -> None: ...


class RunRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    job_id: StrictInt


def sign(key: str, ts: str, method: str, path: str, body: bytes) -> str:
    message = f"{ts}.{method}.{path}.{hashlib.sha256(body).hexdigest()}"
    return hmac.new(key.encode(), message.encode(), hashlib.sha256).hexdigest()


def verify(
    key: str,
    *,
    ts_header: str | None,
    sig_header: str | None,
    method: str,
    path: str,
    body: bytes,
    now: float,
) -> bool:
    """True only for a fresh timestamp and a matching signature."""
    if (
        not key
        or not ts_header
        or not sig_header
        or not ts_header.isascii()
        or not ts_header.isdigit()
    ):
        return False
    if abs(now - int(ts_header)) > MAX_SKEW_S:
        return False
    return hmac.compare_digest(sign(key, ts_header, method.upper(), path, body), sig_header.lower())


def _error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse({"error": {"code": code, "message": message}}, status_code=status)


def create_app(
    *,
    queue_factory: Callable[[], Any] | None = None,
    key_provider: Callable[[], str] = lambda: os.environ.get("WORKER_HMAC_KEY", ""),
    clock: Callable[[], float] = time.time,
    hard_cap_s: float = HARD_CAP_S,
) -> FastAPI:
    state: dict[str, Any] = {"queue": None, "pool": None}
    busy = asyncio.Lock()
    seen: dict[str, float] = {}  # signature -> expiry; replay guard inside the skew window

    async def get_queue() -> JobQueue:
        if state["queue"] is None:
            if queue_factory is not None:
                state["queue"] = await queue_factory()
            else:
                from worker.db import PgJobQueue, create_pool  # local: keeps /health import-light

                state["pool"] = await create_pool()
                state["queue"] = PgJobQueue(state["pool"])
        queue: JobQueue = state["queue"]
        return queue

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> Any:
        yield
        if state["pool"] is not None:
            await state["pool"].close()

    app = FastAPI(
        title="worker-http", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None
    )

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/run", status_code=202)
    async def run(request: Request, background: BackgroundTasks) -> JSONResponse:
        body = await request.body()
        now = clock()
        sig = request.headers.get("X-Signature") or ""
        if not verify(
            key_provider(),
            ts_header=request.headers.get("X-Timestamp"),
            sig_header=sig,
            method=request.method,
            path=request.url.path,
            body=body,
            now=now,
        ):
            log.warning("worker-http auth rejected")
            return _error(401, "UNAUTHORIZED", "invalid signature or timestamp")
        for old in [s for s, exp in seen.items() if exp < now]:
            del seen[old]
        if sig.lower() in seen:
            return _error(401, "UNAUTHORIZED", "replayed request")
        seen[sig.lower()] = now + 2 * MAX_SKEW_S

        try:
            payload = RunRequest.model_validate_json(body)
        except ValidationError:
            return _error(422, "VALIDATION_ERROR", 'body must be {"job_id": <integer>}')

        if busy.locked():
            return _error(409, "BUSY", "another job is running; retry later")
        await busy.acquire()
        admitted = False
        try:
            queue = await get_queue()
            row = await queue.get(payload.job_id)
            if row is None:
                return _error(404, "NOT_FOUND", "job not found")
            kind, target, status = row
            if status != "queued":
                return _error(409, "JOB_NOT_QUEUED", "job is not queued")
            if kind not in jobs.HTTP_ALLOWED_KINDS:
                return _error(422, "KIND_NOT_ALLOWED", "job kind is not allowed on worker-http")
            handler = jobs.HTTP_HANDLERS.get(kind)
            if handler is None:
                return _error(501, "JOB_NOT_AVAILABLE", "no handler is installed for this job kind")
            if not await queue.claim(payload.job_id):
                return _error(409, "JOB_NOT_QUEUED", "job is not queued")
            admitted = True
        finally:
            if not admitted:
                busy.release()

        job = jobs.HttpJob(job_id=payload.job_id, kind=kind, target=target)

        async def execute() -> None:
            try:
                result = await asyncio.wait_for(handler(job), timeout=hard_cap_s)
                await queue.finish(
                    job.job_id,
                    status=result.status,
                    result=result.result,
                    error=scrub(result.error) if result.error else None,
                )
            except TimeoutError:
                await queue.finish(job.job_id, status="failed", result=None, error="hard_timeout")
            except Exception as exc:
                log.error("http job failed", extra={"job_id": job.job_id, "kind": job.kind})
                await queue.finish(
                    job.job_id,
                    status="failed",
                    result=None,
                    error=scrub(f"{type(exc).__name__}: {exc}"),
                )
            finally:
                busy.release()

        background.add_task(execute)
        return JSONResponse({"job_id": job.job_id, "status": "running"}, status_code=202)

    return app


job_defs.register_all()  # D03: post_import handler (idempotent)
app = create_app()
