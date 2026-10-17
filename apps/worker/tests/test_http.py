"""worker-http: HMAC auth (SEC-07, SYS-09), queued-only, one job at a time, target from DB."""

from __future__ import annotations

import asyncio
import hashlib
import json
from collections.abc import Iterator
from typing import Any

import httpx  # noqa: TID251 - ASGI test transport
import pytest

from worker import jobs
from worker.http import create_app, sign, verify
from worker.jobs import HttpJob, HttpJobResult

pytestmark = pytest.mark.anyio

KEY = "test-hmac-key-not-a-secret"
NOW = 1_800_000_000.0


@pytest.fixture(autouse=True)
def _clean_registry() -> Iterator[None]:
    saved = dict(jobs.HTTP_HANDLERS)
    yield
    jobs.HTTP_HANDLERS.clear()
    jobs.HTTP_HANDLERS.update(saved)


def _headers(
    body: bytes, *, ts: float = NOW, key: str = KEY, path: str = "/run", method: str = "POST"
) -> dict[str, str]:
    stamp = str(int(ts))
    return {
        "X-Timestamp": stamp,
        "X-Signature": sign(key, stamp, method, path, body),
        "Content-Type": "application/json",
    }


def _client(queue: Any, **kw: Any) -> httpx.AsyncClient:
    app = create_app(
        queue_factory=lambda: _aval(queue), key_provider=lambda: KEY, clock=lambda: NOW, **kw
    )
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://worker.test")


async def _aval(v: Any) -> Any:
    return v


async def _post(
    client: httpx.AsyncClient,
    payload: dict[str, Any] | bytes,
    headers: dict[str, str] | None = None,
):  # type: ignore[no-untyped-def]
    body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
    return await client.post(
        "/run", content=body, headers=headers if headers is not None else _headers(body)
    )


def _ok_handler() -> list[HttpJob]:
    calls: list[HttpJob] = []

    async def handler(job: HttpJob) -> HttpJobResult:
        calls.append(job)
        return HttpJobResult("ok", {"symbols_done": 2})

    jobs.register_http_handler("post_import", handler)
    return calls


# ------------------------------------------------------------------ signature unit tests
def test_signature_matches_spec_formula() -> None:
    body = b'{"job_id":7}'
    import hmac as _hmac

    msg = f"{int(NOW)}.POST./run.{hashlib.sha256(body).hexdigest()}"
    expected = _hmac.new(KEY.encode(), msg.encode(), hashlib.sha256).hexdigest()
    assert sign(KEY, str(int(NOW)), "POST", "/run", body) == expected


@pytest.mark.parametrize(
    ("skew", "ok"),
    [
        (0, True),
        (119, True),
        (120, True),
        (121, False),
        (-120, True),
        (-121, False),
        (3600, False),
        (-86400, False),
    ],
)
def test_sys09_timestamp_tolerance_is_120_seconds(skew: int, ok: bool) -> None:
    body = b"{}"
    ts = str(int(NOW) + skew)
    sig = sign(KEY, ts, "POST", "/run", body)
    assert (
        verify(KEY, ts_header=ts, sig_header=sig, method="POST", path="/run", body=body, now=NOW)
        is ok
    )


@pytest.mark.parametrize("ts", ["", "abc", "1.5", "-5", "１２３", "0x10", " 1800000000"])
def test_malformed_timestamps_rejected(ts: str) -> None:
    sig = sign(KEY, ts, "POST", "/run", b"")
    assert not verify(
        KEY, ts_header=ts, sig_header=sig, method="POST", path="/run", body=b"", now=NOW
    )


def test_empty_key_rejects_everything() -> None:
    ts = str(int(NOW))
    sig = sign("", ts, "POST", "/run", b"")
    assert not verify(
        "", ts_header=ts, sig_header=sig, method="POST", path="/run", body=b"", now=NOW
    )


# ------------------------------------------------------------------ HTTP behaviour
async def test_health_needs_no_auth(make_queue) -> None:  # type: ignore[no-untyped-def]
    async with _client(make_queue()) as c:
        r = await c.get("/health")
    assert r.status_code == 200 and r.json() == {"status": "ok"}


async def test_valid_request_runs_queued_job_with_target_from_db(make_queue) -> None:  # type: ignore[no-untyped-def]
    calls = _ok_handler()
    q = make_queue({5: ("post_import", "batch:42", "queued")})
    async with _client(q) as c:
        r = await _post(c, {"job_id": 5})
    assert r.status_code == 202
    assert calls == [HttpJob(job_id=5, kind="post_import", target="batch:42")]
    assert q.finished[5] == {"status": "ok", "result": {"symbols_done": 2}, "error": None}


@pytest.mark.parametrize(
    "variant",
    [
        "no_headers",
        "bad_sig",
        "wrong_key",
        "old_ts",
        "future_ts",
        "tampered_body",
        "wrong_path",
        "wrong_method",
    ],
)
async def test_sec07_unauthenticated_or_stale_requests_rejected(make_queue, variant: str) -> None:  # type: ignore[no-untyped-def]
    calls = _ok_handler()
    q = make_queue({5: ("post_import", "batch:1", "queued")})
    body = json.dumps({"job_id": 5}).encode()
    headers = {
        "no_headers": {},
        "bad_sig": {**_headers(body), "X-Signature": "0" * 64},
        "wrong_key": _headers(body, key="other-key"),
        "old_ts": _headers(body, ts=NOW - 200),
        "future_ts": _headers(body, ts=NOW + 200),
        "tampered_body": _headers(json.dumps({"job_id": 6}).encode()),
        "wrong_path": _headers(body, path="/other"),
        "wrong_method": _headers(body, method="GET"),
    }[variant]
    async with _client(q) as c:
        r = await c.post("/run", content=body, headers=headers)
    assert r.status_code == 401 and r.json()["error"]["code"] == "UNAUTHORIZED"
    assert calls == [] and q.rows[5][2] == "queued"


async def test_sec07_exact_replay_is_rejected(make_queue) -> None:  # type: ignore[no-untyped-def]
    _ok_handler()
    q = make_queue({5: ("post_import", "batch:1", "queued")})
    body = json.dumps({"job_id": 5}).encode()
    headers = _headers(body)
    async with _client(q) as c:
        first = await c.post("/run", content=body, headers=headers)
        again = await c.post("/run", content=body, headers=headers)
    assert first.status_code == 202 and again.status_code == 401


async def test_unconfigured_key_rejects_even_correct_looking_requests(make_queue) -> None:  # type: ignore[no-untyped-def]
    app = create_app(
        queue_factory=lambda: _aval(make_queue()), key_provider=lambda: "", clock=lambda: NOW
    )
    body = b'{"job_id": 1}'
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://w") as c:
        r = await c.post("/run", content=body, headers=_headers(body, key=""))
    assert r.status_code == 401


async def test_job_must_be_queued(make_queue) -> None:  # type: ignore[no-untyped-def]
    calls = _ok_handler()
    q = make_queue({1: ("post_import", "batch:1", "running"), 2: ("post_import", "batch:2", "ok")})
    async with _client(q) as c:
        r1 = await _post(c, {"job_id": 1})
        r2 = await _post(c, {"job_id": 2})
        r3 = await _post(c, {"job_id": 99})
    assert (r1.status_code, r2.status_code, r3.status_code) == (409, 409, 404)
    assert r1.json()["error"]["code"] == "JOB_NOT_QUEUED" and calls == []


async def test_kind_must_be_allow_listed_and_handled(make_queue) -> None:  # type: ignore[no-untyped-def]
    q = make_queue({1: ("stock_refresh", "TCS", "queued"), 2: ("mf_refresh", "119551", "queued")})
    async with _client(q) as c:
        r1 = await _post(c, {"job_id": 1})
        r2 = await _post(c, {"job_id": 2})  # allowed kind, but no handler installed yet
    assert r1.status_code == 422 and r1.json()["error"]["code"] == "KIND_NOT_ALLOWED"
    assert r2.status_code == 501
    assert q.rows[1][2] == "queued" and q.rows[2][2] == "queued"


def test_only_allow_listed_kinds_can_be_registered() -> None:
    with pytest.raises(ValueError):
        jobs.register_http_handler("stock_backfill", lambda job: None)  # type: ignore[arg-type,return-value]


@pytest.mark.parametrize(
    "payload",
    [
        b"not json",
        b"{}",
        b'{"job_id": "5"}',
        b'{"job_id": 5, "target": "x"}',
        b'{"job_id": 1.5}',
        b'{"job_id": true}',
    ],
)
async def test_body_validation_and_no_target_from_request(make_queue, payload: bytes) -> None:  # type: ignore[no-untyped-def]
    _ok_handler()
    async with _client(make_queue({5: ("post_import", "batch:1", "queued")})) as c:
        r = await _post(c, payload)
    assert r.status_code == 422


async def test_one_job_at_a_time(make_queue) -> None:  # type: ignore[no-untyped-def]
    release, started = asyncio.Event(), asyncio.Event()

    async def slow(job: HttpJob) -> HttpJobResult:
        started.set()
        await release.wait()
        return HttpJobResult("ok")

    jobs.register_http_handler("post_import", slow)
    q = make_queue(
        {1: ("post_import", "batch:1", "queued"), 2: ("post_import", "batch:2", "queued")}
    )
    app = create_app(queue_factory=lambda: _aval(q), key_provider=lambda: KEY, clock=lambda: NOW)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://w") as c:
        first = asyncio.create_task(_post(c, {"job_id": 1}))
        await started.wait()
        second = await _post(c, {"job_id": 2})
        assert second.status_code == 409 and second.json()["error"]["code"] == "BUSY"
        assert q.rows[2][2] == "queued"
        release.set()
        assert (await first).status_code == 202


async def test_handler_exception_marks_job_failed_with_scrubbed_error(make_queue) -> None:  # type: ignore[no-untyped-def]
    async def boom(job: HttpJob) -> HttpJobResult:
        raise RuntimeError("cannot connect postgres://u:topsecretpw@h/db")

    jobs.register_http_handler("post_import", boom)
    q = make_queue({1: ("post_import", "batch:1", "queued")})
    async with _client(q) as c:
        r = await _post(c, {"job_id": 1})
        assert r.status_code == 202
        body = json.dumps({"job_id": 1}).encode()  # fresh timestamp, so not a replay
        r2 = await c.post("/run", content=body, headers=_headers(body, ts=NOW - 1))  # lock released
    assert q.finished[1]["status"] == "failed" and "topsecretpw" not in q.finished[1]["error"]
    assert r2.status_code == 409


async def test_hard_cap_marks_job_failed(make_queue) -> None:  # type: ignore[no-untyped-def]
    async def hang(job: HttpJob) -> HttpJobResult:
        await asyncio.sleep(30)
        return HttpJobResult("ok")

    jobs.register_http_handler("post_import", hang)
    q = make_queue({1: ("post_import", "batch:1", "queued")})
    async with _client(q, hard_cap_s=0.05) as c:
        assert (await _post(c, {"job_id": 1})).status_code == 202
    assert q.finished[1] == {"status": "failed", "result": None, "error": "hard_timeout"}
