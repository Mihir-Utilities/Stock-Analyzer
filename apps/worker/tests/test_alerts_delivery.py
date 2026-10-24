"""Telegram sender and delivery rules without a database (ALR-07, ALR-08, ALR-09; D-9: no token)."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

import httpx  # noqa: TID251 - tests build mock transports
import pytest

from worker import fixtures
from worker.alerts_delivery import (
    DIGEST_CHUNK_CHARS,
    PendingEvent,
    build_messages,
    in_quiet_hours,
)
from worker.egress import make_client
from worker.errors import EgressDenied
from worker.marketdate import IST
from worker.telegram import API_HOST, TelegramSender

pytestmark = pytest.mark.anyio

TOKEN = "123456789:AAExampleExampleExampleExampleExample1"  # noqa: S105 - synthetic, never a real bot


class Recorder(httpx.AsyncBaseTransport):
    def __init__(self, status: int = 200, body: str | None = None) -> None:
        self.requests: list[httpx.Request] = []
        self.status = status
        self.body = (
            body if body is not None else fixtures.load_text("telegram", "sendMessage_ok.json")
        )

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return httpx.Response(self.status, content=self.body.encode())


class Boom(httpx.AsyncBaseTransport):
    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError(f"cannot reach {request.url}")


def sender_with(inner: httpx.AsyncBaseTransport) -> TelegramSender:
    return TelegramSender(TOKEN, make_client(inner=inner))


async def test_send_posts_html_with_escaped_text_to_the_allow_listed_host() -> None:
    rec = Recorder()
    res = await sender_with(rec).send_html(42, "<b>M&amp;M</b> above 4,000")
    assert res.ok
    req = rec.requests[0]
    assert str(req.url) == f"{API_HOST}/bot{TOKEN}/sendMessage"
    body = json.loads(req.content)
    assert body == {
        "chat_id": 42,
        "text": "<b>M&amp;M</b> above 4,000",
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }


async def test_no_token_means_nothing_is_sent_and_nothing_crashes() -> None:
    rec = Recorder()
    sender = TelegramSender("", make_client(inner=rec))
    assert not sender.configured
    res = await sender.send_html(1, "x")
    assert not res.ok and res.error == "bot_not_configured" and rec.requests == []
    assert not TelegramSender(None).configured


@pytest.mark.parametrize(
    ("status", "name", "expect_retry_after", "needle"),
    [
        (429, "sendMessage_429.json", 7.0, "telegram_http_429"),
        (403, "sendMessage_403.json", None, "bot was blocked"),
        (400, "sendMessage_400_parse.json", None, "telegram_http_400"),
    ],
)
async def test_alr06_error_responses_become_a_typed_result(
    status: int, name: str, expect_retry_after: float | None, needle: str
) -> None:
    res = await sender_with(Recorder(status, fixtures.load_text("telegram", name))).send_html(
        1, "x"
    )
    assert not res.ok and res.retry_after == expect_retry_after
    assert res.error is not None and needle in res.error


async def test_errors_never_contain_the_token_or_the_url() -> None:
    res = await sender_with(Boom()).send_html(1, "x")
    assert not res.ok and res.error == "network_error: ConnectError"
    assert TOKEN not in (res.error or "")
    leaky = Recorder(500, json.dumps({"ok": False, "description": f"oops {TOKEN}"}))
    res2 = await sender_with(leaky).send_html(1, "x")
    assert res2.error is not None and TOKEN not in res2.error


async def test_egress_still_refuses_other_hosts() -> None:
    async with make_client(inner=Recorder()) as client:
        with pytest.raises(EgressDenied):
            await client.post("https://example.com/bot/sendMessage", json={})


def test_alr07_more_than_ten_events_become_digest_chunks_under_the_limit() -> None:
    few = [PendingEvent(i, f"<b>S{i}</b> above 1") for i in range(10)]
    assert [ids for ids, _ in build_messages(few)] == [[i] for i in range(10)]
    many = [PendingEvent(i, "<b>SYM</b> above 1 | " + "x" * 300) for i in range(40)]
    msgs = build_messages(many)
    assert len(msgs) > 1
    assert sorted(i for ids, _ in msgs for i in ids) == list(range(40))
    assert all(len(text) < 4096 and text.startswith("<b>40 alerts fired</b>") for _, text in msgs)
    assert all(len(text) <= DIGEST_CHUNK_CHARS + 100 for _, text in msgs)
    eleven = build_messages([PendingEvent(i, "t") for i in range(11)])
    assert len(eleven) == 1 and len(eleven[0][0]) == 11


@pytest.mark.parametrize(
    ("hhmm", "expected"),
    [
        ("21:59", False),
        ("22:00", True),
        ("23:30", True),
        ("00:15", True),
        ("06:59", True),
        ("07:00", False),
        ("12:00", False),
    ],
)
def test_alr08_quiet_hours_window_wrapping_midnight(hhmm: str, expected: bool) -> None:
    quiet = {"start": "22:00", "end": "07:00", "tz": "Asia/Kolkata"}
    hour, minute = (int(x) for x in hhmm.split(":"))
    moment = datetime(2026, 10, 9, hour, minute, tzinfo=IST).astimezone(UTC)
    assert in_quiet_hours(moment, quiet) is expected


def test_quiet_hours_edge_cases() -> None:
    now = datetime(2026, 10, 9, 20, 0, tzinfo=UTC)  # 01:30 IST
    assert not in_quiet_hours(now, None)
    assert not in_quiet_hours(now, {})
    assert not in_quiet_hours(now, {"start": "22:00", "end": "22:00"})
    assert not in_quiet_hours(now, {"start": "nope", "end": "07:00"})
    assert in_quiet_hours(now, {"start": "01:00", "end": "02:00", "tz": "Asia/Kolkata"})
    assert in_quiet_hours(now, {"start": "01:00", "end": "02:00", "tz": "No/Such_Zone"})  # IST


def test_fixtures_are_free_of_secrets() -> None:
    root = Path(fixtures.FIXTURES_ROOT) / "telegram"
    for p in root.glob("*.json"):
        assert fixtures.scrub(p.read_text(encoding="utf-8")) == p.read_text(encoding="utf-8")
