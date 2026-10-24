"""Circuit breaker backed by ``source_health`` (docs/01 section 1 rule 5).

5 consecutive failures -> ``disabled_until = now + 30 min``; if the source then fails again while
probing, 2 h, then 12 h. While open every call raises ``SourceDisabled`` immediately. After the
disabled period the breaker is half-open: calls are allowed and 3 consecutive successes close it.

``source_health`` has no trip-level or success columns (docs/02 is the schema of record), so the
level is derived from ``consecutive_failures`` (5 -> 30 min, 6 -> 2 h, 7 or more -> 12 h) and the
3 probe successes are counted in process memory (assumption D01-A1 in docs/OPEN_QUESTIONS.md).
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from typing import Protocol, TypeVar

from worker.errors import RetryableError, SourceDisabled

T = TypeVar("T")

FAILURE_THRESHOLD = 5
SUCCESSES_TO_CLOSE = 3
OPEN_DURATIONS = (timedelta(minutes=30), timedelta(hours=2), timedelta(hours=12))


@dataclass(frozen=True)
class SourceHealth:
    source: str
    ok: bool
    consecutive_failures: int = 0
    disabled_until: datetime | None = None
    latency_ms: int | None = None
    note: str | None = None
    checked_at: datetime | None = None


class SourceHealthStore(Protocol):
    async def get(self, source: str) -> SourceHealth | None: ...

    async def save(self, health: SourceHealth) -> None: ...

    async def update(self, source: str, fn: Callable[[SourceHealth], SourceHealth]) -> SourceHealth:
        """Atomic read-modify-write of one source's row (concurrent jobs must not lose updates)."""
        ...


def _utcnow() -> datetime:
    return datetime.now(UTC)


class CircuitBreaker:
    def __init__(
        self,
        source: str,
        store: SourceHealthStore,
        *,
        now: Callable[[], datetime] = _utcnow,
    ) -> None:
        self.source = source
        self._store = store
        self._now = now
        self._probe_successes = 0

    async def _load(self) -> SourceHealth:
        return await self._store.get(self.source) or SourceHealth(source=self.source, ok=True)

    async def before_call(self) -> None:
        health = await self._load()
        if health.disabled_until is not None and self._now() < health.disabled_until:
            raise SourceDisabled(self.source, health.disabled_until)

    async def record_success(self, latency_ms: int | None = None) -> None:
        def apply(health: SourceHealth) -> SourceHealth:
            failures = health.consecutive_failures
            note: str | None = None
            if failures >= FAILURE_THRESHOLD:  # half-open probe
                self._probe_successes += 1
                if self._probe_successes >= SUCCESSES_TO_CLOSE:
                    failures, self._probe_successes = 0, 0
                else:
                    note = f"half_open {self._probe_successes}/{SUCCESSES_TO_CLOSE}"
            else:
                failures = 0
            return replace(
                health,
                ok=True,
                consecutive_failures=failures,
                disabled_until=None,
                latency_ms=latency_ms,
                note=note,
                checked_at=self._now(),
            )

        await self._store.update(self.source, apply)

    async def record_failure(self, note: str | None = None) -> None:
        def apply(health: SourceHealth) -> SourceHealth:
            self._probe_successes = 0
            failures = health.consecutive_failures + 1
            disabled_until: datetime | None = None
            if failures >= FAILURE_THRESHOLD:
                level = min(failures - FAILURE_THRESHOLD, len(OPEN_DURATIONS) - 1)
                disabled_until = self._now() + OPEN_DURATIONS[level]
            return replace(
                health,
                ok=False,
                consecutive_failures=failures,
                disabled_until=disabled_until,
                note=note,
                checked_at=self._now(),
            )

        await self._store.update(self.source, apply)

    async def call(
        self,
        fn: Callable[[], Awaitable[T]],
        *,
        failure_on: tuple[type[Exception], ...] = (RetryableError,),
    ) -> T:
        """Guard one source call: raise ``SourceDisabled`` if open, record the outcome.

        Only exceptions in ``failure_on`` (source/network failures) count against the source;
        validation or programming errors do not.
        """
        await self.before_call()
        try:
            result = await fn()
        except failure_on as exc:
            await self.record_failure(type(exc).__name__)
            raise
        await self.record_success()
        return result
