"""``evaluate_alerts`` and delivery against Postgres (ALR-03, 05, 06, 07, 08, 10, 18 and the rest of
docs/04 3.9). The Telegram side is a fake sender; no socket is opened."""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, date, datetime, timedelta
from typing import Any

import asyncpg
import pytest

from worker import alerts_db
from worker.alerts_delivery import MAX_ATTEMPTS, deliver_pending
from worker.post_import import HOOKS, Hooks
from worker.telegram import OwnerNotifier, SendResult, TelegramSender

pytestmark = [pytest.mark.anyio, pytest.mark.integration]

NOW = datetime(2026, 10, 9, 14, 0, tzinfo=UTC)  # 19:30 IST, a Friday
CHAT = 111111111


class Clock:
    def __init__(self, t: datetime = NOW) -> None:
        self.t = t

    def __call__(self) -> datetime:
        return self.t


class FakeSender:
    def __init__(self, results: list[SendResult] | None = None, configured: bool = True) -> None:
        self.configured = configured
        self.results = list(results or [])
        self.sent: list[tuple[int, str]] = []

    async def send_html(self, chat_id: int, text: str) -> SendResult:
        await asyncio.sleep(0)
        self.sent.append((chat_id, text))
        return self.results.pop(0) if self.results else SendResult(True)


def weekdays(n: int, end: date = date(2026, 10, 9)) -> list[date]:
    out: list[date] = []
    d = end
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d)
        d -= timedelta(days=1)
    return out[::-1]


async def add_stock(
    pool: asyncpg.Pool, symbol: str, closes: list[float], *, status: str = "active"
) -> int:
    iid = int(
        await pool.fetchval(
            "INSERT INTO instrument (symbol, name, status) VALUES ($1, $1, $2) RETURNING id",
            symbol,
            status,
        )
    )
    await pool.executemany(
        "INSERT INTO price_daily (instrument_id, trade_date, open, high, low, close, adj_close, "
        "volume, source) VALUES ($1, $2, $3, $3, $3, $3, $3, 1000, 'import')",
        [(iid, d, c) for d, c in zip(weekdays(len(closes)), closes, strict=True)],
    )
    return iid


async def add_alert(
    pool: asyncpg.Pool,
    iid: int,
    kind: str,
    params: dict[str, Any],
    *,
    last_state: dict[str, Any] | None = None,
    one_shot: bool = True,
    expires_on: date | None = None,
) -> int:
    return int(
        await pool.fetchval(
            "INSERT INTO alert (target_type, instrument_id, kind, params, one_shot, expires_on, "
            "last_state) VALUES ('stock', $1, $2, $3::jsonb, $4, $5, $6::jsonb) RETURNING id",
            iid,
            kind,
            json.dumps(params),
            one_shot,
            expires_on,
            None if last_state is None else json.dumps(last_state),
        )
    )


async def link_owner(pool: asyncpg.Pool, chat: int | None = CHAT, quiet: Any = None) -> None:
    await pool.execute(
        "INSERT INTO app_user (id, password_hash, telegram_chat_id, quiet_hours) "
        "VALUES (1, 'x', $1, $2::jsonb) ON CONFLICT (id) DO UPDATE SET "
        "telegram_chat_id = EXCLUDED.telegram_chat_id, quiet_hours = EXCLUDED.quiet_hours",
        chat,
        None if quiet is None else json.dumps(quiet),
    )


async def events(pool: asyncpg.Pool) -> list[asyncpg.Record]:
    return await pool.fetch(
        "SELECT id, alert_id, dedupe_key, delivery_status, delivery_attempts, last_error, payload "
        "FROM alert_event ORDER BY id"
    )


def payload(rec: asyncpg.Record) -> dict[str, Any]:
    raw = rec["payload"]
    return json.loads(raw) if isinstance(raw, str) else dict(raw)


async def test_alr18_event_driven_evaluation_fires_only_new_bars_and_marks_the_alert(
    pg_full: asyncpg.Pool,
) -> None:
    iid = await add_stock(pg_full, "TCS", [3900.0, 3950.0, 4012.5])
    aid = await add_alert(pg_full, iid, "price_above", {"price": 4000})
    summary = await alerts_db.evaluate_alerts(pg_full, symbols=["TCS"], now=Clock())
    assert summary["events"] == 1 and summary["errors"] == 0
    (ev,) = await events(pg_full)
    assert ev["delivery_status"] == "pending"
    assert payload(ev)["message"].startswith("<b>TCS</b> above 4,000 | close 4,012.50, as of")
    assert payload(ev)["message"].endswith(f"(09 Oct 2026). Alert #{aid}")
    row = await pg_full.fetchrow("SELECT status, last_fired_at, last_state FROM alert")
    assert row is not None and row["status"] == "fired" and row["last_fired_at"] == NOW
    # a fired alert is never evaluated again
    again = await alerts_db.evaluate_alerts(pg_full, symbols=["TCS"], now=Clock())
    assert again["alerts"] == 0 and len(await events(pg_full)) == 1


async def test_alr03_duplicate_evaluation_never_creates_a_second_event(
    pg_full: asyncpg.Pool,
) -> None:
    iid = await add_stock(pg_full, "INFY", [1400.0, 1500.0])
    aid = await add_alert(pg_full, iid, "price_above", {"price": 1450}, one_shot=False)
    await asyncio.gather(*(alerts_db.evaluate_alerts(pg_full, now=Clock()) for _ in range(4)))
    assert len(await events(pg_full)) == 1
    # wipe the evaluator memory (as a params edit does): the same bar yields the same dedupe key
    await pg_full.execute(
        "UPDATE alert SET last_state = NULL, status = 'active' WHERE id = $1", aid
    )
    await alerts_db.evaluate_alerts(pg_full, now=Clock(NOW + timedelta(days=2)))
    assert len(await events(pg_full)) == 1


async def test_alr18_new_bar_after_an_import_fires_and_only_that_bar(
    pg_full: asyncpg.Pool,
) -> None:
    iid = await add_stock(pg_full, "HDFCBANK", [1000.0, 1010.0, 1020.0])
    await add_alert(pg_full, iid, "price_above", {"price": 1040}, one_shot=False)
    await alerts_db.evaluate_alerts(pg_full, now=Clock())
    assert await events(pg_full) == []
    await pg_full.execute(
        "INSERT INTO price_daily (instrument_id, trade_date, open, high, low, close, adj_close, "
        "volume, source) VALUES ($1, $2, 1050, 1050, 1050, 1050, 1050, 1, 'import')",
        iid,
        date(2026, 10, 12),
    )
    await alerts_db.evaluate_alerts(pg_full, symbols=["HDFCBANK"], now=Clock())
    (ev,) = await events(pg_full)
    assert ev["dedupe_key"].endswith("|2026-10-12|1040")


async def test_alr10_delisted_stock_expires_the_alert_with_a_note(pg_full: asyncpg.Pool) -> None:
    iid = await add_stock(pg_full, "OLDCO", [10.0, 12.0], status="delisted")
    aid = await add_alert(pg_full, iid, "price_above", {"price": 11})
    summary = await alerts_db.evaluate_alerts(pg_full, now=Clock())
    assert summary["expired"] == 1
    row = await pg_full.fetchrow("SELECT status, last_state FROM alert WHERE id = $1", aid)
    assert row is not None and row["status"] == "expired"
    assert "delisted" in str(row["last_state"])
    (ev,) = await events(pg_full)
    assert "expired: the stock is delisted" in payload(ev)["message"]


async def test_expires_on_in_the_past_expires_the_alert_without_an_event(
    pg_full: asyncpg.Pool,
) -> None:
    iid = await add_stock(pg_full, "EXPCO", [10.0, 12.0])
    aid = await add_alert(pg_full, iid, "price_above", {"price": 11}, expires_on=date(2026, 10, 8))
    await alerts_db.evaluate_alerts(pg_full, now=Clock())
    status = await pg_full.fetchval("SELECT status FROM alert WHERE id = $1", aid)
    assert status == "expired" and await events(pg_full) == []


async def test_alr09_escaped_symbol_in_the_stored_and_sent_message(pg_full: asyncpg.Pool) -> None:
    iid = await add_stock(pg_full, "M&M", [1000.0, 1100.0])
    await add_alert(pg_full, iid, "price_above", {"price": 1050})
    await link_owner(pg_full)
    await alerts_db.evaluate_alerts(pg_full, now=Clock())
    sender = FakeSender()
    await alerts_db.deliver_alerts(pg_full, sender, Clock())  # type: ignore[arg-type]
    assert sender.sent[0][1].startswith("<b>M&amp;M</b> above 1,050")


async def test_non_bar_kinds_end_to_end(pg_full: asyncpg.Pool) -> None:
    iid = await add_stock(pg_full, "RESCO", [100.0, 101.0])
    await pg_full.execute(
        "INSERT INTO event_calendar (instrument_id, event_date, event_type) "
        "VALUES ($1, '2026-10-12', 'results'), ($1, '2026-10-30', 'results')",
        iid,
    )
    up = await add_alert(pg_full, iid, "results_upcoming", {"days_before": 5})
    declared = await add_alert(pg_full, iid, "results_declared", {})
    held = await add_alert(pg_full, iid, "holding_change", {"holder": "fii", "delta_pct": 1})
    await alerts_db.evaluate_alerts(pg_full, now=Clock())  # initialises declared/holding silently
    keys = [e["dedupe_key"] for e in await events(pg_full)]
    assert keys == [f"{up}|results_upcoming|event:1"] and declared and held
    await pg_full.execute(
        "INSERT INTO fundamental_value (instrument_id, basis, period_type, period_end, "
        "metric_key, value, source) VALUES ($1, 'consolidated', 'Q', '2026-09-30', "
        "'pnl.revenue', 1, 'manual')",
        iid,
    )
    await pg_full.execute(
        "INSERT INTO shareholding (instrument_id, quarter_end, fii_pct, source) VALUES "
        "($1, '2026-03-31', 10, 'manual'), ($1, '2026-06-30', 12.5, 'manual')",
        iid,
    )
    await alerts_db.evaluate_alerts(
        pg_full, now=Clock()
    )  # holding and results fire: they started empty
    await pg_full.execute(
        "INSERT INTO shareholding (instrument_id, quarter_end, fii_pct, source) "
        "VALUES ($1, '2026-09-30', 14.0, 'manual')",
        iid,
    )
    await alerts_db.evaluate_alerts(pg_full, now=Clock())
    kinds = sorted(str(payload(e)["kind"]) for e in await events(pg_full))
    assert kinds == ["holding_change", "results_declared", "results_upcoming"]


async def test_nav_alert_uses_mf_nav(pg_full: asyncpg.Pool) -> None:
    await pg_full.execute("INSERT INTO mf_scheme (code, name) VALUES (120503, 'Fund & Co')")
    await pg_full.executemany(
        "INSERT INTO mf_nav (scheme_code, nav_date, nav) VALUES (120503, $1, $2)",
        [(date(2026, 10, 8), 50.0), (date(2026, 10, 9), 52.0)],
    )
    aid = int(
        await pg_full.fetchval(
            "INSERT INTO alert (target_type, mf_scheme_code, kind, params, last_state) VALUES "
            "('mf', 120503, 'nav_above', '{\"nav\": 51}', '{\"last_bar_date\": \"2026-10-08\"}') "
            "RETURNING id"
        )
    )
    await alerts_db.evaluate_alerts(pg_full, now=Clock())
    (ev,) = await events(pg_full)
    assert ev["alert_id"] == aid
    assert payload(ev)["message"].startswith("<b>Fund &amp; Co</b> above 51 | NAV 52.00")


# --------------------------------------------------------------------------- delivery
async def make_events(pg: asyncpg.Pool, n: int, *, fired_at: datetime = NOW) -> None:
    iid = int(
        await pg.fetchval(
            "INSERT INTO instrument (symbol, name) VALUES ('DLV', 'DLV') "
            "ON CONFLICT (symbol) DO UPDATE SET name = 'DLV' RETURNING id"
        )
    )
    aid = await add_alert(pg, iid, "price_above", {"price": 1}, one_shot=False)
    await pg.executemany(
        "INSERT INTO alert_event (alert_id, fired_at, dedupe_key, payload) "
        "VALUES ($1, $2, $3, $4::jsonb)",
        [
            (aid, fired_at, f"k{i}", json.dumps({"message": f"<b>DLV</b> event {i}"}))
            for i in range(n)
        ],
    )


async def deliver(pg: asyncpg.Pool, sender: FakeSender, clock: Clock) -> dict[str, Any]:
    sleeps: list[float] = []

    async def sleep(s: float) -> None:
        sleeps.append(s)

    out = await deliver_pending(
        alerts_db.PgDeliveryStore(pg),
        sender,
        clock,
        sleep=sleep,  # type: ignore[arg-type]
    )
    out["sleeps"] = sleeps
    return out


async def test_delivered_exactly_once_under_duplicate_concurrent_runs(
    pg_full: asyncpg.Pool,
) -> None:
    await link_owner(pg_full)
    await make_events(pg_full, 3)
    sender = FakeSender()
    await asyncio.gather(*(deliver(pg_full, sender, Clock()) for _ in range(4)))
    assert sorted(t for _, t in sender.sent) == [f"<b>DLV</b> event {i}" for i in range(3)]
    assert {e["delivery_status"] for e in await events(pg_full)} == {"sent"}
    again = await deliver(pg_full, sender, Clock())
    assert again["sent"] == 0 and len(sender.sent) == 3


async def test_sends_are_sequential_with_1_1_second_spacing(pg_full: asyncpg.Pool) -> None:
    await link_owner(pg_full)
    await make_events(pg_full, 4)
    out = await deliver(pg_full, FakeSender(), Clock())
    assert out["sleeps"] == [1.1, 1.1, 1.1] and out["sent"] == 4


async def test_alr07_more_than_ten_events_are_one_digest(pg_full: asyncpg.Pool) -> None:
    await link_owner(pg_full)
    await make_events(pg_full, 12)
    sender = FakeSender()
    out = await deliver(pg_full, sender, Clock())
    assert len(sender.sent) == 1 and out["sent"] == 12
    assert sender.sent[0][1].startswith("<b>12 alerts fired</b>")
    assert {e["delivery_status"] for e in await events(pg_full)} == {"sent"}


async def test_alr08_quiet_hours_hold_events_until_they_end(pg_full: asyncpg.Pool) -> None:
    await link_owner(pg_full, quiet={"start": "22:00", "end": "07:00", "tz": "Asia/Kolkata"})
    await make_events(pg_full, 2)
    night = Clock(datetime(2026, 10, 9, 17, 0, tzinfo=UTC))  # 22:30 IST
    sender = FakeSender()
    held = await deliver(pg_full, sender, night)
    assert held["status"] == "quiet_hours" and held["held"] == 2 and sender.sent == []
    assert {e["delivery_status"] for e in await events(pg_full)} == {"pending"}
    assert {e["delivery_attempts"] for e in await events(pg_full)} == {0}
    morning = Clock(datetime(2026, 10, 10, 1, 40, tzinfo=UTC))  # 07:10 IST
    out = await deliver(pg_full, sender, morning)
    assert out["sent"] == 2


async def test_alr05_not_linked_stays_pending_then_delivers_when_linked(
    pg_full: asyncpg.Pool,
) -> None:
    await link_owner(pg_full, chat=None)
    await make_events(pg_full, 2)
    sender = FakeSender()
    out = await deliver(pg_full, sender, Clock(NOW + timedelta(hours=2)))
    assert out["status"] == "not_linked" and sender.sent == []
    assert {e["delivery_status"] for e in await events(pg_full)} == {"pending"}
    await link_owner(pg_full)  # linked within 24 h of the events
    out2 = await deliver(pg_full, sender, Clock(NOW + timedelta(hours=5)))
    assert out2["sent"] == 2


async def test_alr05_events_older_than_24_hours_fail_as_not_linked(pg_full: asyncpg.Pool) -> None:
    await link_owner(pg_full, chat=None)
    await make_events(pg_full, 1, fired_at=NOW - timedelta(hours=30))
    await make_events(pg_full, 1, fired_at=NOW - timedelta(hours=1))
    await pg_full.execute("UPDATE alert_event SET dedupe_key = 'n' || id")
    out = await deliver(pg_full, FakeSender(), Clock())
    assert out["expired"] == 1
    states = sorted((e["delivery_status"], e["last_error"]) for e in await events(pg_full))
    assert states == [("failed", "not_linked"), ("pending", "not_linked")]


async def test_alr05_linked_run_expires_events_older_than_24h(pg_full: asyncpg.Pool) -> None:
    await link_owner(pg_full, chat=None)
    await make_events(pg_full, 1, fired_at=NOW - timedelta(hours=30))
    await make_events(pg_full, 1, fired_at=NOW - timedelta(hours=1))
    await pg_full.execute("UPDATE alert_event SET dedupe_key = 'n' || id")
    await link_owner(pg_full)
    sender = FakeSender()
    out = await deliver(pg_full, sender, Clock())
    assert out["sent"] == 1 and out["expired"] == 1 and len(sender.sent) == 1
    states = sorted((e["delivery_status"], e["last_error"]) for e in await events(pg_full))
    assert states == [("failed", "not_linked"), ("sent", None)]


async def test_alr06_failure_is_retried_every_15_minutes_then_failed(pg_full: asyncpg.Pool) -> None:
    await link_owner(pg_full)
    await make_events(pg_full, 1)
    bad = SendResult(False, "telegram_http_500: boom")
    sender = FakeSender([bad] * 10)
    clock = Clock()
    await deliver(pg_full, sender, clock)
    (ev,) = await events(pg_full)
    assert ev["delivery_status"] == "pending" and ev["delivery_attempts"] == 1
    assert ev["last_error"] == "telegram_http_500: boom"
    await deliver(pg_full, sender, clock)  # same instant: not due yet, no extra send
    assert len(sender.sent) == 1
    for _ in range(2, MAX_ATTEMPTS + 1):
        clock.t += timedelta(minutes=15, seconds=1)
        await deliver(pg_full, sender, clock)
    (ev,) = await events(pg_full)
    assert ev["delivery_status"] == "failed" and ev["delivery_attempts"] == MAX_ATTEMPTS == 6
    clock.t += timedelta(hours=1)
    await deliver(pg_full, sender, clock)
    assert len(sender.sent) == MAX_ATTEMPTS  # 1 send + 5 retries, nothing after


async def test_throttled_by_telegram_stops_the_run_and_releases_the_rest(
    pg_full: asyncpg.Pool,
) -> None:
    await link_owner(pg_full)
    await make_events(pg_full, 3)
    sender = FakeSender([SendResult(False, "telegram_http_429", 120.0)])
    out = await deliver(pg_full, sender, Clock())
    assert out["failed"] == 1 and len(sender.sent) == 1
    attempts = sorted(e["delivery_attempts"] for e in await events(pg_full))
    assert attempts == [0, 0, 1]
    # the throttled one waits for retry_after (> 15 min spacing is not needed here: max())
    follow = await deliver(pg_full, sender, Clock())
    assert follow["sent"] == 2


async def test_d9_no_bot_token_leaves_events_pending_with_a_clear_status(
    pg_full: asyncpg.Pool,
) -> None:
    await link_owner(pg_full)
    await make_events(pg_full, 2)
    sender = FakeSender(configured=False)
    out = await deliver(pg_full, sender, Clock())
    assert out["status"] == "bot_not_configured" and out["held"] == 2 and sender.sent == []
    states = {
        (e["delivery_status"], e["last_error"], e["delivery_attempts"])
        for e in await events(pg_full)
    }
    assert states == {("pending", "bot_not_configured", 0)}
    # the real sender without a token behaves the same and the whole job path does not crash
    result = await alerts_db.deliver_alerts(pg_full, TelegramSender(None), Clock())
    assert result["status"] == "bot_not_configured"


async def test_owner_notifier_never_raises_without_token_or_chat(pg_full: asyncpg.Pool) -> None:
    notifier = OwnerNotifier(pg_full, TelegramSender(None))
    await notifier.send_html("<b>x</b>")  # no app_user row, no token
    await link_owner(pg_full)
    await notifier.send_html("<b>x</b>")
    await pg_full.close()
    await notifier.send_html("<b>x</b>")  # closed pool: swallowed


async def test_post_import_hooks_evaluate_per_symbol_and_deliver_once_at_the_end(
    pg_full: asyncpg.Pool, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("TELEGRAM_BOT_TOKEN", raising=False)
    iid = await add_stock(pg_full, "ONE", [10.0, 12.0])
    await add_alert(pg_full, iid, "price_above", {"price": 11})
    seen: list[str] = []

    async def screener(symbols: Any) -> None:
        seen.extend(symbols)

    hooks = alerts_db.wire_hooks(
        pg_full, Hooks(HOOKS.compute_analysis, HOOKS.evaluate_alerts, screener)
    )
    await hooks.evaluate_alerts("ONE")
    assert len(await events(pg_full)) == 1
    await hooks.recompute_screener(["ONE"])  # no token in the test env: stays pending, no crash
    assert seen == ["ONE"]
    assert (await events(pg_full))[0]["delivery_status"] == "pending"


async def test_declared_and_holding_fire_for_news_imported_between_create_and_first_run(
    pg_full: asyncpg.Pool,
) -> None:
    iid = await add_stock(pg_full, "NEWSCO", [100.0, 101.0])
    await pg_full.execute(
        "INSERT INTO fundamental_value (instrument_id, basis, period_type, period_end, "
        "metric_key, value, source) VALUES ($1, 'consolidated', 'Q', '2026-06-30', "
        "'pnl.revenue', 1, 'manual')",
        iid,
    )
    await pg_full.execute(
        "INSERT INTO shareholding (instrument_id, quarter_end, fii_pct, source) VALUES "
        "($1, '2026-03-31', 10, 'manual')",
        iid,
    )
    await add_alert(pg_full, iid, "results_declared", {})
    await add_alert(pg_full, iid, "holding_change", {"holder": "fii", "delta_pct": 1})
    await alerts_db.evaluate_alerts(pg_full, now=Clock())  # nothing new yet: silent baseline
    assert await events(pg_full) == []
    iid2 = await add_stock(pg_full, "NEWSCO2", [100.0, 101.0])
    await pg_full.execute(
        "INSERT INTO shareholding (instrument_id, quarter_end, fii_pct, source) VALUES "
        "($1, '2026-03-31', 10, 'manual')",
        iid2,
    )
    await add_alert(pg_full, iid2, "results_declared", {})
    await add_alert(pg_full, iid2, "holding_change", {"holder": "fii", "delta_pct": 1})
    await pg_full.execute(  # imported after the alerts were created, before their first run
        "INSERT INTO fundamental_value (instrument_id, basis, period_type, period_end, "
        "metric_key, value, source) VALUES ($1, 'consolidated', 'Q', '2026-09-30', "
        "'pnl.revenue', 1, 'manual')",
        iid2,
    )
    await pg_full.execute(
        "INSERT INTO shareholding (instrument_id, quarter_end, fii_pct, source) VALUES "
        "($1, '2026-06-30', 12.5, 'manual')",
        iid2,
    )
    await alerts_db.evaluate_alerts(pg_full, now=Clock())
    kinds = sorted(str(payload(e)["kind"]) for e in await events(pg_full))
    assert kinds == ["holding_change", "results_declared"]
