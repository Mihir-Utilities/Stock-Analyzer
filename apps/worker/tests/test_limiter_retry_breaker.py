"""Limiter spacing, retry/backoff, circuit breaker transitions (docs/01 section 1 rules 3-5), fake clock."""

from __future__ import annotations

import random
from datetime import UTC, datetime, timedelta

import pytest

from worker.breaker import CircuitBreaker, SourceHealth
from worker.errors import EgressDenied, RetryableError, SourceDisabled
from worker.limiter import RateLimiter, get_limiter
from worker.retry import backoff_delay, retry_async

pytestmark = pytest.mark.anyio


# ------------------------------------------------------------------ limiter
async def test_limiter_spaces_calls_within_jitter(clock) -> None:  # type: ignore[no-untyped-def]
    limiter = RateLimiter(1.0, clock=clock, sleep=clock.sleep, rng=random.Random(7))
    stamps = []
    for _ in range(50):
        await limiter.acquire()
        stamps.append(clock())
    gaps = [b - a for a, b in zip(stamps, stamps[1:], strict=False)]
    assert all(0.8 - 1e-9 <= g <= 1.2 + 1e-9 for g in gaps)
    assert len({round(g, 6) for g in gaps}) > 10  # jitter is actually applied


async def test_limiter_first_call_is_immediate_and_idle_time_counts(clock) -> None:  # type: ignore[no-untyped-def]
    limiter = RateLimiter(1.0, clock=clock, sleep=clock.sleep, rng=random.Random(1))
    await limiter.acquire()
    assert clock.sleeps == []
    clock.t += 5.0  # idle longer than the interval: no wait
    await limiter.acquire()
    assert clock.sleeps == []


async def test_limiter_zero_interval_never_waits(clock) -> None:  # type: ignore[no-untyped-def]
    limiter = RateLimiter(0.0, clock=clock, sleep=clock.sleep)
    for _ in range(5):
        await limiter.acquire()
    assert clock.sleeps == []


def test_limiter_registry_is_process_wide() -> None:
    assert get_limiter("mfapi-test", 0.5) is get_limiter("mfapi-test", 9.0)


# ------------------------------------------------------------------ retry
def test_backoff_formula_and_cap() -> None:
    class Fixed(random.Random):
        def uniform(self, a: float, b: float) -> float:
            return 0.5

    assert backoff_delay(1, Fixed()) == 2.5
    assert backoff_delay(2, Fixed()) == 4.5
    assert backoff_delay(3, Fixed()) == 8.5
    assert backoff_delay(10, Fixed()) == 60.0
    assert backoff_delay(1, Fixed(), retry_after=30) == 30
    assert backoff_delay(1, Fixed(), retry_after=500) == 60.0


async def test_retry_succeeds_after_transient_errors(clock) -> None:  # type: ignore[no-untyped-def]
    attempts = 0

    async def flaky() -> str:
        nonlocal attempts
        attempts += 1
        if attempts < 3:
            raise RetryableError("503")
        return "ok"

    assert await retry_async(flaky, sleep=clock.sleep, rng=random.Random(3)) == "ok"
    assert attempts == 3 and len(clock.sleeps) == 2


async def test_retry_gives_up_after_three_retries(clock) -> None:  # type: ignore[no-untyped-def]
    attempts = 0

    async def always() -> None:
        nonlocal attempts
        attempts += 1
        raise RetryableError("429", retry_after=11)

    with pytest.raises(RetryableError):
        await retry_async(always, sleep=clock.sleep, rng=random.Random(3))
    assert attempts == 4 and len(clock.sleeps) == 3
    assert all(s >= 11 for s in clock.sleeps)  # Retry-After honoured


@pytest.mark.parametrize(
    "exc", [SourceDisabled("mfapi", None), EgressDenied("x"), ValueError("bad")]
)
async def test_retry_never_retries_other_errors(exc: Exception, clock) -> None:  # type: ignore[no-untyped-def]
    attempts = 0

    async def boom() -> None:
        nonlocal attempts
        attempts += 1
        raise exc

    with pytest.raises(type(exc)):
        await retry_async(boom, sleep=clock.sleep)
    assert attempts == 1 and clock.sleeps == []


# ------------------------------------------------------------------ breaker
class Now:
    def __init__(self) -> None:
        self.value = datetime(2026, 10, 17, 12, 0, tzinfo=UTC)

    def __call__(self) -> datetime:
        return self.value

    def advance(self, **kw: float) -> None:
        self.value += timedelta(**kw)


async def _fail(b: CircuitBreaker, n: int) -> None:
    for _ in range(n):
        await b.before_call()
        await b.record_failure("boom")


async def test_breaker_opens_after_five_failures(health_store) -> None:  # type: ignore[no-untyped-def]
    now = Now()
    b = CircuitBreaker("mfapi", health_store, now=now)
    await _fail(b, 4)
    await b.before_call()  # still closed
    await b.record_failure("boom")
    row = health_store.rows["mfapi"]
    assert row.consecutive_failures == 5 and row.ok is False
    assert row.disabled_until == now() + timedelta(minutes=30)
    with pytest.raises(SourceDisabled):
        await b.before_call()


async def test_breaker_success_resets_a_non_open_streak(health_store) -> None:  # type: ignore[no-untyped-def]
    b = CircuitBreaker("mfapi", health_store, now=Now())
    await _fail(b, 4)
    await b.record_success(latency_ms=12)
    assert health_store.rows["mfapi"].consecutive_failures == 0
    await _fail(b, 4)  # 4 more are not 5 consecutive
    await b.before_call()


async def test_breaker_half_open_then_closes_after_three_successes(health_store) -> None:  # type: ignore[no-untyped-def]
    now = Now()
    b = CircuitBreaker("mfapi", health_store, now=now)
    await _fail(b, 5)
    now.advance(minutes=30, seconds=1)
    await b.before_call()  # probe allowed
    await b.record_success()
    await b.record_success()
    assert health_store.rows["mfapi"].consecutive_failures == 5  # not yet closed
    await b.record_success()
    row = health_store.rows["mfapi"]
    assert row.consecutive_failures == 0 and row.ok is True and row.disabled_until is None


async def test_breaker_escalates_30_min_2_h_12_h(health_store) -> None:  # type: ignore[no-untyped-def]
    now = Now()
    b = CircuitBreaker("mfapi", health_store, now=now)
    await _fail(b, 5)
    assert health_store.rows["mfapi"].disabled_until == now() + timedelta(minutes=30)
    now.advance(minutes=31)
    await b.record_failure()  # failed probe
    assert health_store.rows["mfapi"].disabled_until == now() + timedelta(hours=2)
    now.advance(hours=2, minutes=1)
    await b.record_failure()
    assert health_store.rows["mfapi"].disabled_until == now() + timedelta(hours=12)
    now.advance(hours=13)
    await b.record_failure()
    assert health_store.rows["mfapi"].disabled_until == now() + timedelta(hours=12)  # stays at 12 h


async def test_failed_probe_resets_success_count(health_store) -> None:  # type: ignore[no-untyped-def]
    now = Now()
    b = CircuitBreaker("mfapi", health_store, now=now)
    await _fail(b, 5)
    now.advance(minutes=31)
    await b.record_success()
    await b.record_success()
    await b.record_failure()
    now.advance(hours=3)
    await b.record_success()
    await b.record_success()
    assert health_store.rows["mfapi"].consecutive_failures == 6  # needs 3 fresh successes


async def test_call_wrapper_counts_only_source_failures(health_store) -> None:  # type: ignore[no-untyped-def]
    b = CircuitBreaker("amfi", health_store, now=Now())

    async def ok() -> int:
        return 1

    async def source_down() -> int:
        raise RetryableError("503")

    async def bad_data() -> int:
        raise ValueError("schema")

    assert await b.call(ok) == 1
    with pytest.raises(RetryableError):
        await b.call(source_down)
    with pytest.raises(ValueError):
        await b.call(bad_data)
    assert health_store.rows["amfi"].consecutive_failures == 1  # ValueError not counted
    for _ in range(4):
        with pytest.raises((RetryableError, SourceDisabled)):
            await b.call(source_down)
    with pytest.raises(SourceDisabled):
        await b.call(ok)  # raised immediately, fn never ran


async def test_breaker_state_survives_a_new_instance(health_store) -> None:  # type: ignore[no-untyped-def]
    now = Now()
    await _fail(CircuitBreaker("mfapi", health_store, now=now), 5)
    with pytest.raises(SourceDisabled):
        await CircuitBreaker("mfapi", health_store, now=now).before_call()  # same row, new process


async def test_unknown_source_starts_closed(health_store) -> None:  # type: ignore[no-untyped-def]
    await CircuitBreaker("telegram", health_store, now=Now()).before_call()
    assert SourceHealth(source="x", ok=True).consecutive_failures == 0
