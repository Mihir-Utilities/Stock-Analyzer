"""``compute_analysis`` (docs/04 3.7): indicators and returns (D05a) plus derived fundamentals,
trend/quality scores (D05b) -> ``analysis_snapshot``; price and fundamental metrics ->
``screener_row``. The universe-relative risk score (docs/05 6.2) is a separate pass
(``recompute_risk_scores``) because it needs every tracked stock.

Idempotent: a re-run for the same ``as_of`` overwrites its row (``ON CONFLICT``). Only the latest
snapshot keeps the heavy ``series``/``analysis`` arrays (docs/OPEN_QUESTIONS D05a-A2); the latest
30 snapshots are kept (docs/04 3.7).
"""

from __future__ import annotations

import json
import logging
from collections.abc import Sequence
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any

import asyncpg
import numpy as np

from worker import actions_db
from worker.analytics import fundamentals as fnd
from worker.analytics.actions import qty_multiplier
from worker.analytics.inv_common import SETTING_KEYS, InvContext, InvSettings, PeerData
from worker.analytics.inv_months import derive_closed_days
from worker.analytics.relative_strength import norm_sector
from worker.analytics.scores import RiskInput, risk_scores
from worker.analytics.snapshot import DEFAULT_RISK_FREE, VERSION, Bars, build_snapshot
from worker.marketdate import ist_today
from worker.post_import import HOOKS, Hooks

log = logging.getLogger("worker.analysis")
MAX_SCREENER_ERRORS_LOGGED = 50

KEEP_SNAPSHOTS = 30
BENCHMARK = "NIFTY50"
PEER_LOOKBACK_DAYS = (
    430  # calendar days of peer prices: covers the 252-row window (docs/05 12.14.6)
)

# Price metrics owned by D05a in screener_row.metrics (docs/03 section 9 whitelist).
SCREENER_PRICE_KEYS = ("price", "rsi14", "dist_52w_high_pct", "ret_1m", "ret_6m", "ret_1y")
SCREENER_TEXT_KEYS = ("sector", "industry")
# Everything this module owns in screener_row.metrics (replaced on each rebuild).
SCREENER_OWNED_KEYS = [
    *SCREENER_PRICE_KEYS,
    *SCREENER_TEXT_KEYS,
    *fnd.FUNDAMENTAL_SCREENER_KEYS,
    *fnd.SCORE_SCREENER_KEYS,
]


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


async def load_market_closed(pool: asyncpg.Pool, first: date) -> frozenset[date]:
    """Weekdays since ``first`` on which no tracked instrument traded (docs/05 12.1, D-INV3): one
    aggregate over ``price_daily`` returning one row per trading date (about 250 a year)."""
    rows = await pool.fetch(
        "SELECT p.trade_date, count(*) AS n FROM price_daily p "
        "JOIN instrument i ON i.id = p.instrument_id "
        "WHERE i.is_tracked AND NOT p.suspect AND p.trade_date >= $1 GROUP BY p.trade_date",
        first,
    )
    return derive_closed_days({r["trade_date"]: int(r["n"]) for r in rows}, first)


async def load_peers(
    pool: asyncpg.Pool, iid: int, sector: str | None, end: date | None
) -> PeerData | None:
    """Tracked stocks of the same sector (trimmed, case-insensitive) and their valid ``adj_close``
    bars up to ``end``: ONE extra grouped read per ``compute_analysis`` (docs/05 12.14.6). ``None``
    without a sector or bars; a failing read is logged and flagged, never raised."""
    label = norm_sector(sector)
    if label is None or end is None:
        return None if label is None else PeerData(sector=label)
    try:
        rows = await pool.fetch(
            "SELECT i.id, p.trade_date, p.adj_close FROM instrument i "
            "LEFT JOIN price_daily p ON p.instrument_id = i.id AND NOT p.suspect "
            "AND p.adj_close > 0 AND p.trade_date <= $3 AND p.trade_date >= $4 "
            "WHERE i.is_tracked AND i.id <> $1 "
            "AND lower(btrim(i.sector, E' \t\r\n\u00a0')) = lower($2) "
            "ORDER BY i.id, p.trade_date",
            iid,
            label,
            end,
            end - timedelta(days=PEER_LOOKBACK_DAYS),
        )
        by_id: dict[int, tuple[list[date], list[float]]] = {}
        for r in rows:
            d_list, v_list = by_id.setdefault(int(r["id"]), ([], []))
            if r["trade_date"] is not None and np.isfinite(float(r["adj_close"])):
                d_list.append(r["trade_date"])
                v_list.append(float(r["adj_close"]))
        return PeerData(
            sector=label,
            closes={
                pid: (d_list, np.array(v_list, dtype=np.float64))
                for pid, (d_list, v_list) in by_id.items()
                if d_list
            },
            peers_in_sector=len(by_id),
        )
    except Exception as exc:  # the block says compute_error; the snapshot is still written
        log.warning(
            "relative_strength_peers_failed",
            extra={"iid": iid, "error": type(exc).__name__},
        )
        return PeerData(sector=label, failed=True)


async def load_inv_context(
    pool: asyncpg.Pool,
    now: datetime | None = None,
    first: date | None = None,
    *,
    symbol: str | None = None,
    peers: PeerData | None = None,
) -> InvContext:
    """The IST date of this computation, the trading holidays, the market-closed days derived
    from the data since ``first`` (the stock's first bar) and the ``INV_*`` settings with the
    documented fallbacks (docs/05 12.0; INV-A06)."""
    holidays = frozenset(
        r["holiday_date"]
        for r in await pool.fetch(
            "SELECT holiday_date FROM market_holiday WHERE segment = 'trading'"
        )
    )
    rows = await pool.fetch(
        "SELECT key, value FROM app_setting WHERE key = ANY($1::text[])", list(SETTING_KEYS)
    )
    raw = {r["key"]: _loads(r["value"]) for r in rows}
    return InvContext(
        today=ist_today(now),
        holidays=holidays,
        market_closed=frozenset() if first is None else await load_market_closed(pool, first),
        settings=InvSettings.from_mapping(raw),
        symbol=symbol,
        peers=peers,
    )


async def load_fund_inputs(pool: asyncpg.Pool, iid: int, bars: Bars) -> fnd.FundInputs | None:
    """Owner-entered fundamentals, confirmed actions, shareholding and prices for D05b."""
    ok = (
        np.isfinite(bars.close)
        & np.isfinite(bars.adj_close)
        & (bars.close > 0)
        & (bars.adj_close > 0)
        & np.isfinite(bars.high)
        & (bars.high > 0)
        & np.isfinite(bars.low)
        & (bars.low > 0)
    )  # the same bars build_snapshot keeps (D05aR-1)
    dates = [d for d, keep in zip(bars.dates, ok, strict=True) if keep]
    if not dates:
        return None
    close = bars.close[ok]
    kind = await pool.fetchval("SELECT company_type FROM instrument WHERE id = $1", iid)
    fund = await pool.fetch(
        "SELECT basis, period_type, period_end, metric_key, value, unit, source, filed_on, "
        "fetched_at FROM fundamental_value WHERE instrument_id = $1 AND source <> 'derived'",
        iid,
    )
    actions = await pool.fetch(
        "SELECT ex_date, action_type, ratio_num, ratio_den, amount_per_share FROM corporate_action "
        "WHERE instrument_id = $1 AND status = 'confirmed' ORDER BY ex_date, id",
        iid,
    )
    mults: list[fnd.Multiplier] = []
    divs: list[fnd.Dividend] = []
    seen: set[tuple[date, str]] = set()
    for a in actions:
        if a["action_type"] == "dividend":
            if a["amount_per_share"] is not None and a["amount_per_share"] > 0:
                divs.append(fnd.Dividend(a["ex_date"], float(a["amount_per_share"])))
            continue
        mult = qty_multiplier(a["action_type"], a["ratio_num"], a["ratio_den"])
        key = (a["ex_date"], a["action_type"])
        if mult is None or key in seen:  # duplicates: the earliest id wins (B07R-1)
            continue
        seen.add(key)
        mults.append(fnd.Multiplier(a["ex_date"], float(Decimal(mult))))
    hold = await pool.fetch(
        "SELECT quarter_end, promoter_pct, fii_pct, dii_pct, mf_pct, promoter_pledged_pct "
        "FROM shareholding WHERE instrument_id = $1 ORDER BY quarter_end",
        iid,
    )
    top = await pool.fetchrow(
        "SELECT value_num, source FROM top_ratio WHERE instrument_id = $1 AND key = 'pb'", iid
    )

    def f(v: Any) -> float | None:
        return None if v is None else float(v)

    return fnd.FundInputs(
        rows=[
            fnd.FundRow(
                r["basis"],
                r["period_type"],
                r["period_end"],
                r["metric_key"],
                f(r["value"]),
                r["unit"],
                r["source"],
                r["filed_on"],
                r["fetched_at"],
            )
            for r in fund
        ],
        as_of=dates[-1],
        close=float(close[-1]),
        price_dates=dates,
        price_close=close,
        multipliers=mults,
        dividends=divs,
        holdings=[
            fnd.HoldingRow(
                h["quarter_end"],
                f(h["promoter_pct"]),
                f(h["fii_pct"]),
                f(h["dii_pct"]),
                f(h["mf_pct"]),
                f(h["promoter_pledged_pct"]),
            )
            for h in hold
        ],
        financial=kind == "financial",
        top_pb=None
        if top is None or top["value_num"] is None
        else (float(top["value_num"]), str(top["source"])),
    )


async def compute_analysis(
    pool: asyncpg.Pool, symbol: str, *, now: datetime | None = None
) -> dict[str, Any]:
    """One symbol: build and store the snapshot. Returns a small summary for the job result."""
    inst = await pool.fetchrow("SELECT id, sector FROM instrument WHERE symbol = $1", symbol)
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
        inv_ctx=await load_inv_context(
            pool,
            now,
            bars.dates[0] if bars.dates else None,
            symbol=symbol,
            peers=await load_peers(
                pool, iid, inst["sector"], bars.dates[-1] if bars.dates else None
            ),
        ),
    )
    scores: dict[str, Any] = {}
    if snap is not None:
        inputs = await load_fund_inputs(pool, iid, bars)
        if inputs is not None:
            scores = fnd.attach_fundamentals(snap, inputs, now or datetime.now(UTC))
    async with pool.acquire() as conn, conn.transaction():
        if snap is None:
            # Too little history (or all of it was deleted): a stale snapshot must not survive.
            await conn.execute("DELETE FROM analysis_snapshot WHERE instrument_id = $1", iid)
            await conn.execute(
                "UPDATE screener_row SET metrics = metrics - $2::text[] WHERE instrument_id = $1",
                iid,
                [k for k in SCREENER_OWNED_KEYS if k not in SCREENER_TEXT_KEYS],  # sector stays
            )
            return {"status": "insufficient_bars", "bars": len(bars.dates)}
        as_of = bars.dates[-1]
        # Trimmed/deleted newest bars: snapshots after the last bar are stale.
        await conn.execute(
            "DELETE FROM analysis_snapshot WHERE instrument_id = $1 AND as_of > $2", iid, as_of
        )
        await conn.execute(
            "INSERT INTO analysis_snapshot (instrument_id, as_of, indicators, scores, version) "
            "VALUES ($1, $2, $3::jsonb, $5::jsonb, $4) "
            "ON CONFLICT (instrument_id, as_of) DO UPDATE SET "
            "indicators = EXCLUDED.indicators, version = EXCLUDED.version, "
            "scores = (analysis_snapshot.scores - 'trend' - 'quality') || EXCLUDED.scores",
            iid,
            as_of,
            json.dumps(snap, allow_nan=False),
            VERSION,
            json.dumps(scores, allow_nan=False),
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


def _loads(raw: Any) -> Any:
    return json.loads(raw) if isinstance(raw, str) else raw


def screener_score_metrics(scores: dict[str, Any]) -> dict[str, float]:
    """``trend_score``/``quality_score``/``risk_score`` (non-null only)."""
    out: dict[str, float] = {}
    for name in ("trend", "quality", "risk"):
        v = (scores.get(name) or {}).get("score")
        if isinstance(v, int | float) and not isinstance(v, bool) and np.isfinite(v):
            out[f"{name}_score"] = float(v)
    return out


async def _recompute_screener_one(pool: asyncpg.Pool, symbol: str) -> int:
    row = await pool.fetchrow(
        "SELECT i.id, i.sector, i.industry, s.as_of, s.scores, "
        "s.indicators - 'series' - 'analysis' AS indicators FROM instrument i "
        "JOIN analysis_snapshot s ON s.instrument_id = i.id WHERE i.symbol = $1 "
        "ORDER BY s.as_of DESC LIMIT 1",
        symbol,
    )
    if row is None:
        return 0
    snap = _loads(row["indicators"])
    metrics: dict[str, Any] = dict(screener_price_metrics(snap))
    metrics.update(snap.get("fundamentals_screener") or {})
    metrics.update(screener_score_metrics(_loads(row["scores"]) or {}))
    for key in SCREENER_TEXT_KEYS:
        if row[key]:
            metrics[key] = row[key]
    await pool.execute(
        "INSERT INTO screener_row (instrument_id, as_of, metrics) VALUES ($1, $2, $3::jsonb) "
        "ON CONFLICT (instrument_id) DO UPDATE SET as_of = EXCLUDED.as_of, "
        "metrics = (screener_row.metrics - $4::text[]) || EXCLUDED.metrics",
        int(row["id"]),
        row["as_of"],
        json.dumps(metrics, allow_nan=False),
        SCREENER_OWNED_KEYS,
    )
    return 1


async def recompute_screener(pool: asyncpg.Pool, symbols: Sequence[str]) -> int:
    """Rebuild the metrics of ``screener_row`` for ``symbols`` from their latest snapshot.

    Replaces exactly the keys this module owns (price, text, fundamental, shareholding and score
    keys); a key whose value is unknown is absent, never 0 (docs/03 section 9).
    """
    written = 0
    errors = 0
    for symbol in symbols:
        try:
            written += await _recompute_screener_one(pool, symbol)
        except Exception as exc:  # per-item isolation: one bad stock never fails the batch
            errors += 1
            if errors <= MAX_SCREENER_ERRORS_LOGGED:
                log.warning(
                    "screener_row_failed", extra={"symbol": symbol, "error": type(exc).__name__}
                )
    return written


async def recompute_risk_scores(pool: asyncpg.Pool) -> list[str]:
    """Risk score (docs/05 6.2) for the whole universe of tracked stocks, written into each
    stock's latest snapshot. Returns the symbols whose snapshot was updated."""
    rows = await pool.fetch(
        "SELECT s.instrument_id, i.symbol, s.as_of, "
        "COALESCE((s.indicators->>'bars')::int, 0) AS bars, "
        "s.indicators #> '{returns,risk}' AS risk "
        "FROM instrument i CROSS JOIN LATERAL ("
        "SELECT x.instrument_id, x.as_of, x.indicators FROM analysis_snapshot x "
        "WHERE x.instrument_id = i.id ORDER BY x.as_of DESC LIMIT 1) s "
        "WHERE i.is_tracked"
    )
    universe: dict[int, RiskInput] = {}
    keys: dict[int, tuple[str, date]] = {}
    for r in rows:
        risk = _loads(r["risk"]) or {}
        iid = int(r["instrument_id"])
        keys[iid] = (str(r["symbol"]), r["as_of"])
        universe[iid] = RiskInput(
            bars=int(r["bars"]),
            vol_252=risk.get("vol_252"),
            maxdd_3y=risk.get("maxdd_3y"),
            beta_252=risk.get("beta_252"),
            adv_value_60_cr=risk.get("adv_value_60_cr"),
        )
    result = risk_scores(universe)
    async with pool.acquire() as conn, conn.transaction():
        for iid, res in result.items():
            await conn.execute(
                "UPDATE analysis_snapshot SET scores = jsonb_set(scores, '{risk}', $3::jsonb) "
                "WHERE instrument_id = $1 AND as_of = $2",
                iid,
                keys[iid][1],
                json.dumps(res, allow_nan=False),
            )
    return [keys[iid][0] for iid in result]


def production_hooks(pool: asyncpg.Pool) -> Hooks:
    """The ``post_import`` hooks with D05a (analysis, screener) and D06 (alerts) plugged in."""

    async def analysis(symbol: str) -> None:
        await compute_analysis(pool, symbol)

    async def screener(symbols: Sequence[str]) -> None:
        # The risk score is universe-relative: a changed stock moves everyone's percentiles.
        everyone = await recompute_risk_scores(pool)
        await recompute_screener(pool, list(dict.fromkeys([*symbols, *everyone])))

    from worker.alerts_db import wire_hooks  # D06; lazy: alerts_db imports post_import too

    return wire_hooks(
        pool,
        Hooks(
            compute_analysis=analysis,
            evaluate_alerts=HOOKS.evaluate_alerts,
            recompute_screener=screener,
        ),
    )
