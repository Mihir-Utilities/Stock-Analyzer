"""Database side of D03: detect_actions, history re-adjustment, soft flags and dismissals.

Spec: docs/04 3.2 (detect_actions), docs/01 3.7 (adjustment policy D-K, soft flag D-O, D-U),
docs/05 8.2. Parameterised queries only; every write is idempotent.
"""

from __future__ import annotations

import html
import logging
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from typing import Any, Protocol

import asyncpg

from worker.analytics.actions import (
    FLAG_LARGE_DROP,
    WARN_CONFLICT,
    WARN_UNCONFIRMED,
    Bar,
    Detection,
    DetectorConfig,
    SoftFlag,
    adjustment_steps,
    detect_splits,
    qty_multiplier,
    soft_drop_flags,
)
from worker.logs import scrub
from worker.marketdate import ist_today

log = logging.getLogger("worker.actions")

# Action types that make an ex-date "taken": the detector must not add a second candidate.
_SPLIT_LIKE = ("split", "bonus", "split_or_bonus")


class Notifier(Protocol):
    """Owner notifications (Telegram, D06 wires the real one). Must not raise for delivery."""

    async def send_html(self, text: str) -> None: ...


class NullNotifier:
    async def send_html(self, text: str) -> None:
        log.info("owner notification dropped (no notifier wired)")


@dataclass
class DetectOutcome:
    symbol: str
    new_actions: list[Detection] = field(default_factory=list)
    already_known: int = 0
    conflicts: list[date] = field(default_factory=list)
    soft_flags: list[SoftFlag] = field(default_factory=list)

    def summary(self) -> dict[str, Any]:
        return {
            "symbol": self.symbol,
            "new_actions": [d.ex_date.isoformat() for d in self.new_actions],
            "conflicts": [d.isoformat() for d in self.conflicts],
            "soft_flags": [f.trade_date.isoformat() for f in self.soft_flags],
        }


async def instrument_id_for(pool: asyncpg.Pool, symbol: str) -> int | None:
    row = await pool.fetchrow("SELECT id FROM instrument WHERE symbol = $1", symbol)
    return None if row is None else int(row["id"])


async def load_bars(pool: asyncpg.Pool, instrument_id: int) -> list[Bar]:
    rows = await pool.fetch(
        "SELECT trade_date, close, volume, src_adjusted FROM price_daily "
        "WHERE instrument_id = $1 ORDER BY trade_date",
        instrument_id,
    )
    return [
        Bar(r["trade_date"], float(r["close"]), int(r["volume"]), r["src_adjusted"]) for r in rows
    ]


def detected_message(symbol: str, ex_date: date) -> str:
    """docs/04 3.2 note text; dynamic text is HTML-escaped (CLAUDE.md section 4)."""
    return (
        f"Possible split/bonus on {html.escape(symbol)} ({ex_date.isoformat()}). "
        "Confirm in the app."
    )


async def detect_actions(
    pool: asyncpg.Pool,
    symbol: str,
    *,
    notifier: Notifier | None = None,
    cfg: DetectorConfig | None = None,
    dry_run: bool = False,
) -> DetectOutcome:
    """docs/04 3.2 for one symbol: insert new ``detected`` candidates, one note per new action."""
    notifier = notifier or NullNotifier()
    cfg = cfg or DetectorConfig()
    outcome = DetectOutcome(symbol)
    instrument_id = await instrument_id_for(pool, symbol)
    if instrument_id is None:
        raise LookupError(f"unknown symbol {symbol}")
    bars = await load_bars(pool, instrument_id)
    known_rows = await pool.fetch(
        "SELECT ex_date FROM corporate_action WHERE instrument_id = $1 AND action_type = ANY($2)",
        instrument_id,
        list(_SPLIT_LIKE),
    )
    known_dates = {
        r["ex_date"] for r in known_rows
    }  # includes rejected: never re-detected (ACT-04)
    detections = detect_splits(bars, cfg)
    for det in detections:
        if det.ex_date in known_dates:
            outcome.already_known += 1
            continue
        if dry_run:  # docs/04 rule 9: report, write nothing
            outcome.new_actions.append(det)
            continue
        row = await pool.fetchrow(
            "INSERT INTO corporate_action (instrument_id, ex_date, action_type, status, "
            "ratio_num, ratio_den, purpose_text, parsed_ok, source) "
            "VALUES ($1, $2, 'split_or_bonus', 'detected', $3, $4, '', true, 'detected') "
            "ON CONFLICT (instrument_id, ex_date, action_type, purpose_text) DO NOTHING "
            "RETURNING id",
            instrument_id,
            det.ex_date,
            Decimal(det.ratio_num),
            Decimal(det.ratio_den),
        )
        if row is None:
            outcome.already_known += 1
            continue
        outcome.new_actions.append(det)
        if det.conflict:
            outcome.conflicts.append(det.ex_date)
        try:  # a failed note never fails the job and is not retried (once per action)
            await notifier.send_html(detected_message(symbol, det.ex_date))
        except Exception as exc:
            log.warning("detected-action note not delivered: %s", scrub(type(exc).__name__))
    # Soft flag (D-O): drops of 20% or more that are not a detection and not already an action.
    taken = known_dates | {d.ex_date for d in detections}
    outcome.soft_flags = soft_drop_flags(bars, taken, cfg)
    return outcome


async def stock_warnings(pool: asyncpg.Pool, instrument_id: int) -> list[str]:
    """Warning codes for a stock, derived from stored rows (no column stores them).

    ``UNCONFIRMED_ACTION``: a detected action awaits the owner (docs/01 3.7).
    ``ADJUSTMENT_CONFLICT``: a still-``detected`` app-detected action whose ex-date bar (or the
    bar before it) was imported with ``src_adjusted=true`` (docs/01 3.7 rule 3, ACT-11).
    The soft flag (D-O) never appears here.
    """
    codes: list[str] = []
    detected = await pool.fetchval(
        "SELECT count(*) FROM corporate_action "
        "WHERE instrument_id = $1 AND status = 'detected' AND source = 'detected'",
        instrument_id,
    )
    if detected:
        codes.append(WARN_UNCONFIRMED)
    conflict = await pool.fetchval(
        "SELECT EXISTS (SELECT 1 FROM corporate_action ca WHERE ca.instrument_id = $1 "
        "AND ca.status = 'detected' AND ca.source = 'detected' AND EXISTS ("
        "  SELECT 1 FROM price_daily p WHERE p.instrument_id = ca.instrument_id AND p.src_adjusted "
        "  AND p.trade_date IN (ca.ex_date, (SELECT max(q.trade_date) FROM price_daily q "
        "       WHERE q.instrument_id = ca.instrument_id AND q.trade_date < ca.ex_date))))",
        instrument_id,
    )
    if conflict:
        codes.append(WARN_CONFLICT)
    return codes


async def readjust_history(
    pool: asyncpg.Pool, symbol: str, *, as_of: date | None = None, dry_run: bool = False
) -> dict[str, Any]:
    """Recompute ``adj_close`` for a stock's whole history in one set-based UPDATE.

    Only bars with ``src_adjusted=false`` are multiplied, and only by *confirmed* split/bonus
    actions with ``ex_date <= as_of`` (default: today in IST); ``src_adjusted=true`` bars keep
    ``adj_close = close`` (D-K, ACT-12). Idempotent: only rows whose value changes are written.
    Confirmed rows of other types, or a ``split_or_bonus`` the owner never typed, are never
    applied and are listed in ``review_needed`` (ACT-08).
    """
    instrument_id = await instrument_id_for(pool, symbol)
    if instrument_id is None:
        raise LookupError(f"unknown symbol {symbol}")
    as_of = as_of or ist_today()
    rows = await pool.fetch(
        "SELECT ex_date, action_type, ratio_num, ratio_den FROM corporate_action "
        "WHERE instrument_id = $1 AND status = 'confirmed' ORDER BY ex_date",
        instrument_id,
    )
    pairs: list[tuple[date, Decimal]] = []
    review: list[str] = []
    for r in rows:
        mult = qty_multiplier(r["action_type"], r["ratio_num"], r["ratio_den"])
        if mult is not None:
            pairs.append((r["ex_date"], mult))
        elif r["action_type"] in (
            "split",
            "bonus",
            "split_or_bonus",
            "rights",
            "buyback",
            "merger",
            "demerger",
        ):
            review.append(f"{r['ex_date'].isoformat()}:{r['action_type']}")
    steps = adjustment_steps(pairs, as_of)
    if dry_run:
        return {
            "symbol": symbol,
            "rows_updated": None,
            "actions_applied": len(steps),
            "review_needed": review,
        }
    status = await pool.execute(
        "UPDATE price_daily p SET adj_close = n.new_adj FROM ("
        "  SELECT q.trade_date, CASE WHEN q.src_adjusted THEN q.close ELSE q.close * COALESCE("
        "    (SELECT s.f FROM unnest($2::date[], $3::float8[]) AS s(d, f) "
        "     WHERE s.d > q.trade_date ORDER BY s.d LIMIT 1), 1.0) END AS new_adj "
        "  FROM price_daily q WHERE q.instrument_id = $1) n "
        "WHERE p.instrument_id = $1 AND p.trade_date = n.trade_date "
        "AND p.adj_close IS DISTINCT FROM n.new_adj",
        instrument_id,
        [d for d, _ in steps],
        [float(f) for _, f in steps],
    )
    return {
        "symbol": symbol,
        "rows_updated": int(status.split()[-1]),
        "actions_applied": len(steps),
        "review_needed": review,
    }


# --------------------------------------------------------------------------- soft flag dismissals
async def list_soft_flags(
    pool: asyncpg.Pool, symbol: str, *, cfg: DetectorConfig | None = None
) -> list[SoftFlag]:
    """Soft one-day-drop notices not yet dismissed (D-O, D-U). Derived, nothing is stored."""
    instrument_id = await instrument_id_for(pool, symbol)
    if instrument_id is None:
        raise LookupError(f"unknown symbol {symbol}")
    cfg = cfg or DetectorConfig()
    bars = await load_bars(pool, instrument_id)
    taken = {
        r["ex_date"]
        for r in await pool.fetch(
            "SELECT ex_date FROM corporate_action "
            "WHERE instrument_id = $1 AND action_type = ANY($2)",
            instrument_id,
            list(_SPLIT_LIKE),
        )
    } | {d.ex_date for d in detect_splits(bars, cfg)}
    dismissed = {
        r["trade_date"]
        for r in await pool.fetch(
            "SELECT trade_date FROM flag_dismissals WHERE instrument_id = $1 AND flag_type = $2",
            instrument_id,
            FLAG_LARGE_DROP,
        )
    }
    return [f for f in soft_drop_flags(bars, taken, cfg) if f.trade_date not in dismissed]


async def dismiss_flag(pool: asyncpg.Pool, symbol: str, flag_type: str, trade_date: date) -> bool:
    """Dismiss inserts a row; True if newly dismissed (a repeat is a no-op)."""
    instrument_id = await instrument_id_for(pool, symbol)
    if instrument_id is None:
        raise LookupError(f"unknown symbol {symbol}")
    row = await pool.fetchrow(
        "INSERT INTO flag_dismissals (instrument_id, flag_type, trade_date) VALUES ($1, $2, $3) "
        "ON CONFLICT (instrument_id, flag_type, trade_date) DO NOTHING RETURNING instrument_id",
        instrument_id,
        flag_type,
        trade_date,
    )
    return row is not None


async def undo_dismiss_flag(
    pool: asyncpg.Pool, symbol: str, flag_type: str, trade_date: date
) -> bool:
    """Undo deletes the row; True if a dismissal existed."""
    instrument_id = await instrument_id_for(pool, symbol)
    if instrument_id is None:
        raise LookupError(f"unknown symbol {symbol}")
    status = await pool.execute(
        "DELETE FROM flag_dismissals "
        "WHERE instrument_id = $1 AND flag_type = $2 AND trade_date = $3",
        instrument_id,
        flag_type,
        trade_date,
    )
    return bool(status.endswith(" 1"))
