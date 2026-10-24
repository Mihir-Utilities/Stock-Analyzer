"""Owner notifications over the Telegram Bot API (docs/01 section 8), via the shared egress client.

Never raises for delivery (the ``Notifier`` contract): a missing token, an unlinked chat or a
failed send is logged with a status and the job carries on. D06 (the alerts sender) may reuse
this class; the token never reaches a log line.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Callable
from typing import Any

import asyncpg
import httpx  # noqa: TID251 - type of the injectable egress transport only

from worker.egress import make_client

log = logging.getLogger("worker.notify")

API_BASE = "https://api.telegram.org"


class TelegramNotifier:
    """``Notifier`` implementation. ``last_status``: sent, no_token, not_linked or failed."""

    def __init__(
        self,
        pool: asyncpg.Pool,
        *,
        token_provider: Callable[[], str] = lambda: os.environ.get("TELEGRAM_BOT_TOKEN", ""),
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._pool = pool
        self._token = token_provider
        self._transport = transport
        self.last_status = "unused"

    async def send_html(self, text: str) -> None:
        token = self._token().strip()
        if not token:
            self.last_status = "no_token"
            log.info("owner notification skipped: TELEGRAM_BOT_TOKEN is not configured")
            return
        try:
            chat_id = await self._pool.fetchval(
                "SELECT telegram_chat_id FROM app_user WHERE telegram_chat_id IS NOT NULL LIMIT 1"
            )
            if chat_id is None:
                self.last_status = "not_linked"
                log.info("owner notification skipped: no Telegram chat is linked")
                return
            payload: dict[str, Any] = {
                "chat_id": int(chat_id),
                "text": text,
                "parse_mode": "HTML",
                "disable_web_page_preview": True,
            }
            async with make_client(inner=self._transport) as client:
                response = await client.post(f"{API_BASE}/bot{token}/sendMessage", json=payload)
            if response.status_code != 200:
                self.last_status = "failed"
                log.warning("telegram send failed", extra={"status": response.status_code})
                return
            self.last_status = "sent"
        except Exception as exc:  # delivery never fails the job; never log the URL (token)
            self.last_status = "failed"
            log.warning("telegram send failed: %s", type(exc).__name__)
