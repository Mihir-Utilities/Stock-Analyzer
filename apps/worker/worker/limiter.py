"""Process-wide async rate limiter with +/-20% jitter (docs/01 section 1 rule 4)."""

from __future__ import annotations

import asyncio
import random
import time
from collections.abc import Awaitable, Callable

Clock = Callable[[], float]
Sleeper = Callable[[float], Awaitable[None]]

JITTER = 0.2


class RateLimiter:
    """Spaces calls at least ``min_interval`` seconds apart (each gap jittered by +/-20%).

    ``clock``, ``sleep`` and ``rng`` are injectable so tests use a fake clock.
    """

    def __init__(
        self,
        min_interval: float,
        *,
        clock: Clock = time.monotonic,
        sleep: Sleeper = asyncio.sleep,
        rng: random.Random | None = None,
    ) -> None:
        if min_interval < 0:
            raise ValueError("min_interval must be >= 0")
        self.min_interval = min_interval
        self._clock = clock
        self._sleep = sleep
        self._rng = rng or random.Random()  # noqa: S311 - jitter, not cryptography
        self._next_allowed: float | None = None
        self._lock = asyncio.Lock()

    async def acquire(self) -> None:
        async with self._lock:
            now = self._clock()
            if self._next_allowed is not None and self._next_allowed > now:
                await self._sleep(self._next_allowed - now)
                now = self._next_allowed
            gap = self.min_interval * (1 + self._rng.uniform(-JITTER, JITTER))
            self._next_allowed = now + gap


_limiters: dict[str, RateLimiter] = {}


def get_limiter(source: str, min_interval: float) -> RateLimiter:
    """One limiter per source for the whole process."""
    limiter = _limiters.get(source)
    if limiter is None:
        limiter = _limiters[source] = RateLimiter(min_interval)
    return limiter
