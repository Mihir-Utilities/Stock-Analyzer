"""Telegram sender (docs/01 section 6): ``sendMessage`` with ``parse_mode=HTML`` through the shared
egress client only (host ``api.telegram.org`` is on the allow-list). The bot token comes from
``TELEGRAM_BOT_TOKEN``; without it ``configured`` is false and nothing is sent. The token is part
of the request URL, so errors are reported as an HTTP status plus Telegram's ``description``,
never as the exception text or URL.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from dataclasses import dataclass
from typing import Any

import asyncpg

from worker.egress import NETWORK_ERRORS, TOTAL_TIMEOUT_S, HttpClient, make_client
from worker.logs import scrub

log = logging.getLogger("worker.telegram")

API_HOST = "https://api.telegram.org"
MAX_TEXT = 4096  # Telegram's message limit; callers keep chunks below it
ERROR_MAX = 200


@dataclass(frozen=True)
class SendResult:
    ok: bool
    error: str | None = None
    retry_after: float | None = None  # seconds, from a 429 response


class TelegramSender:
    def __init__(self, token: str | None, client: HttpClient | None = None) -> None:
        self._token = (token or "").strip() or None
        self._client = client

    @classmethod
    def from_env(cls) -> TelegramSender:
        return cls(os.environ.get("TELEGRAM_BOT_TOKEN"))

    @property
    def configured(self) -> bool:
        return self._token is not None

    async def send_html(self, chat_id: int, text: str) -> SendResult:
        if self._token is None:
            return SendResult(False, "bot_not_configured")
        body = {
            "chat_id": chat_id,
            "text": text[:MAX_TEXT],
            "parse_mode": "HTML",
            "disable_web_page_preview": True,
        }
        url = f"{API_HOST}/bot{self._token}/sendMessage"
        owned = self._client is None
        client = self._client or make_client()
        try:
            async with asyncio.timeout(TOTAL_TIMEOUT_S):
                response = await client.post(url, json=body)
        except NETWORK_ERRORS as exc:
            return SendResult(False, f"network_error: {type(exc).__name__}")
        except TimeoutError:
            return SendResult(False, "network_error: timeout")
        finally:
            if owned:
                await client.aclose()
        return _result(response.status_code, response.content)


def _result(status: int, content: bytes) -> SendResult:
    data: Any = None
    try:
        data = json.loads(content)
    except ValueError:
        pass
    doc = data if isinstance(data, dict) else {}
    if status == 200 and doc.get("ok") is True:
        return SendResult(True)
    description = scrub(str(doc.get("description", "")))[:ERROR_MAX]
    retry_after: float | None = None
    params = doc.get("parameters")
    if isinstance(params, dict) and isinstance(params.get("retry_after"), int | float):
        retry_after = float(params["retry_after"])
    return SendResult(False, f"telegram_http_{status}: {description}".strip(": "), retry_after)


class OwnerNotifier:
    """The ``actions_db.Notifier`` for owner notices (new detected corporate action, ...): sends to
    the linked chat when the bot is configured, otherwise logs. Never raises."""

    def __init__(self, pool: asyncpg.Pool, sender: TelegramSender | None = None) -> None:
        self._pool = pool
        self._sender = sender or TelegramSender.from_env()

    async def send_html(self, text: str) -> None:
        try:
            chat_id = await self._pool.fetchval("SELECT telegram_chat_id FROM app_user")
            if chat_id is None or not self._sender.configured:
                log.info("owner notice not sent (telegram not linked or not configured)")
                return
            result = await self._sender.send_html(int(chat_id), text)
            if not result.ok:
                log.warning("owner notice failed", extra={"error": scrub(result.error or "")})
        except Exception as exc:  # a notice must never break a job
            log.warning("owner notice failed", extra={"error": scrub(type(exc).__name__)})
