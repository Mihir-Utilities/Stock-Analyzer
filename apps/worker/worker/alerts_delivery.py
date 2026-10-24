"""Alert delivery (docs/04 3.9 step 5, docs/01 section 6), independent of storage and network.

Rules: quiet hours hold events as ``pending``; sends are sequential with 1.1 s spacing; more than
10 events in a run become digest messages; a failed send is retried every 15 minutes up to 5
retries (6 attempts) and then ``failed``; with no linked chat events stay ``pending`` and after
24 h become ``failed (not_linked)``; with no bot token nothing is attempted and events stay
``pending`` with ``last_error = bot_not_configured``. Duplicate runs never double-send: events are
claimed with a 15-minute lease before any send (see ``alerts_db``).
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from datetime import datetime, time, timedelta
from typing import Any, Protocol
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from worker.marketdate import IST
from worker.telegram import SendResult

SEND_SPACING_S = 1.1
DIGEST_THRESHOLD = 10
MAX_ATTEMPTS = 6  # 1 send + 5 retries
RETRY_SPACING = timedelta(minutes=15)
NOT_LINKED_AFTER = timedelta(hours=24)
DIGEST_CHUNK_CHARS = 3500  # below Telegram's 4096 limit, leaving room for the header

NOT_CONFIGURED = "bot_not_configured"
NOT_LINKED = "not_linked"


@dataclass(frozen=True)
class PendingEvent:
    id: int
    text: str  # HTML, already escaped when the event was created


class Sender(Protocol):
    @property
    def configured(self) -> bool: ...

    async def send_html(self, chat_id: int, text: str) -> SendResult: ...


class DeliveryStore(Protocol):
    async def owner(self) -> tuple[int | None, dict[str, Any] | None]:
        """(telegram_chat_id, quiet_hours)."""
        ...

    async def expire_unlinked(self, now: datetime) -> int:
        """Pending events older than 24 h become failed ``not_linked``."""
        ...

    async def note_pending(self, reason: str) -> int:
        """Record ``reason`` as last_error on pending events (no attempt is counted)."""
        ...

    async def claim_due(self, now: datetime, lease: timedelta) -> list[PendingEvent]:
        """Atomically lease pending events that are due; each claim counts one attempt."""
        ...

    async def mark_sent(self, ids: Sequence[int], now: datetime) -> None: ...

    async def mark_attempt_failed(
        self, ids: Sequence[int], error: str, next_at: datetime, max_attempts: int
    ) -> None:
        """Back to ``pending`` due at ``next_at``, or ``failed`` once attempts reach the cap."""
        ...

    async def release(self, ids: Sequence[int]) -> None:
        """Give leased events back without counting the attempt."""
        ...


def in_quiet_hours(now: datetime, quiet: dict[str, Any] | None) -> bool:
    """``quiet_hours = {"start":"22:00","end":"07:00","tz":"Asia/Kolkata"}``; the window may wrap
    midnight; start == end or any malformed value means no quiet hours."""
    if not quiet:
        return False
    try:
        start = time.fromisoformat(str(quiet["start"]))
        end = time.fromisoformat(str(quiet["end"]))
    except (KeyError, ValueError):
        return False
    if start == end:
        return False
    tz: Any
    try:
        tz = ZoneInfo(str(quiet.get("tz") or "Asia/Kolkata"))
    except (ZoneInfoNotFoundError, ValueError):
        tz = IST  # no tz database (Windows without tzdata) or a bad name: the app is IST
    local = (now if now.tzinfo else now.replace(tzinfo=IST)).astimezone(tz).time()
    if start < end:
        return start <= local < end
    return local >= start or local < end


def build_messages(events: Sequence[PendingEvent]) -> list[tuple[list[int], str]]:
    """One message per event, or digest chunks when there are more than 10 events."""
    if len(events) <= DIGEST_THRESHOLD:
        return [([e.id], e.text) for e in events]
    messages: list[tuple[list[int], str]] = []
    ids: list[int] = []
    lines: list[str] = []
    size = 0

    def flush() -> None:
        nonlocal ids, lines, size
        if ids:
            header = f"<b>{len(events)} alerts fired</b> (part {len(messages) + 1})"
            messages.append((ids, header + "\n" + "\n".join(lines)))
        ids, lines, size = [], [], 0

    for e in events:
        if lines and size + len(e.text) + 1 > DIGEST_CHUNK_CHARS:
            flush()
        ids.append(e.id)
        lines.append(e.text)
        size += len(e.text) + 1
    flush()
    return messages


async def deliver_pending(
    store: DeliveryStore,
    sender: Sender,
    now: Callable[[], datetime],
    *,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
) -> dict[str, Any]:
    """One delivery pass. Returns a small summary dict (status and counts) for the job log."""
    chat_id, quiet = await store.owner()
    started = now()
    if chat_id is None:
        expired = await store.expire_unlinked(started)
        held = await store.note_pending(NOT_LINKED)
        return {"status": NOT_LINKED, "held": held, "expired": expired}
    # linked later: events older than 24 h are not sent now (docs/04 3.9 step 5)
    expired = await store.expire_unlinked(started)
    if not sender.configured:
        held = await store.note_pending(NOT_CONFIGURED)
        return {"status": NOT_CONFIGURED, "held": held, "expired": expired}
    if in_quiet_hours(started, quiet):
        held = await store.note_pending("quiet_hours")
        return {"status": "quiet_hours", "held": held, "expired": expired}
    events = await store.claim_due(started, RETRY_SPACING)
    if not events:
        return {"status": "ok", "sent": 0, "failed": 0, "expired": expired}
    messages = build_messages(events)
    sent = failed = 0
    for index, (ids, text) in enumerate(messages):
        if index:
            await sleep(SEND_SPACING_S)
        result = await sender.send_html(chat_id, text)
        if result.ok:
            await store.mark_sent(ids, now())
            sent += len(ids)
            continue
        wait = timedelta(seconds=result.retry_after or 0)
        await store.mark_attempt_failed(
            ids, result.error or "unknown", now() + max(RETRY_SPACING, wait), MAX_ATTEMPTS
        )
        failed += len(ids)
        if result.retry_after is not None:  # Telegram throttled us: stop, give the rest back
            rest = [i for later_ids, _ in messages[index + 1 :] for i in later_ids]
            if rest:
                await store.release(rest)
            break
    return {"status": "ok", "sent": sent, "failed": failed, "expired": expired}
