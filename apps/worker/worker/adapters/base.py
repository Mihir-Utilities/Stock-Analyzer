"""Shared plumbing for source adapters: limiter + breaker + retry around one egress client.

Adapters never import httpx; they receive a client from ``worker.egress.make_client`` (D-N).
Typed errors follow docs/01 section 3.2 / 10.
"""

from __future__ import annotations

import asyncio
import os
import random
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Any

from worker.breaker import CircuitBreaker, SourceHealthStore
from worker.egress import (
    NETWORK_ERRORS,
    TOTAL_TIMEOUT_S,
    HttpClient,
    HttpResponse,
    ResponseTooLarge,
    get_capped,
    raise_if_retryable,
)
from worker.errors import RetryableError
from worker.limiter import RateLimiter, get_limiter
from worker.retry import retry_async


class SchemaError(Exception):
    """A response or file did not have the documented shape (nothing is written)."""


class NotFound(Exception):  # noqa: N818 - name fixed by docs/01 section 3.2
    """The source answered 404 for a valid-looking request."""


@dataclass(frozen=True)
class SourceGuard:
    source: str
    limiter: RateLimiter
    breaker: CircuitBreaker


def build_guard(
    source: str,
    store: SourceHealthStore,
    *,
    default_interval: float,
    env_var: str | None = None,
) -> SourceGuard:
    """Process-wide limiter (+/-20% jitter) and a breaker backed by ``source_health``."""
    interval = default_interval
    raw = os.environ.get(env_var, "").strip() if env_var else ""
    if raw:
        try:
            interval = max(0.0, float(raw))
        except ValueError:
            interval = default_interval
    return SourceGuard(source, get_limiter(source, interval), CircuitBreaker(source, store))


MAX_BODY_BYTES = 5 * 1024 * 1024  # default per-response cap; callers pass tighter/larger ones
MAX_NAV = Decimal("10000000")  # D04R-3: larger than any real NAV; rejects overflow garbage
MAX_CODE = 999_999_999  # fits int4 (the DB scheme code is int)


async def guarded_get(
    client: HttpClient,
    url: str,
    guard: SourceGuard,
    *,
    params: dict[str, str | int] | None = None,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    rng: random.Random | None = None,
    max_bytes: int = MAX_BODY_BYTES,
) -> HttpResponse:
    """GET with throttle, up to 3 retries (5xx/429/network), breaker and 60 s total per attempt.

    404 -> ``NotFound``; other 4xx -> ``SchemaError`` (not retried, not counted against the
    breaker).
    """

    async def attempt() -> HttpResponse:
        await guard.limiter.acquire()
        try:
            async with asyncio.timeout(TOTAL_TIMEOUT_S):
                response = await get_capped(client, url, params=params, max_bytes=max_bytes)
        except NETWORK_ERRORS as exc:
            raise RetryableError(type(exc).__name__) from exc
        except TimeoutError as exc:
            raise RetryableError("timeout") from exc
        raise_if_retryable(response)
        return response

    try:
        response = await guard.breaker.call(lambda: retry_async(attempt, sleep=sleep, rng=rng))
    except ResponseTooLarge as exc:
        raise SchemaError(f"{guard.source}: response too large ({exc})") from exc
    if response.status_code == 404:
        raise NotFound(f"{guard.source}: 404")
    if response.status_code >= 400:
        raise SchemaError(f"{guard.source}: HTTP {response.status_code}")
    return response


_NAV_RE = re.compile(r"[0-9]{1,12}(\.[0-9]{1,12})?")  # ASCII digits only
_CODE_RE = re.compile(r"[0-9]{1,9}")
_ISIN_RE = re.compile(r"^IN[A-Z0-9]{10}$")


def parse_nav(value: Any) -> Decimal | None:
    """NAV text/number -> Decimal > 0, else None (``N.A.``, ``-``, blank, non-numeric; MF-02)."""
    if isinstance(value, bool) or value is None:
        return None
    text = str(value).strip()
    if not _NAV_RE.fullmatch(text):
        return None
    try:
        nav = Decimal(text)
    except InvalidOperation:  # pragma: no cover - the regex already guarantees a number
        return None
    return nav if 0 < nav <= MAX_NAV else None


def parse_scheme_code(value: Any) -> int | None:
    """Positive ASCII-digit scheme code that fits the DB int column, else None."""
    if isinstance(value, bool) or value is None:
        return None
    text = str(value).strip()
    if not _CODE_RE.fullmatch(text):
        return None
    code = int(text)
    return code if 0 < code <= MAX_CODE else None


def clean_isin(value: Any) -> str | None:
    """Valid ISIN or None (``-`` and blanks mean none)."""
    if not isinstance(value, str):
        return None
    text = value.strip().upper()
    return text if _ISIN_RE.match(text) else None


_MONTHS = {
    m: i
    for i, m in enumerate(
        ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1
    )
}
_DMY_RE = re.compile(r"([0-9]{2})-([0-9]{2})-([0-9]{4})")
_DMON_RE = re.compile(r"([0-9]{2})-([A-Za-z]{3})-([0-9]{4})")


def parse_date_dmy(value: Any) -> date | None:
    """mfapi ``DD-MM-YYYY`` (MF-03)."""
    m = _DMY_RE.fullmatch(str(value).strip()) if value is not None else None
    if not m:
        return None
    try:
        return date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
    except ValueError:
        return None


def parse_date_dmon(value: Any) -> date | None:
    """AMFI ``DD-Mon-YYYY`` (MF-03); locale independent."""
    m = _DMON_RE.fullmatch(str(value).strip()) if value is not None else None
    if not m or m.group(2).lower() not in _MONTHS:
        return None
    try:
        return date(int(m.group(3)), _MONTHS[m.group(2).lower()], int(m.group(1)))
    except ValueError:
        return None
