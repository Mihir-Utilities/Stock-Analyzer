"""``evaluate_alerts`` against Postgres (docs/04 3.9, manual price mode) and the Postgres side of
delivery. Evaluation runs at the end of ``post_import`` (per symbol) and in the 19:30 IST EOD run
(all active alerts); each alert is evaluated in its own transaction under a row lock, and events
are inserted ``ON CONFLICT (alert_id, dedupe_key) DO NOTHING``, so duplicate runs never create a
second event. Delivery state lives in ``alert_event`` columns plus ``payload.delivery`` (lease and
next-attempt time; docs/OPEN_QUESTIONS D06-1).
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable, Sequence
from dataclasses import replace
from datetime import UTC, date, datetime, timedelta
from typing import Any

import asyncpg
import numpy as np

from worker.alerts_delivery import (
    NOT_CONFIGURED,
    NOT_LINKED,
    NOT_LINKED_AFTER,
    PendingEvent,
    deliver_pending,
)
from worker.alerts_eval import (
    AlertRow,
    EvalResult,
    esc,
    evaluate_bar_alert,
    evaluate_holding_change,
    evaluate_results_declared,
    evaluate_results_upcoming,
)
from worker.analytics.snapshot import Bars
from worker.logs import scrub
from worker.marketdate import ist_today
from worker.post_import import Hooks, SymbolHook, SymbolsHook
from worker.telegram import TelegramSender

log = logging.getLogger("worker.alerts")

Clock = Callable[[], datetime]


def _utcnow() -> datetime:
    return datetime.now(UTC)


def _doc(raw: Any) -> dict[str, Any] | None:
    if raw is None:
        return None
    value = json.loads(raw) if isinstance(raw, str) else raw
    return value if isinstance(value, dict) else None


_ALERT_SQL = (
    "SELECT a.id, a.kind, a.status, a.params, a.one_shot, a.cooldown_minutes, a.expires_on, "
    "a.last_fired_at, a.last_state, a.created_at, a.instrument_id, a.mf_scheme_code, "
    "i.symbol, i.status AS inst_status, m.name AS scheme_name "
    "FROM alert a LEFT JOIN instrument i ON i.id = a.instrument_id "
    "LEFT JOIN mf_scheme m ON m.code = a.mf_scheme_code "
)


class _Data:
    """Per-run cache of price / NAV series so several alerts on one target load it once.

    Callers inside a transaction pass their connection: borrowing a second one from a small pool
    while holding the first deadlocks concurrent runs."""

    def __init__(self, conn: asyncpg.Pool | asyncpg.Connection) -> None:
        self._conn = conn
        self._bars: dict[int, Bars] = {}
        self._navs: dict[int, Bars] = {}

    async def bars(self, instrument_id: int, conn: asyncpg.Connection | None = None) -> Bars:
        if instrument_id not in self._bars:
            rows = await (conn or self._conn).fetch(
                "SELECT trade_date, close, adj_close, high, low FROM price_daily "
                "WHERE instrument_id = $1 AND NOT suspect ORDER BY trade_date",
                instrument_id,
            )
            self._bars[instrument_id] = _to_bars(rows, "close", "adj_close", "high", "low")
        return self._bars[instrument_id]

    async def navs(self, scheme_code: int, conn: asyncpg.Connection | None = None) -> Bars:
        if scheme_code not in self._navs:
            rows = await (conn or self._conn).fetch(
                "SELECT nav_date AS trade_date, nav, nav AS adj_close, nav AS high, nav AS low "
                "FROM mf_nav WHERE scheme_code = $1 ORDER BY nav_date",
                scheme_code,
            )
            self._navs[scheme_code] = _to_bars(rows, "nav", "adj_close", "high", "low")
        return self._navs[scheme_code]


def _to_bars(rows: Sequence[asyncpg.Record], close: str, adj: str, high: str, low: str) -> Bars:
    def col(name: str) -> Any:
        return np.array([r[name] for r in rows], dtype=np.float64)

    return Bars(
        dates=[r["trade_date"] for r in rows],
        close=col(close),
        adj_close=col(adj),
        high=col(high),
        low=col(low),
        volume=np.zeros(len(rows), dtype=np.float64),
    )


async def _evaluate_one(
    conn: asyncpg.Connection, row: asyncpg.Record, data: _Data, now: datetime
) -> EvalResult | None:
    kind = str(row["kind"])
    alert = AlertRow(
        id=int(row["id"]),
        kind=kind,
        params=_doc(row["params"]) or {},
        one_shot=bool(row["one_shot"]),
        cooldown_minutes=int(row["cooldown_minutes"]),
        label=str(row["scheme_name"] if row["mf_scheme_code"] is not None else row["symbol"]),
        last_fired_at=row["last_fired_at"],
        last_state=_doc(row["last_state"]),
    )
    iid = row["instrument_id"]
    if kind in ("results_declared", "holding_change") and not alert.last_state:
        alert = await _baselined(conn, alert, row)
    if kind in ("nav_above", "nav_below"):
        return evaluate_bar_alert(alert, await data.navs(int(row["mf_scheme_code"]), conn), now)
    if kind == "results_upcoming":
        events = await conn.fetch(
            "SELECT id, event_date FROM event_calendar "
            "WHERE instrument_id = $1 AND event_type = 'results'",
            iid,
        )
        return evaluate_results_upcoming(
            alert, [(int(e["id"]), e["event_date"]) for e in events], ist_today(now)
        )
    if kind == "results_declared":
        latest: date | None = await conn.fetchval(
            "SELECT max(period_end) FROM fundamental_value "
            "WHERE instrument_id = $1 AND period_type = 'Q'",
            iid,
        )
        return evaluate_results_declared(alert, latest)
    if kind == "holding_change":
        rows = await conn.fetch(
            "SELECT quarter_end, promoter_pct, fii_pct, dii_pct, mf_pct FROM shareholding "
            "WHERE instrument_id = $1 ORDER BY quarter_end DESC LIMIT 2",
            iid,
        )
        quarters = [
            (
                r["quarter_end"],
                {k: (None if r[k] is None else float(r[k])) for k in _HOLDER_KEYS},
            )
            for r in rows
        ]
        return evaluate_holding_change(alert, quarters)
    return evaluate_bar_alert(alert, await data.bars(int(iid), conn), now)


async def _baselined(conn: asyncpg.Connection, alert: AlertRow, row: asyncpg.Record) -> AlertRow:
    """First evaluation of a results/holding alert: the baseline is what existed when the alert was
    created (``fetched_at <= created_at``), so news imported between creation and this run still
    fires instead of being swallowed as "already there" (B12/D06 review)."""
    if alert.kind == "results_declared":
        key, base = (
            "latest_period",
            await conn.fetchval(
                "SELECT max(period_end) FROM fundamental_value WHERE instrument_id = $1 "
                "AND period_type = 'Q' AND fetched_at <= $2",
                row["instrument_id"],
                row["created_at"],
            ),
        )
    else:
        key, base = (
            "latest_quarter",
            await conn.fetchval(
                "SELECT max(quarter_end) FROM shareholding WHERE instrument_id = $1 "
                "AND fetched_at <= $2",
                row["instrument_id"],
                row["created_at"],
            ),
        )
    state: dict[str, Any] = {"initialised": True}
    if base is not None:
        state[key] = base.isoformat()
    return replace(alert, last_state=state)


_HOLDER_KEYS = ("promoter_pct", "fii_pct", "dii_pct", "mf_pct")


async def _insert_event(
    conn: asyncpg.Connection, alert_id: int, now: datetime, key: str, payload: dict[str, Any]
) -> bool:
    got = await conn.fetchval(
        "INSERT INTO alert_event (alert_id, fired_at, dedupe_key, payload) "
        "VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (alert_id, dedupe_key) DO NOTHING "
        "RETURNING id",
        alert_id,
        now,
        key,
        json.dumps(payload),
    )
    return got is not None


async def _expire(
    conn: asyncpg.Connection, row: asyncpg.Record, now: datetime, reason: str, note: str | None
) -> str:
    alert_id = int(row["id"])
    state = {**(_doc(row["last_state"]) or {}), "expired_reason": reason}
    await conn.execute(
        "UPDATE alert SET status = 'expired', last_state = $2::jsonb WHERE id = $1",
        alert_id,
        json.dumps(state),
    )
    if note is not None:  # delisted: tell the owner why (a history row and a Telegram message)
        label = str(row["symbol"])
        message = f"<b>{esc(label)}</b> {note}. Alert #{alert_id}"
        await _insert_event(
            conn,
            alert_id,
            now,
            f"{alert_id}|expired|{reason}",
            {"kind": row["kind"], "label": label, "note": note, "message": message},
        )
    return "expired"


async def evaluate_alert(
    pool: asyncpg.Pool, alert_id: int, data: _Data, now: datetime
) -> dict[str, int | str]:
    """One alert in one transaction under a row lock. Returns ``{"outcome": ..., "events": n}``."""
    async with pool.acquire() as conn, conn.transaction():
        row = await conn.fetchrow(_ALERT_SQL + "WHERE a.id = $1 FOR UPDATE OF a", alert_id)
        if row is None:
            return {"outcome": "gone", "events": 0}
        if row["status"] != "active":  # paused / fired / expired while we waited for the lock
            return {"outcome": "inactive", "events": 0}
        today = ist_today(now)
        if row["expires_on"] is not None and row["expires_on"] < today:
            return {"outcome": await _expire(conn, row, now, "expires_on", None), "events": 0}
        if row["inst_status"] == "delisted":
            note = "expired: the stock is delisted"
            return {"outcome": await _expire(conn, row, now, "delisted", note), "events": 1}
        result = await _evaluate_one(conn, row, data, now)
        if result is None:
            return {"outcome": "skipped", "events": 0}
        inserted = 0
        for fire in result.fires:
            if await _insert_event(conn, alert_id, now, fire.dedupe_key, fire.payload):
                inserted += 1
        status = "fired" if result.fires and result.final else "active"
        changed = result.state != _doc(row["last_state"]) or inserted or status != "active"
        if changed:
            await conn.execute(
                "UPDATE alert SET last_state = $2::jsonb, status = $3, "
                "last_fired_at = CASE WHEN $4 > 0 THEN $5 ELSE last_fired_at END WHERE id = $1",
                alert_id,
                None if result.state is None else json.dumps(result.state),
                status,
                inserted,
                now,
            )
        return {"outcome": status if status != "active" else "evaluated", "events": inserted}


async def evaluate_alerts(
    pool: asyncpg.Pool,
    *,
    symbols: Sequence[str] | None = None,
    now: Clock = _utcnow,
    should_stop: Callable[[], bool] = lambda: False,
) -> dict[str, Any]:
    """Evaluate active alerts: those on ``symbols`` (post_import) or all of them (EOD run)."""
    when = now()
    if symbols is None:
        ids = await pool.fetch("SELECT id FROM alert WHERE status = 'active' ORDER BY id")
    else:
        ids = await pool.fetch(
            "SELECT a.id FROM alert a JOIN instrument i ON i.id = a.instrument_id "
            "WHERE a.status = 'active' AND i.symbol = ANY($1) ORDER BY a.id",
            list(symbols),
        )
    data = _Data(pool)
    summary: dict[str, Any] = {"alerts": len(ids), "events": 0, "errors": 0, "expired": 0}
    for rec in ids:
        if should_stop():
            summary["stopped_early"] = True
            break
        try:
            out = await evaluate_alert(pool, int(rec["id"]), data, when)
        except Exception as exc:  # per-item isolation: one bad alert never stops the rest
            summary["errors"] += 1
            log.warning(
                "alert evaluation failed",
                extra={"item": int(rec["id"]), "error": scrub(type(exc).__name__)},
            )
            continue
        summary["events"] += int(out["events"])
        summary["expired"] += 1 if out["outcome"] == "expired" else 0
    return summary


# --------------------------------------------------------------------------- delivery store
class PgDeliveryStore:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool

    async def owner(self) -> tuple[int | None, dict[str, Any] | None]:
        row = await self._pool.fetchrow("SELECT telegram_chat_id, quiet_hours FROM app_user")
        if row is None:
            return None, None
        chat = row["telegram_chat_id"]
        return (None if chat is None else int(chat)), _doc(row["quiet_hours"])

    async def expire_unlinked(self, now: datetime) -> int:
        res = await self._pool.execute(
            "UPDATE alert_event SET delivery_status = 'failed', last_error = $1 "
            "WHERE delivery_status = 'pending' AND delivery_attempts = 0 AND fired_at < $2",
            NOT_LINKED,
            now - NOT_LINKED_AFTER,
        )
        return int(res.split()[-1])

    async def note_pending(self, reason: str) -> int:
        await self._pool.execute(
            "UPDATE alert_event SET last_error = $1 WHERE delivery_status = 'pending' "
            "AND (last_error IS NULL OR last_error = ANY($2))",
            reason,
            [NOT_LINKED, NOT_CONFIGURED, "quiet_hours"],
        )
        return int(
            await self._pool.fetchval(
                "SELECT count(*) FROM alert_event WHERE delivery_status = 'pending'"
            )
        )

    async def claim_due(self, now: datetime, lease: timedelta) -> list[PendingEvent]:
        rows = await self._pool.fetch(
            "UPDATE alert_event e SET delivery_attempts = e.delivery_attempts + 1, "
            "payload = jsonb_set(e.payload, '{delivery}', "
            "  jsonb_build_object('next_attempt_at', $2::text), true) "
            "WHERE e.id IN (SELECT id FROM alert_event WHERE delivery_status = 'pending' "
            "  AND (payload->'delivery'->>'next_attempt_at' IS NULL "
            "       OR (payload->'delivery'->>'next_attempt_at')::timestamptz <= $1) "
            "  ORDER BY id FOR UPDATE SKIP LOCKED) "
            "RETURNING e.id, e.payload->>'message' AS message",
            now,
            (now + lease).isoformat(),
        )
        return sorted(
            (PendingEvent(int(r["id"]), str(r["message"] or "")) for r in rows), key=lambda e: e.id
        )

    async def mark_sent(self, ids: Sequence[int], now: datetime) -> None:
        await self._pool.execute(
            "UPDATE alert_event SET delivery_status = 'sent', delivered_at = $2, "
            "last_error = NULL, payload = payload - 'delivery' WHERE id = ANY($1)",
            list(ids),
            now,
        )

    async def mark_attempt_failed(
        self, ids: Sequence[int], error: str, next_at: datetime, max_attempts: int
    ) -> None:
        await self._pool.execute(
            "UPDATE alert_event SET last_error = $2, "
            "delivery_status = CASE WHEN delivery_attempts >= $4 THEN 'failed' ELSE 'pending' END, "
            "payload = jsonb_set(payload, '{delivery}', "
            "  jsonb_build_object('next_attempt_at', $3::text), true) WHERE id = ANY($1)",
            list(ids),
            scrub(error)[:200],
            next_at.isoformat(),
            max_attempts,
        )

    async def release(self, ids: Sequence[int]) -> None:
        await self._pool.execute(
            "UPDATE alert_event SET delivery_attempts = greatest(delivery_attempts - 1, 0), "
            "payload = payload - 'delivery' WHERE id = ANY($1)",
            list(ids),
        )


async def deliver_alerts(
    pool: asyncpg.Pool, sender: TelegramSender | None = None, now: Clock = _utcnow
) -> dict[str, Any]:
    return await deliver_pending(PgDeliveryStore(pool), sender or TelegramSender.from_env(), now)


# --------------------------------------------------------------------------- post_import wiring
def wire_hooks(pool: asyncpg.Pool, hooks: Hooks) -> Hooks:
    """Plug D06 into ``post_import``: evaluate alerts per symbol; after the last symbol (after the
    screener recompute) deliver everything pending, so a big import becomes one digest."""

    async def evaluate_symbol(symbol: str) -> None:
        await evaluate_alerts(pool, symbols=[symbol])

    previous: SymbolsHook = hooks.recompute_screener

    async def finish(symbols: Sequence[str]) -> None:
        try:
            await previous(symbols)
        finally:
            await deliver_alerts(pool)  # never raises past the Telegram result handling

    evaluate: SymbolHook = evaluate_symbol
    return Hooks(
        compute_analysis=hooks.compute_analysis,
        evaluate_alerts=evaluate,
        recompute_screener=finish,
    )
