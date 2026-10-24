"""``compute_analysis`` (docs/04 3.7), D05a part: indicators and returns -> ``analysis_snapshot``,
price metrics -> ``screener_row``. The fundamentals/scores part is D05b and plugs into the same
per-symbol step; this module never touches ``analysis_snapshot.scores``.

Idempotent: a re-run for the same ``as_of`` overwrites its row (``ON CONFLICT``). Only the latest
snapshot keeps the heavy ``series``/``analysis`` arrays (docs/OPEN_QUESTIONS D05a-A2); the latest
30 snapshots are kept (docs/04 3.7).
"""

from __future__ import annotations

import json
import logging
from collections.abc import Sequence
from datetime import date
from typing import Any

import asyncpg
import numpy as np

from worker import actions_db
from worker.analytics.snapshot import DEFAULT_RISK_FREE, VERSION, Bars, build_snapshot
from worker.post_import import HOOKS, Hooks

log = logging.getLogger("worker.analysis")

KEEP_SNAPSHOTS = 30
BENCHMARK = "NIFTY50"

# Price metrics owned by D05a in screener_row.metrics (docs/03 section 9 whitelist).
SCREENER_PRICE_KEYS = ("price", "rsi14", "dist_52w_high_pct", "ret_1m", "ret_6m", "ret_1y")
SCREENER_TEXT_KEYS = ("sector", "industry")


async def load_bars(pool: asyncpg.Pool, instrument_id: int) -> Bars:
    """Valid (non-suspect) bars, ascending; ``suspect`` rows are excluded before anything else."""
    rows = await pool.fetch(
        "SELECT trade_date, close, adj_close, high, low, volume FROM price_daily "
        "WHERE instrument_id = $1 AND NOT suspect ORDER BY trade_date",
        instrument_id,
    )

    def col(name: str) -> Any:
        return np.array([r[name] for r in rows], dtype=np.float64)

    return Bars(
        dates=[r["trade_date"] for r in rows],
        close=col("close"),
        adj_close=col("adj_close"),
        high=col("high"),
        low=col("low"),
        volume=col("volume"),
    )


async def load_benchmark(pool: asyncpg.Pool) -> dict[date, float]:
    rows = await pool.fetch(
        "SELECT trade_date, value FROM market_series WHERE code = $1 ORDER BY trade_date",
        BENCHMARK,
    )
    return {r["trade_date"]: float(r["value"]) for r in rows}


async def load_risk_free(pool: asyncpg.Pool) -> float:
    """``app_setting.RISK_FREE_RATE`` as a fraction; the default 0.065 when absent or invalid."""
    raw = await pool.fetchval("SELECT value FROM app_setting WHERE key = 'RISK_FREE_RATE'")
    if raw is None:
        return DEFAULT_RISK_FREE
    try:
        value = json.loads(raw) if isinstance(raw, str) else raw
        rate = float(value)
    except (TypeError, ValueError):
        return DEFAULT_RISK_FREE
    return rate if 0.0 <= rate < 1.0 else DEFAULT_RISK_FREE


async def compute_analysis(pool: asyncpg.Pool, symbol: str) -> dict[str, Any]:
    """One symbol: build and store the snapshot. Returns a small summary for the job result."""
    inst = await pool.fetchrow("SELECT id FROM instrument WHERE symbol = $1", symbol)
    if inst is None:
        return {"status": "unknown_symbol"}
    iid = int(inst["id"])
    bars = await load_bars(pool, iid)
    warnings = await actions_db.stock_warnings(pool, iid)
    snap = build_snapshot(
        bars,
        await load_benchmark(pool),
        risk_free=await load_risk_free(pool),
        warnings=warnings,
    )
    async with pool.acquire() as conn, conn.transaction():
        if snap is None:
            # Too little history (or all of it was deleted): a stale snapshot must not survive.
            await conn.execute("DELETE FROM analysis_snapshot WHERE instrument_id = $1", iid)
            await conn.execute(
                "UPDATE screener_row SET metrics = metrics - $2::text[] WHERE instrument_id = $1",
                iid,
                list(SCREENER_PRICE_KEYS),
            )
            return {"status": "insufficient_bars", "bars": len(bars.dates)}
        as_of = bars.dates[-1]
        # Trimmed/deleted newest bars: snapshots after the last bar are stale.
        await conn.execute(
            "DELETE FROM analysis_snapshot WHERE instrument_id = $1 AND as_of > $2", iid, as_of
        )
        await conn.execute(
            "INSERT INTO analysis_snapshot (instrument_id, as_of, indicators, scores, version) "
            "VALUES ($1, $2, $3::jsonb, '{}'::jsonb, $4) "
            "ON CONFLICT (instrument_id, as_of) DO UPDATE SET "
            "indicators = EXCLUDED.indicators, version = EXCLUDED.version",
            iid,
            as_of,
            json.dumps(snap),
            VERSION,
        )
        await conn.execute(
            "UPDATE analysis_snapshot SET indicators = indicators - 'series' - 'analysis' "
            "WHERE instrument_id = $1 AND as_of < $2 AND (indicators ? 'series' "
            "OR indicators ? 'analysis')",
            iid,
            as_of,
        )
        await conn.execute(
            "DELETE FROM analysis_snapshot WHERE instrument_id = $1 AND as_of NOT IN ("
            "SELECT as_of FROM analysis_snapshot WHERE instrument_id = $1 "
            "ORDER BY as_of DESC LIMIT $2)",
            iid,
            KEEP_SNAPSHOTS,
        )
    return {"status": "ok", "as_of": as_of.isoformat(), "bars": snap["bars"], "warnings": warnings}


def screener_price_metrics(snap: dict[str, Any]) -> dict[str, float]:
    """Price metrics for ``screener_row`` (non-null only; a missing key means unknown)."""
    tech = snap["technicals"]
    cal = snap["returns"]["calendar"]
    values = {
        "price": snap["last_close"],
        "rsi14": tech["rsi14"],
        "dist_52w_high_pct": tech["dist_52w_high_pct"],
        "ret_1m": cal["ret_1m"],
        "ret_6m": cal["ret_6m"],
        "ret_1y": cal["ret_1y"],
    }
    return {k: float(v) for k, v in values.items() if v is not None}


async def recompute_screener(pool: asyncpg.Pool, symbols: Sequence[str]) -> int:
    """Rebuild the price metrics of ``screener_row`` for ``symbols`` from their latest snapshot.

    Only the keys D05a owns are replaced; fundamental keys written by D05b are preserved.
    """
    written = 0
    for symbol in symbols:
        row = await pool.fetchrow(
            "SELECT i.id, i.sector, i.industry, s.as_of, s.indicators FROM instrument i "
            "JOIN analysis_snapshot s ON s.instrument_id = i.id WHERE i.symbol = $1 "
            "ORDER BY s.as_of DESC LIMIT 1",
            symbol,
        )
        if row is None:
            continue
        raw = row["indicators"]
        snap = json.loads(raw) if isinstance(raw, str) else raw
        metrics: dict[str, Any] = dict(screener_price_metrics(snap))
        for key in SCREENER_TEXT_KEYS:
            if row[key]:
                metrics[key] = row[key]
        drop = [*SCREENER_PRICE_KEYS, *SCREENER_TEXT_KEYS]
        await pool.execute(
            "INSERT INTO screener_row (instrument_id, as_of, metrics) VALUES ($1, $2, $3::jsonb) "
            "ON CONFLICT (instrument_id) DO UPDATE SET as_of = EXCLUDED.as_of, "
            "metrics = (screener_row.metrics - $4::text[]) || EXCLUDED.metrics",
            int(row["id"]),
            row["as_of"],
            json.dumps(metrics),
            drop,
        )
        written += 1
    return written


def production_hooks(pool: asyncpg.Pool) -> Hooks:
    """The ``post_import`` hooks with D05a (analysis, screener) and D06 (alerts) plugged in."""

    async def analysis(symbol: str) -> None:
        await compute_analysis(pool, symbol)

    async def screener(symbols: Sequence[str]) -> None:
        await recompute_screener(pool, symbols)

    from worker.alerts_db import wire_hooks  # D06; lazy: alerts_db imports post_import too

    return wire_hooks(
        pool,
        Hooks(
            compute_analysis=analysis,
            evaluate_alerts=HOOKS.evaluate_alerts,
            recompute_screener=screener,
        ),
    )
