"""D07 against Postgres: ML-04 (insufficient universe writes nothing), activation rule, prediction
storage (never rewritten), outcome resolution (docs/05 10.7), ML-07 live gate, ML-09 no partial
activation, ML-06 through the DB path."""

from __future__ import annotations

import json
from datetime import date, timedelta

import asyncpg
import numpy as np
import pytest
from mlgen import make_panel_inputs, weekdays

from worker.ml import store
from worker.ml.features import build_panel
from worker.ml.guardrail import GuardrailParams
from worker.ml.jobs import run_predict, run_train
from worker.ml.models import TrainParams
from worker.ml.train import TrainOutput, train_all
from worker.runner import JobContext

pytestmark = [pytest.mark.anyio, pytest.mark.integration]

TP = TrainParams(
    num_rounds=20,
    early_stopping_rounds=5,
    min_data_in_leaf=40,
    init_months=18,
    fold_months=3,
    inner_dates=21,
)
GP = GuardrailParams(bootstrap_resamples=100)


async def seed_stocks(pool: asyncpg.Pool, n_stocks: int, n_days: int, *, phi: float = 0.0) -> None:
    stocks, _ = make_panel_inputs(n_stocks=n_stocks, n_days=n_days, seed=2, phi=phi)
    for s in stocks:
        iid = int(
            await pool.fetchval(
                "INSERT INTO instrument (symbol, name, is_tracked) VALUES ($1, $1, true) "
                "RETURNING id",
                s.symbol,
            )
        )
        b = s.bars
        await pool.executemany(
            "INSERT INTO price_daily (instrument_id, trade_date, open, high, low, close, "
            "adj_close, volume, source) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'import')",
            [
                (
                    iid,
                    d,
                    float(b.close[i]),
                    float(b.high[i]),
                    float(b.low[i]),
                    float(b.close[i]),
                    float(b.adj_close[i]),
                    int(b.volume[i]),
                )
                for i, d in enumerate(b.dates)
            ],
        )


def ctx() -> JobContext:
    return JobContext(job="t")


# ML-04
async def test_ml04_below_20_stocks_writes_nothing_and_forecasts_stay_hidden(
    pg_full: asyncpg.Pool,
) -> None:
    await seed_stocks(pg_full, 5, 800)
    c = ctx()
    await run_train(pg_full, c)
    assert c.extra["status"] == "insufficient_universe" and c.extra["eligible"] == 5
    assert await pg_full.fetchval("SELECT count(*) FROM model_run") == 0
    p = ctx()
    await run_predict(pg_full, p, today=date(2030, 1, 1))
    assert p.extra["status"] == "no_model"
    assert await pg_full.fetchval("SELECT count(*) FROM prediction") == 0


async def test_universe_needs_750_bars_and_no_unconfirmed_action(pg_full: asyncpg.Pool) -> None:
    await seed_stocks(pg_full, 3, 800)
    short = int(
        await pg_full.fetchval(
            "INSERT INTO instrument (symbol, name, is_tracked) VALUES ('SHORT', 'SHORT', true) "
            "RETURNING id"
        )
    )
    for d in weekdays(100):
        await pg_full.execute(
            "INSERT INTO price_daily (instrument_id, trade_date, open, high, low, close, "
            "adj_close, volume, source) VALUES ($1, $2, 10, 11, 9, 10, 10, 1000, 'import')",
            short,
            d,
        )
    iid = int(await pg_full.fetchval("SELECT id FROM instrument WHERE symbol = 'S00'"))
    await pg_full.execute(
        "INSERT INTO corporate_action (instrument_id, ex_date, action_type, status, source) "
        "VALUES ($1, '2019-03-01', 'split_or_bonus', 'detected', 'detected')",
        iid,
    )
    loaded = await store.load_stocks(pg_full)
    assert {s.symbol for s in loaded.universe} == {"S01", "S02"}
    assert loaded.excluded == {"S00": "near_corporate_action", "SHORT": "insufficient_history"}
    assert set(loaded.infos) == {"S00", "S01", "S02", "SHORT"}


async def test_market_series_are_none_when_absent(pg_full: asyncpg.Pool) -> None:
    m = await store.load_market(pg_full)
    assert m.nifty is None and m.vix is None
    await pg_full.execute(
        "INSERT INTO market_series (code, trade_date, value) VALUES ('NIFTY50', '2020-01-01', 12000)"
    )
    m = await store.load_market(pg_full)
    assert m.nifty == {date(2020, 1, 1): 12000.0} and m.vix is None


def fast_output(phi: float) -> tuple[TrainOutput, object]:
    stocks, market = make_panel_inputs(n_stocks=20, n_days=1400, seed=2, phi=phi)
    panel = build_panel(stocks, market)
    return train_all(panel, tp=TP, gp=GP, horizons=(5, 21)), panel


async def test_activation_rule_and_artifacts(pg_full: asyncpg.Pool) -> None:
    out, panel = fast_output(0.5)
    first = await store.save_training(pg_full, out, panel)  # type: ignore[arg-type]
    names = {r["model_name"] for r in await pg_full.fetch("SELECT model_name FROM model_run")}
    assert names == {"dir_5d", "range_5d", "dir_21d", "range_21d"}
    for h in ("5d", "21d"):
        st = first[h]["status"]
        rows = await pg_full.fetch(
            "SELECT status, artifact, guardrail_pass, valid_metrics, baseline_metrics, n_rows "
            "FROM model_run WHERE model_name = $1",
            f"dir_{h}",
        )
        assert len(rows) == 1 and rows[0]["status"] == st
        assert (rows[0]["artifact"] is not None) == (st == "active")  # candidates carry no blob
        meta = json.loads(rows[0]["valid_metrics"])["meta"]
        assert meta["seed"] == 42 and "feature_hash" in meta and "versions" in meta
        assert "b1_brier_mean" in json.loads(rows[0]["baseline_metrics"])
    # a second run of noise: failing runs never retire an active pair; passing ones replace it
    noisy, panel2 = fast_output(0.0)
    await store.save_training(pg_full, noisy, panel2)  # type: ignore[arg-type]
    for name in ("dir_5d", "dir_21d"):
        states = [
            r["status"]
            for r in await pg_full.fetch(
                "SELECT status FROM model_run WHERE model_name = $1 ORDER BY id", name
            )
        ]
        assert states.count("active") <= 1
        assert states[-1] in {"candidate", "active"}


async def test_nan_metrics_are_stored_as_null_not_zero(pg_full: asyncpg.Pool) -> None:
    assert store.jsonable({"a": float("nan"), "b": [float("inf"), 1.5], "c": np.float64(2)}) == {
        "a": None,
        "b": [None, 1.5],
        "c": 2.0,
    }


async def seed_runs_and_predictions(
    pool: asyncpg.Pool, n: int, *, p_up_good: bool, in_band: bool
) -> tuple[int, int]:
    """One active passing horizon-5 pair and ``n`` resolved live predictions."""
    start = date(2024, 1, 1)
    ids = []
    for kind in ("dir", "range"):
        ids.append(
            int(
                await pool.fetchval(
                    "INSERT INTO model_run (model_name, train_start, train_end, n_rows, "
                    "valid_metrics, baseline_metrics, guardrail_pass, status) "
                    "VALUES ($1, $2, $2, 1, '{}', '{}', true, 'active') RETURNING id",
                    f"{kind}_5d",
                    start,
                )
            )
        )
    iid = int(
        await pool.fetchval("INSERT INTO instrument (symbol, name) VALUES ('X', 'X') RETURNING id")
    )
    for i in range(n):
        up = i % 2 == 0
        pid = int(
            await pool.fetchval(
                "INSERT INTO prediction (instrument_id, as_of, horizon_days, model_run_id, p_up, "
                "ret_q10, ret_q50, ret_q90, ref_close, shown) "
                "VALUES ($1, $2, 5, $3, $4, -0.05, 0, 0.05, 100, true) RETURNING id",
                iid,
                start + timedelta(days=i),
                ids[0],
                0.6 if up == p_up_good else 0.4,
            )
        )
        await pool.execute(
            "INSERT INTO prediction_outcome (prediction_id, resolved_on, realized_return, "
            "direction_correct, in_band) VALUES ($1, $2, $3, true, $4)",
            pid,
            start + timedelta(days=i + 7),
            0.01 if up else -0.01,
            in_band,
        )
    return ids[0], ids[1]


# ML-07
async def test_ml07_bad_live_metrics_switch_the_horizon_off(pg_full: asyncpg.Pool) -> None:
    await seed_runs_and_predictions(pg_full, 100, p_up_good=False, in_band=True)
    runs = await store.load_runs(pg_full, (5,))
    assert runs[5].state == "active_pass"
    gate = await store.apply_live_gate(pg_full, 5, runs[5])
    assert gate is not None and gate.tripped and gate.reason == "live_auc"
    after = await store.load_runs(pg_full, (5,))
    assert after[5].state == "gated"  # still active for tracking, guardrail off, never shown
    assert await pg_full.fetchval("SELECT count(*) FROM model_run WHERE NOT guardrail_pass") == 2


async def test_ml07_good_live_metrics_or_too_few_keep_the_horizon_on(
    pg_full: asyncpg.Pool,
) -> None:
    await seed_runs_and_predictions(pg_full, 99, p_up_good=False, in_band=False)  # only 99
    runs = await store.load_runs(pg_full, (5,))
    gate = await store.apply_live_gate(pg_full, 5, runs[5])
    assert gate is not None and not gate.tripped and gate.resolved == 99
    assert (await store.load_runs(pg_full, (5,)))[5].state == "active_pass"


async def test_ml07_a_newer_passing_run_replaces_a_gated_one(pg_full: asyncpg.Pool) -> None:
    await seed_runs_and_predictions(pg_full, 100, p_up_good=False, in_band=True)
    runs = await store.load_runs(pg_full, (5,))
    await store.apply_live_gate(pg_full, 5, runs[5])
    out, panel = fast_output(0.5)
    await store.save_training(pg_full, out, panel)  # type: ignore[arg-type]
    state = (await store.load_runs(pg_full, (5,)))[5]
    if out.horizons[0].guardrail.passed:
        assert state.state == "active_pass" and state.dir_id > runs[5].dir_id


# predictions and outcomes
async def test_predict_stores_rows_never_rewrites_and_resolves_outcomes(
    pg_full: asyncpg.Pool,
) -> None:
    await seed_stocks(pg_full, 20, 1400, phi=0.5)
    stocks, market = make_panel_inputs(
        n_stocks=20, n_days=1400, seed=2, phi=0.5, with_market=False
    )  # the DB has no market_series rows, so the model must not use market features
    panel = build_panel(stocks, market)
    out = train_all(panel, tp=TP, gp=GP, horizons=(5,))
    ht = out.horizons[0]
    assert ht.model is not None
    # force an active pair for horizon 5 regardless of the guardrail verdict of this tiny model
    ht.guardrail = type(ht.guardrail)(True, ht.guardrail.checks, None, ht.guardrail.summary)
    await store.save_training(pg_full, out, panel)
    last = stocks[0].bars.dates[-1]
    c = ctx()
    await run_predict(pg_full, c, today=last)
    assert c.extra["status"] == "ok"
    n = int(await pg_full.fetchval("SELECT count(*) FROM prediction"))
    assert n == 20  # one row per stock for the single active horizon
    shown = await pg_full.fetchrow(
        "SELECT p_up, ret_q10, ret_q50, ret_q90, ref_close, shown, hidden_reason, as_of "
        "FROM prediction WHERE shown ORDER BY id LIMIT 1"
    )
    assert shown is not None and shown["as_of"] == last
    assert 0 <= shown["p_up"] <= 1 and shown["ret_q10"] <= shown["ret_q50"] <= shown["ret_q90"]
    before = await pg_full.fetch("SELECT id, p_up FROM prediction ORDER BY id")
    c2 = ctx()
    await run_predict(pg_full, c2, today=last)
    assert c2.extra["predictions"]["written"] == 0  # same as_of: ON CONFLICT DO NOTHING
    assert [dict(r) for r in before] == [
        dict(r) for r in await pg_full.fetch("SELECT id, p_up FROM prediction ORDER BY id")
    ]
    assert await pg_full.fetchval("SELECT count(*) FROM prediction_outcome") == 0

    # more bars arrive: 5 more days for one stock -> its prediction resolves
    iid = int(await pg_full.fetchval("SELECT id FROM instrument WHERE symbol = 'S00'"))
    ref = float(
        await pg_full.fetchval(
            "SELECT adj_close FROM price_daily WHERE instrument_id = $1 AND trade_date = $2",
            iid,
            last,
        )
    )
    d = last
    for k in range(1, 6):
        d += timedelta(days=1)
        while d.weekday() >= 5:
            d += timedelta(days=1)
        px = ref * (1 + 0.01 * k)
        await pg_full.execute(
            "INSERT INTO price_daily (instrument_id, trade_date, open, high, low, close, "
            "adj_close, volume, source) VALUES ($1, $2, $3, $3, $3, $3, $3, 1000000, 'import')",
            iid,
            d,
            px,
        )
    c3 = ctx()
    await run_predict(pg_full, c3, today=d)
    assert c3.extra["outcomes_resolved"] == 1
    o = await pg_full.fetchrow(
        "SELECT o.*, p.p_up, p.ret_q10, p.ret_q90 FROM prediction_outcome o "
        "JOIN prediction p ON p.id = o.prediction_id"
    )
    assert o is not None and o["resolved_on"] == d
    assert o["realized_return"] == pytest.approx(0.05, abs=1e-6)
    assert o["direction_correct"] == (o["p_up"] >= 0.5)
    assert o["in_band"] == (o["ret_q10"] <= o["realized_return"] <= o["ret_q90"])
    # the older prediction row is untouched by the new run
    assert await pg_full.fetchval("SELECT count(*) FROM prediction WHERE as_of = $1", last) == 20


# ML-09
async def test_ml09_timed_out_training_stores_nothing(pg_full: asyncpg.Pool) -> None:
    await seed_stocks(pg_full, 20, 1400)
    c = JobContext(job="train_models", deadline=0.0, clock=lambda: 1.0)  # already past
    await run_train(pg_full, c)
    assert c.timed_out and c.extra["status"] == "aborted_timeout"
    assert await pg_full.fetchval("SELECT count(*) FROM model_run") == 0
