"""Job registries. D01 ships the mechanism only; real jobs register themselves in D03+.

``CLI_JOBS`` feeds ``python -m worker run <job>``; ``HTTP_HANDLERS`` feeds ``POST /run`` for the
allow-listed ``refresh_job`` kinds (docs/04 section 4).
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from worker.runner import JobSpec

# docs/04 section 4: stock_refresh / stock_backfill are broker mode (inactive, D-1).
HTTP_ALLOWED_KINDS = frozenset({"post_import", "mf_refresh"})

# Kinds whose progress lives in refresh_job.result so a hard-capped run can be continued.
RESUMABLE_KINDS = frozenset({"post_import"})

CLI_JOBS: dict[str, JobSpec] = {}


@dataclass(frozen=True)
class HttpJob:
    job_id: int
    kind: str
    target: str  # read from the DB row, never from request input


@dataclass(frozen=True)
class HttpJobResult:
    status: str  # ok | partial | failed
    result: dict[str, Any] = field(default_factory=dict)
    error: str | None = None


HttpHandler = Callable[[HttpJob], Awaitable[HttpJobResult]]
HTTP_HANDLERS: dict[str, HttpHandler] = {}


def register_cli_job(spec: JobSpec) -> None:
    CLI_JOBS[spec.name] = spec


def register_http_handler(kind: str, handler: HttpHandler) -> None:
    if kind not in HTTP_ALLOWED_KINDS:
        raise ValueError(f"kind {kind!r} is not allow-listed for worker-http")
    HTTP_HANDLERS[kind] = handler
