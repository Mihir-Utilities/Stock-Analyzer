"""Database layer of the ML pipeline (docs/02 ``model_run``, ``prediction``,
``prediction_outcome``; docs/04 3.8). Parameterised queries only; ``ON CONFLICT`` everywhere a row
can be seen twice; past predictions are never rewritten."""

from __future__ import annotations

import json
import math
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date
from typing import Any

import asyncpg
import numpy as np

from worker import actions_db, analysis_db
from worker.analytics import returns as rt
from worker.analytics.actions import WARN_UNCONFIRMED
from worker.analytics.snapshot import Bars
from worker.ml import display as dp
from worker.ml.features import MarketInput, Panel, StockInput, trading_days
from worker.ml.guardrail import (
    LIVE_MIN_DATES,
    LIVE_RECOVERY_MIN_RESOLVED,
    LiveGate,
    LiveRecord,
    live_gate,
)
from worker.ml.predict import UNIVERSE_MIN_BARS, PredRow, StockInfo
from worker.ml.train import HorizonTrain, TrainOutput

NIFTY = "NIFTY50"
VIX = "INDIAVIX"


def jsonable(v: Any) -> Any:
    """JSON-safe copy: nan/inf become null (never 0), numpy scalars become Python numbers."""
    if isinstance(v, dict):
        return {str(k): jsonable(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [jsonable(x) for x in v]
    if isinstance(v, (np.floating, float)):
        f = float(v)
        return f if math.isfinite(f) else None
    if isinstance(v, np.integer):
        return int(v)
    if isinstance(v, np.bool_):
        return bool(v)
    return v


@dataclass(frozen=True)
class Loaded:
    """Tracked stocks with valid bars, split into the ML universe and the rest."""

    universe: list[StockInput]
    ids: dict[str, int]
    infos: dict[str, StockInfo]
    excluded: dict[str, str]  # symbol -> reason (not in the universe)


async def load_holidays(pool: asyncpg.Pool) -> frozenset[date]:
    rows = await pool.fetch("SELECT holiday_date FROM market_holiday WHERE segment = 'trading'")
    return frozenset(r["holiday_date"] for r in rows)


async def load_market(pool: asyncpg.Pool) -> MarketInput:
    """Reserved ``market_series`` codes; a code with no rows is ``None`` (features omitted)."""

    async def one(code: str) -> dict[date, float] | None:
        rows = await pool.fetch(
            "SELECT trade_date, value FROM market_series WHERE code = $1 ORDER BY trade_date",
            code,
        )
        return {r["trade_date"]: float(r["value"]) for r in rows} if rows else None

    return MarketInput(nifty=await one(NIFTY), vix=await one(VIX))


async def load_stocks(pool: asyncpg.Pool, *, only_with_bars: int = 1) -> Loaded:
    """Every tracked stock; the universe is those with >= 750 valid bars and no unconfirmed
    action (docs/05 10.1, decision D-H)."""
    inst = await pool.fetch("SELECT id, symbol FROM instrument WHERE is_tracked ORDER BY symbol")
    universe: list[StockInput] = []
    ids: dict[str, int] = {}
    infos: dict[str, StockInfo] = {}
    excluded: dict[str, str] = {}
    for r in inst:
        iid, symbol = int(r["id"]), str(r["symbol"])
        bars: Bars = await analysis_db.load_bars(pool, iid)
        valid = _valid_rows(bars)
        n = int(valid.sum())
        if n < only_with_bars:
            continue
        keep = Bars(
            [d for d, k in zip(bars.dates, valid, strict=True) if k],
            bars.close[valid],
            bars.adj_close[valid],
            bars.high[valid],
            bars.low[valid],
            bars.volume[valid],
        )
        warns = await actions_db.stock_warnings(pool, iid)
        unconfirmed = WARN_UNCONFIRMED in warns
        acts = await pool.fetch(
            "SELECT ex_date FROM corporate_action "
            "WHERE instrument_id = $1 AND status <> 'rejected'",
            iid,
        )
        adv = rt.adv_value_cr(keep.close, keep.volume).value
        ids[symbol] = iid
        infos[symbol] = StockInfo(
            symbol,
            iid,
            n,
            keep.dates[-1],
            float(keep.adj_close[-1]),
            adv,
            tuple(a["ex_date"] for a in acts),
            unconfirmed,
        )
        if unconfirmed:
            excluded[symbol] = dp.NEAR_ACTION
        elif n < UNIVERSE_MIN_BARS:
            excluded[symbol] = dp.INSUFFICIENT_HISTORY
        else:
            universe.append(StockInput(symbol, keep))
    return Loaded(universe, ids, infos, excluded)


def _valid_rows(bars: Bars) -> Any:
    ok = np.ones(len(bars.dates), dtype=bool)
    for a in (bars.close, bars.adj_close, bars.high, bars.low):
        ok &= np.isfinite(a) & (a > 0)
    return ok


# --------------------------------------------------------------------------- training results


async def save_training(pool: asyncpg.Pool, out: TrainOutput, panel: Panel) -> dict[str, Any]:
    """Store candidate/active ``model_run`` rows in ONE transaction (ML-09: an aborted training
    never reaches this function, so no partial model is activated).

    Activation rule: a horizon whose guardrail passes gets ``active`` direction and range runs and
    the previous active pair is retired (artifacts cleared). A failing run is kept as a
    ``candidate`` without artifact and switches the older active pair's ``guardrail_pass`` off
    (its forecasts are hidden, tracking continues) until a newer run passes. When the older pair
    was switched off by the live gate, the new passing pair starts in a recovery window: its
    ``guardrail_pass`` stays false until ``LIVE_RECOVERY_MIN_RESOLVED`` resolved live predictions
    on enough dates have not tripped the gate (``apply_live_gate``).
    A horizon with no model (too few folds) writes nothing: ``no_model`` (D07-7).
    """
    summary: dict[str, Any] = {}
    if out.status == "insufficient_universe":
        return {"status": out.status}
    async with pool.acquire() as conn, conn.transaction():
        for ht in out.horizons:
            if ht.model is None:
                summary[f"{ht.horizon}d"] = {"status": "no_model", "reason": ht.guardrail.reason}
                continue
            summary[f"{ht.horizon}d"] = await _save_horizon(conn, ht, panel, out.meta)
    return summary


async def _save_horizon(
    conn: asyncpg.Connection, ht: HorizonTrain, panel: Panel, meta: dict[str, Any]
) -> dict[str, Any]:
    h = ht.horizon
    activate = ht.guardrail.passed and ht.model is not None
    recovery = await _needs_recovery(conn, h) if activate else None
    status = "active" if activate else "candidate"
    start = panel.calendar[ht.train_start_idx]
    end = panel.calendar[ht.train_end_idx]
    folds = ht.fold_metrics
    valid_metrics_d: dict[str, Any] = {
        "guardrail": ht.guardrail.to_json(),
        "folds": folds,
        "meta": {**meta, "horizon": h, "folds_run": len(folds)},
    }
    if recovery is not None:
        valid_metrics_d["live_recovery"] = recovery
    valid_metrics = jsonable(valid_metrics_d)
    show = bool(ht.guardrail.passed) and recovery is None
    baseline = jsonable(
        {
            "b1_brier_mean": ht.guardrail.summary.get("baseline_brier_b1_mean"),
            "b2_auc_mean": ht.guardrail.summary.get("b2_auc_mean"),
            "b3_accuracy_mean": _mean_of(folds, "b3", "accuracy"),
            "baseline_band_coverage_mean": _mean_top(folds, "baseline_band_coverage"),
        }
    )
    ids: dict[str, int] = {}
    for kind in ("dir", "range"):
        name = f"{kind}_{h}d"
        if activate:
            await conn.execute(
                "UPDATE model_run SET status = 'retired', artifact = NULL "
                "WHERE model_name = $1 AND status = 'active'",
                name,
            )
        artifact: bytes | None = None
        if activate and ht.model is not None:
            artifact = ht.model.dir_artifact() if kind == "dir" else ht.model.range_artifact()
        ids[name] = int(
            await conn.fetchval(
                "INSERT INTO model_run (model_name, train_start, train_end, n_rows, valid_metrics, "
                "baseline_metrics, guardrail_pass, artifact, status) "
                "VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9) RETURNING id",
                name,
                start,
                end,
                ht.n_rows,
                json.dumps(valid_metrics),
                json.dumps(baseline),
                show,
                artifact,
                status,
            )
        )
        if not activate:
            await conn.execute(
                "UPDATE model_run SET guardrail_pass = false, valid_metrics = "
                "jsonb_set(valid_metrics, '{superseded_by_failing_run}', to_jsonb($2::bigint)) "
                "WHERE model_name = $1 AND status = 'active' AND guardrail_pass",
                name,
                ids[name],
            )
    # traceability: a prediction references the direction run, its band came from the range run
    for mine, other in (("dir", "range"), ("range", "dir")):
        await conn.execute(
            "UPDATE model_run SET valid_metrics = "
            "jsonb_set(valid_metrics, '{meta,paired_run_id}', to_jsonb($2::bigint)) WHERE id = $1",
            ids[f"{mine}_{h}d"],
            ids[f"{other}_{h}d"],
        )
    return {
        "status": status,
        "guardrail_pass": bool(ht.guardrail.passed),
        "live_recovery": recovery is not None,
        "reason": ht.guardrail.reason,
        "model_run_ids": ids,
    }


async def _needs_recovery(conn: asyncpg.Connection, h: int) -> dict[str, Any] | None:
    """Recovery window for a new passing pair when the pair it replaces was switched off by the
    live gate (or is itself still in its recovery window)."""
    prev = await conn.fetchrow(
        "SELECT id, guardrail_pass, valid_metrics FROM model_run "
        "WHERE model_name = $1 AND status = 'active'",
        f"dir_{h}d",
    )
    if prev is None:
        return None
    vm = json.loads(prev["valid_metrics"]) if prev["valid_metrics"] else {}
    tripped = (not prev["guardrail_pass"]) and bool((vm.get("live_gate") or {}).get("tripped"))
    if not tripped and "live_recovery" not in vm:
        return None
    return {
        "required_resolved": LIVE_RECOVERY_MIN_RESOLVED,
        "required_dates": LIVE_MIN_DATES,
        "after_run": int(prev["id"]),
    }


def _mean_of(folds: Sequence[dict[str, Any]], key: str, metric: str) -> float | None:
    vals = [f[key][metric] for f in folds[-8:] if math.isfinite(f[key][metric])]
    return float(np.mean(vals)) if vals else None


def _mean_top(folds: Sequence[dict[str, Any]], key: str) -> float | None:
    vals = [f[key] for f in folds[-8:] if math.isfinite(f[key])]
    return float(np.mean(vals)) if vals else None


# --------------------------------------------------------------------------- prediction side


@dataclass(frozen=True)
class RunRef:
    dir_id: int
    range_id: int
    dir_blob: bytes | None
    range_blob: bytes | None
    state: str  # active_pass | gated | failed
    recovering: bool = False  # gated and waiting for its live recovery window


async def load_runs(pool: asyncpg.Pool, horizons: Sequence[int]) -> dict[int, RunRef]:
    """Per horizon: the active pair (``active_pass`` or ``gated`` when its guardrail is off), else
    the latest candidate pair (``failed``). Horizons with no run are absent (= ``none``)."""
    out: dict[int, RunRef] = {}
    for h in horizons:
        rows: dict[str, asyncpg.Record] = {}
        for kind in ("dir", "range"):
            row = await pool.fetchrow(
                "SELECT id, artifact, guardrail_pass, status, "
                "valid_metrics ? 'live_recovery' AS recovering FROM model_run "
                "WHERE model_name = $1 AND status IN ('active', 'candidate') "
                "ORDER BY (status = 'active') DESC, id DESC LIMIT 1",
                f"{kind}_{h}d",
            )
            if row is None:
                break
            rows[kind] = row
        if len(rows) != 2:
            continue
        d, r = rows["dir"], rows["range"]
        active = d["status"] == "active" and r["status"] == "active"
        state = (
            "failed"
            if not active
            else ("active_pass" if d["guardrail_pass"] and r["guardrail_pass"] else "gated")
        )
        out[h] = RunRef(
            int(d["id"]),
            int(r["id"]),
            bytes(d["artifact"]) if d["artifact"] is not None else None,
            bytes(r["artifact"]) if r["artifact"] is not None else None,
            state,
            bool(d["recovering"]),
        )
    return out


async def insert_predictions(
    pool: asyncpg.Pool, rows: Sequence[PredRow], runs: dict[int, RunRef]
) -> int:
    """``ON CONFLICT DO NOTHING``: a stored prediction is never rewritten (docs/05 10.7)."""
    n = 0
    async with pool.acquire() as conn, conn.transaction():
        for r in rows:
            run = runs.get(r.horizon)
            if run is None:
                continue
            res = await conn.execute(
                "INSERT INTO prediction (instrument_id, as_of, horizon_days, model_run_id, p_up, "
                "ret_q10, ret_q50, ret_q90, ref_close, shown, hidden_reason) "
                "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) "
                "ON CONFLICT (instrument_id, as_of, horizon_days, model_run_id) DO NOTHING",
                r.instrument_id,
                r.as_of,
                r.horizon,
                run.dir_id,
                r.p_up,
                r.ret_q10,
                r.ret_q50,
                r.ret_q90,
                r.ref_close,
                r.shown,
                r.hidden_reason,
            )
            n += 1 if res.endswith(" 1") else 0
    return n


async def resolve_outcomes(pool: asyncpg.Pool, holidays: frozenset[date] | None = None) -> int:
    """Create ``prediction_outcome`` rows whose horizon bars now exist (docs/05 10.7). The horizon
    is exactly ``h`` trading days (weekdays minus ``holidays``, D07-19): when the stock has no bar
    on that day, or the ``as_of`` bar no longer exists or is not a trading day, the prediction
    stays pending. The return is recomputed from today's ``adj_close`` of both bars so a later
    confirmed split does not distort it."""
    hol = holidays if holidays is not None else await load_holidays(pool)
    pending = await pool.fetch(
        "SELECT p.id, p.instrument_id, p.as_of, p.horizon_days, p.p_up, p.ret_q10, p.ret_q90 "
        "FROM prediction p LEFT JOIN prediction_outcome o ON o.prediction_id = p.id "
        "WHERE o.prediction_id IS NULL ORDER BY p.instrument_id, p.as_of"
    )
    made = 0
    by_inst: dict[int, list[asyncpg.Record]] = {}
    for p in pending:
        by_inst.setdefault(int(p["instrument_id"]), []).append(p)
    for iid, preds in by_inst.items():
        bars = await pool.fetch(
            "SELECT trade_date, adj_close FROM price_daily "
            "WHERE instrument_id = $1 AND NOT suspect AND trade_date >= $2 ORDER BY trade_date",
            iid,
            min(p["as_of"] for p in preds),
        )
        if not bars:
            continue
        close = {b["trade_date"]: float(b["adj_close"]) for b in bars}
        tdays = trading_days(min(p["as_of"] for p in preds), bars[-1]["trade_date"], hol)
        tpos = {d: i for i, d in enumerate(tdays)}
        for p in preds:
            i = tpos.get(p["as_of"])
            h = int(p["horizon_days"])
            if i is None or p["as_of"] not in close or i + h >= len(tdays):
                continue
            end = tdays[i + h]
            if end not in close:
                continue
            out = dp.resolve_outcome(
                ref_close=close[p["as_of"]],
                later_close=close[end],
                p_up=None if p["p_up"] is None else float(p["p_up"]),
                q10=None if p["ret_q10"] is None else float(p["ret_q10"]),
                q90=None if p["ret_q90"] is None else float(p["ret_q90"]),
            )
            res = await pool.execute(
                "INSERT INTO prediction_outcome (prediction_id, resolved_on, realized_return, "
                "direction_correct, in_band) VALUES ($1, $2, $3, $4, $5) "
                "ON CONFLICT (prediction_id) DO NOTHING",
                int(p["id"]),
                end,
                out.realized_return,
                out.direction_correct,
                out.in_band,
            )
            made += 1 if res.endswith(" 1") else 0
    return made


async def live_records(pool: asyncpg.Pool, model_run_id: int, horizon: int) -> list[LiveRecord]:
    rows = await pool.fetch(
        "SELECT p.p_up, p.as_of, o.realized_return, o.in_band FROM prediction p "
        "JOIN prediction_outcome o ON o.prediction_id = p.id "
        "WHERE p.model_run_id = $1 AND p.horizon_days = $2 "
        "AND p.p_up IS NOT NULL AND o.in_band IS NOT NULL",
        model_run_id,
        horizon,
    )
    return [
        LiveRecord(float(r["p_up"]), float(r["realized_return"]), bool(r["in_band"]), r["as_of"])
        for r in rows
    ]


async def apply_live_gate(pool: asyncpg.Pool, horizon: int, run: RunRef) -> LiveGate | None:
    """docs/05 10.5 live gate.

    * An active, passing horizon: a trip sets ``guardrail_pass = false`` on both runs and stores
      the numbers in ``valid_metrics.live_gate``.
    * A run in its recovery window (a passing run that followed a live trip, ``gated`` with
      ``valid_metrics.live_recovery``): once ``LIVE_RECOVERY_MIN_RESOLVED`` resolved predictions on
      enough dates exist and the gate does not trip, ``guardrail_pass`` is set back to true. A
      trip during recovery keeps it off. A newer passing run alone never re-shows a tripped
      horizon (D07-7, D07-18).
    """
    if run.state == "active_pass":
        gate = live_gate(await live_records(pool, run.dir_id, horizon))
        if gate.tripped:
            await _store_gate(pool, run, gate, passing=False)
        return gate
    if run.state == "gated" and run.recovering:
        gate = live_gate(
            await live_records(pool, run.dir_id, horizon),
            min_resolved=LIVE_RECOVERY_MIN_RESOLVED,
        )
        if gate.tripped:
            await _store_gate(pool, run, gate, passing=False)
        elif not gate.insufficient:
            await pool.execute(
                "UPDATE model_run SET guardrail_pass = true, "
                "valid_metrics = jsonb_set(valid_metrics - 'live_recovery', "
                "'{live_recovered}', $2::jsonb) WHERE id = ANY($1)",
                [run.dir_id, run.range_id],
                json.dumps(jsonable(gate.__dict__)),
            )
        return gate
    return None


async def _store_gate(pool: asyncpg.Pool, run: RunRef, gate: LiveGate, *, passing: bool) -> None:
    await pool.execute(
        "UPDATE model_run SET guardrail_pass = $3, "
        "valid_metrics = jsonb_set(valid_metrics, '{live_gate}', $2::jsonb) WHERE id = ANY($1)",
        [run.dir_id, run.range_id],
        json.dumps(jsonable(gate.__dict__)),
        passing,
    )
