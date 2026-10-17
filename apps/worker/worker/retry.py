"""Retry with backoff (docs/01 section 1 rule 3).

Up to 3 retries (4 attempts) on the exceptions in ``retry_on`` (network errors, 5xx, 429 are
mapped to ``RetryableError`` by ``worker.egress``). Delay before retry n (n = 1, 2, 3) is
``min(60, 2**n + random(0, 1))`` seconds; a ``Retry-After`` hint is honoured (capped at 60 s).
``SourceDisabled`` and ``EgressDenied`` are never retried.
"""

from __future__ import annotations

import asyncio
import random
from collections.abc import Awaitable, Callable
from typing import TypeVar

from worker.errors import EgressDenied, RetryableError, SourceDisabled

T = TypeVar("T")

MAX_RETRIES = 3
MAX_DELAY_S = 60.0


def backoff_delay(retry_number: int, rng: random.Random, retry_after: float | None = None) -> float:
    delay = min(MAX_DELAY_S, 2.0**retry_number + rng.uniform(0.0, 1.0))
    if retry_after is not None:
        delay = max(delay, min(MAX_DELAY_S, retry_after))
    return delay


async def retry_async(
    fn: Callable[[], Awaitable[T]],
    *,
    retry_on: tuple[type[Exception], ...] = (RetryableError,),
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    rng: random.Random | None = None,
    max_retries: int = MAX_RETRIES,
) -> T:
    generator = rng or random.Random()  # noqa: S311 - jitter, not cryptography
    retry = 0
    while True:
        try:
            return await fn()
        except (SourceDisabled, EgressDenied):
            raise
        except retry_on as exc:
            if retry >= max_retries:
                raise
            retry += 1
            hint = getattr(exc, "retry_after", None)
            await sleep(
                backoff_delay(
                    retry, generator, float(hint) if isinstance(hint, int | float) else None
                )
            )
