"""``train_models`` and ``predict`` (docs/04 3.8). Forecasts are deferred by the owner (D-4): with
fewer than 20 eligible stocks ``train_models`` records ``insufficient_universe`` and writes no
model; ``predict`` then has nothing to do and forecasts stay hidden with ``no_model``."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import asyncpg

from worker import marketdate
from worker.db import create_pool
from worker.ml import store
from worker.ml.features import HORIZONS, build_panel
from worker.ml.guardrail import GuardrailParams
from worker.ml.models import ScoringModel, TrainParams
from worker.ml.predict import build_predictions
from worker.ml.train import (
    DEFAULT_GUARDRAIL,
    DEFAULT_PARAMS,
    MIN_UNIVERSE,
    TrainingAborted,
    train_all,
)
from worker.runner import JobContext

log = logging.getLogger("worker.ml")

TRAIN_TIMEOUT_S = 90 * 60  # docs/04 section 2: train_models 90 min
PREDICT_TIMEOUT_S = 20 * 60


async def train_models_job(ctx: JobContext) -> None:
    pool = await create_pool()
    try:
        await run_train(pool, ctx)
    finally:
        await pool.close()


async def run_train(
    pool: asyncpg.Pool,
    ctx: JobContext,
    *,
    tp: TrainParams = DEFAULT_PARAMS,
    gp: GuardrailParams = DEFAULT_GUARDRAIL,
) -> None:
    loaded = await store.load_stocks(pool)
    eligible = len(loaded.universe)
    ctx.extra["eligible"] = eligible
    ctx.extra["excluded"] = loaded.excluded
    if eligible < MIN_UNIVERSE:
        ctx.extra["status"] = "insufficient_universe"
        log.info("train_models skipped: insufficient_universe (%d eligible)", eligible)
        return
    if ctx.dry_run:
        ctx.extra["status"] = "dry_run"
        return
    market = await store.load_market(pool)
    panel = build_panel(loaded.universe, market)
    try:
        out = await asyncio.to_thread(train_all, panel, tp=tp, gp=gp, should_stop=ctx.past_deadline)
    except TrainingAborted:
        ctx.timed_out = True
        ctx.extra["status"] = "aborted_timeout"  # nothing is stored: no partial activation (ML-09)
        return
    ctx.extra["status"] = out.status
    ctx.extra["models"] = await store.save_training(pool, out, panel)
    ctx.add_rows(len(out.horizons) * 2)


async def predict_job(ctx: JobContext) -> None:
    pool = await create_pool()
    try:
        await run_predict(pool, ctx)
    finally:
        await pool.close()


async def has_models(pool: asyncpg.Pool) -> bool:
    return bool(
        await pool.fetchval("SELECT EXISTS (SELECT 1 FROM model_run WHERE status = 'active')")
    )


async def run_predict(pool: asyncpg.Pool, ctx: JobContext, *, today: Any = None) -> None:
    """Resolve finished horizons, apply the live gate, then store today's predictions."""
    if ctx.dry_run:
        ctx.extra["status"] = "dry_run"
        return
    ctx.extra["outcomes_resolved"] = await store.resolve_outcomes(pool)
    runs = await store.load_runs(pool, HORIZONS)
    gates: dict[str, Any] = {}
    for h, run in runs.items():
        gate = await store.apply_live_gate(pool, h, run)
        if gate is not None:
            gates[f"{h}d"] = store.jsonable(gate.__dict__)
    ctx.extra["live_gate"] = gates
    runs = await store.load_runs(pool, HORIZONS)  # states may have changed
    if not runs:
        ctx.extra["status"] = "no_model"
        return
    loaded = await store.load_stocks(pool)
    market = await store.load_market(pool)
    models: dict[int, ScoringModel | None] = {}
    for h, run in runs.items():
        usable = run.state in ("active_pass", "gated")
        models[h] = (
            ScoringModel.load(run.dir_blob, run.range_blob)
            if usable and run.dir_blob is not None and run.range_blob is not None
            else None
        )
    panel = build_panel(loaded.universe, market)
    rows = build_predictions(
        panel,
        loaded.infos,
        models,
        {h: r.state for h, r in runs.items()},
        today=today or marketdate.ist_today(),
        holidays=await store.load_holidays(pool),
    )
    written = await store.insert_predictions(pool, rows, runs)
    ctx.add_rows(written)
    ctx.extra["status"] = "ok"
    ctx.extra["predictions"] = {"built": len(rows), "written": written}
