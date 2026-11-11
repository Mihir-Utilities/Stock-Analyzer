"""D07 against Postgres: ML-04 (insufficient universe writes nothing), activation rule (ML-19,
ML-25), prediction storage (never rewritten), outcome resolution (docs/05 10.7, ML-29), ML-07 and
ML-26 live gate and recovery, ML-09 no partial activation, ML-24 predict below the universe
minimum, ML-28 no run without a model."""

from __future__ import annotations

import dataclasses
import functools
import json
from datetime import date, timedelta

import asyncpg
import numpy as np
import pytest
from mlgen import make_panel_inputs, weekdays

from worker.ml import store
from worker.ml.features import build_panel
from worker.ml.guardrail import GuardrailParams, GuardrailResult
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


@functools.cache
def _fast(phi: float) -> tuple[TrainOutput, object]:
    stocks, market = make_panel_inputs(n_stocks=20, n_days=1400, seed=2, phi=phi)
    panel = build_panel(stocks, market)
    return train_all(panel, tp=TP, gp=GP, horizons=(5, 21)), panel


def fast_output(phi: float, *, passed: bool | None = None) -> tuple[TrainOutput, object]:
    """A real (cached) training output; ``passed`` forces the guardrail verdict of every horizon
    so the activation tests do not depend on how a tiny model happens to score."""
    out, panel = _fast(phi)
    if passed is None:
        return out, panel
    horizons = [
        dataclasses.replace(
            ht,
            guardrail=GuardrailResult(
                passed, ht.guardrail.checks, None if passed else "auc_mean", ht.guardrail.summary
            ),
        )
        for ht in out.horizons
    ]
    return dataclasses.replace(out, horizons=horizons), panel


async def save(pool: asyncpg.Pool, *, passed: bool) -> dict[str, object]:
    out, panel = fast_output(0.5, passed=passed)
    return await store.save_training(pool, out, panel)  # type: ignore[arg-type]


async def runs_of(pool: asyncpg.Pool, name: str) -> list[asyncpg.Record]:
    return await pool.fetch(
        "SELECT id, status, guardrail_pass, artifact, valid_metrics FROM model_run "
        "WHERE model_name = $1 ORDER BY id",
        name,
    )


async def vm_of(pool: asyncpg.Pool, run_id: int) -> dict[str, object]:
    raw = await pool.fetchval("SELECT valid_metrics FROM model_run WHERE id = $1", run_id)
    return dict(json.loads(raw))


# ML-19
async def test_activation_rule_and_artifacts(pg_full: asyncpg.Pool) -> None:
    first = await save(pg_full, passed=True)
    names = {r["model_name"] for r in await pg_full.fetch("SELECT model_name FROM model_run")}
    assert names == {"dir_5d", "range_5d", "dir_21d", "range_21d"}
    for h in ("5d", "21d"):
        assert first[h]["status"] == "active" and first[h]["guardrail_pass"]  # type: ignore[index]
        rows = await runs_of(pg_full, f"dir_{h}")
        assert len(rows) == 1 and rows[0]["status"] == "active" and rows[0]["artifact"] is not None
        meta = json.loads(rows[0]["valid_metrics"])["meta"]
        assert meta["seed"] == 42 and "feature_hash" in meta and "versions" in meta
        (rng_run,) = await runs_of(pg_full, f"range_{h}")  # D07-7: the pair is traceable
        assert meta["paired_run_id"] == rng_run["id"]
        assert json.loads(rng_run["valid_metrics"])["meta"]["paired_run_id"] == rows[0]["id"]
        base = await pg_full.fetchval(
            "SELECT baseline_metrics FROM model_run WHERE id = $1", rows[0]["id"]
        )
        assert "b1_brier_mean" in json.loads(base)
    # a newer passing run replaces the pair: one active, the old one retired without artifact
    await save(pg_full, passed=True)
    for name in ("dir_5d", "range_5d", "dir_21d", "range_21d"):
        rows = await runs_of(pg_full, name)
        assert [r["status"] for r in rows] == ["retired", "active"]
        assert rows[0]["artifact"] is None and rows[1]["artifact"] is not None


# ML-25: a newer FAILING run switches the older active pair off; a later passing run replaces it
async def test_ml25_a_newer_failing_run_sets_guardrail_pass_false_on_the_active_pair(
    pg_full: asyncpg.Pool,
) -> None:
    await save(pg_full, passed=True)
    assert (await store.load_runs(pg_full, (5, 21)))[5].state == "active_pass"
    summary = await save(pg_full, passed=False)
    assert summary["5d"]["status"] == "candidate"  # type: ignore[index]
    assert not summary["5d"]["guardrail_pass"]  # type: ignore[index]
    for name in ("dir_5d", "range_5d", "dir_21d", "range_21d"):
        old, new = await runs_of(pg_full, name)
        assert old["status"] == "active" and old["artifact"] is not None
        assert old["guardrail_pass"] is False  # hidden although still tracked
        assert json.loads(old["valid_metrics"])["superseded_by_failing_run"] == new["id"]
        assert new["status"] == "candidate" and new["artifact"] is None
    states = await store.load_runs(pg_full, (5, 21))
    assert states[5].state == "gated" and not states[5].recovering  # no live trip: no probation
    # a later passing run replaces the gated pair and is shown at once (no live trip happened)
    await save(pg_full, passed=True)
    after = (await store.load_runs(pg_full, (5, 21)))[5]
    assert after.state == "active_pass" and after.dir_id > states[5].dir_id


# ML-28: a horizon without a model (too few folds) is never written as a candidate run
async def test_ml28_insufficient_folds_write_no_run_and_no_predictions(
    pg_full: asyncpg.Pool,
) -> None:
    stocks, market = make_panel_inputs(n_stocks=20, n_days=500, seed=3)
    panel = build_panel(stocks, market)
    out = train_all(panel, tp=TP, gp=GP, horizons=(5, 21))
    assert out.status == "insufficient_history" and all(h.model is None for h in out.horizons)
    summary = await store.save_training(pg_full, out, panel)
    assert summary == {
        "5d": {"status": "no_model", "reason": "insufficient_folds"},
        "21d": {"status": "no_model", "reason": "insufficient_folds"},
    }
    assert await pg_full.fetchval("SELECT count(*) FROM model_run") == 0
    assert await store.load_runs(pg_full, (5, 21)) == {}  # the API reports no_model
    # a daily predict never writes hidden rows for a horizon that has no run
    await seed_stocks(pg_full, 20, 800)
    p = ctx()
    await run_predict(pg_full, p, today=date(2030, 1, 1))
    assert p.extra["status"] == "no_model"
    assert await pg_full.fetchval("SELECT count(*) FROM prediction") == 0


async def test_run_train_counts_rows_only_for_horizons_with_a_model(
    pg_full: asyncpg.Pool,
) -> None:
    await seed_stocks(pg_full, 20, 800)  # eligible (750+ bars) but far fewer than 12 folds
    c = ctx()
    await run_train(pg_full, c, tp=TP, gp=GP)
    assert c.extra["status"] == "insufficient_history"
    assert c.rows_written == 0
    assert await pg_full.fetchval("SELECT count(*) FROM model_run") == 0


async def test_nan_metrics_are_stored_as_null_not_zero(pg_full: asyncpg.Pool) -> None:
    assert store.jsonable({"a": float("nan"), "b": [float("inf"), 1.5], "c": np.float64(2)}) == {
        "a": None,
        "b": [None, 1.5],
        "c": 2.0,
    }


async def seed_pair(pool: asyncpg.Pool) -> tuple[int, int]:
    ids = []
    for kind in ("dir", "range"):
        ids.append(
            int(
                await pool.fetchval(
                    "INSERT INTO model_run (model_name, train_start, train_end, n_rows, "
                    "valid_metrics, baseline_metrics, guardrail_pass, status) "
                    "VALUES ($1, $2, $2, 1, '{}', '{}', true, 'active') RETURNING id",
                    f"{kind}_5d",
                    date(2024, 1, 1),
                )
            )
        )
    return ids[0], ids[1]


async def seed_live(
    pool: asyncpg.Pool,
    run_id: int,
    n: int,
    *,
    p_up_good: bool,
    in_band: bool | float,
    dates: int | None = None,
    shown: bool = True,
) -> None:
    """``n`` resolved live predictions of a run (one stock each) over ``dates`` distinct as_of
    days (default: ``n`` days)."""
    start = date(2024, 1, 1)
    hit_rate = float(in_band)  # True = every row in band, 0.8 = 8 of every 10
    tag = int(await pool.fetchval("SELECT count(*) FROM instrument"))
    for i in range(n):
        up = i % 2 == 0
        day = start + timedelta(days=i % (dates or n))
        iid = int(
            await pool.fetchval(
                "INSERT INTO instrument (symbol, name) VALUES ($1, $1) RETURNING id",
                f"L{tag}_{i}",
            )
        )
        pid = int(
            await pool.fetchval(
                "INSERT INTO prediction (instrument_id, as_of, horizon_days, model_run_id, p_up, "
                "ret_q10, ret_q50, ret_q90, ref_close, shown) "
                "VALUES ($1, $2, 5, $3, $4, -0.05, 0, 0.05, 100, $5) RETURNING id",
                iid,
                day,
                run_id,
                0.6 if up == p_up_good else 0.4,
                shown,
            )
        )
        await pool.execute(
            "INSERT INTO prediction_outcome (prediction_id, resolved_on, realized_return, "
            "direction_correct, in_band) VALUES ($1, $2, $3, true, $4)",
            pid,
            day + timedelta(days=7),
            0.01 if up else -0.01,
            (i % 10) < round(hit_rate * 10),
        )


async def seed_runs_and_predictions(
    pool: asyncpg.Pool, n: int, *, p_up_good: bool, in_band: bool, dates: int | None = None
) -> tuple[int, int]:
    """One active passing horizon-5 pair and ``n`` resolved live predictions."""
    dir_id, range_id = await seed_pair(pool)
    await seed_live(pool, dir_id, n, p_up_good=p_up_good, in_band=in_band, dates=dates)
    return dir_id, range_id


async def trip(pool: asyncpg.Pool) -> int:
    """An active horizon-5 pair that the live gate has switched off; returns its dir run id."""
    old_dir, _ = await seed_runs_and_predictions(pool, 100, p_up_good=False, in_band=True)
    r0 = await store.load_runs(pool, (5,))
    gate = await store.apply_live_gate(pool, 5, r0[5])
    assert gate is not None and gate.tripped
    assert (await store.load_runs(pool, (5,)))[5].state == "gated"
    return old_dir


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
    vm = await vm_of(pg_full, runs[5].dir_id)
    assert vm["live_gate"]["tripped"] and vm["live_gate"]["distinct_dates"] == 100  # type: ignore[index]


async def test_ml07_good_live_metrics_or_too_few_keep_the_horizon_on(
    pg_full: asyncpg.Pool,
) -> None:
    await seed_runs_and_predictions(pg_full, 99, p_up_good=False, in_band=False)  # only 99
    runs = await store.load_runs(pg_full, (5,))
    gate = await store.apply_live_gate(pg_full, 5, runs[5])
    assert gate is not None and not gate.tripped and gate.resolved == 99
    assert (await store.load_runs(pg_full, (5,)))[5].state == "active_pass"


async def test_ml07_many_rows_from_few_dates_do_not_trip_the_gate(pg_full: asyncpg.Pool) -> None:
    """D07-17: 100 bad resolved rows from only 5 as_of dates are one episode, not evidence."""
    await seed_runs_and_predictions(pg_full, 100, p_up_good=False, in_band=True, dates=5)
    runs = await store.load_runs(pg_full, (5,))
    gate = await store.apply_live_gate(pg_full, 5, runs[5])
    assert gate is not None and gate.resolved == 100 and gate.distinct_dates == 5
    assert not gate.tripped and gate.insufficient
    assert (await store.load_runs(pg_full, (5,)))[5].state == "active_pass"


# ML-26: after a live trip a newer passing run is NOT enough; live metrics must recover first
async def test_ml26_after_a_live_trip_a_newer_passing_run_needs_a_live_recovery_window(
    pg_full: asyncpg.Pool,
) -> None:
    old_dir = await trip(pg_full)
    summary = await save(pg_full, passed=True)
    assert summary["5d"]["status"] == "active" and summary["5d"]["live_recovery"]  # type: ignore[index]
    assert summary["21d"]["live_recovery"] is False  # type: ignore[index]  # nothing tripped there
    rec = (await store.load_runs(pg_full, (5,)))[5]
    # the new pair is active but still gated: its guardrail passed, the live record is empty
    assert rec.dir_id > old_dir and rec.state == "gated" and rec.recovering
    new_vm = await vm_of(pg_full, rec.dir_id)
    assert new_vm["guardrail"]["passed"] is True  # type: ignore[index]
    assert new_vm["live_recovery"] == {
        "required_resolved": 100,
        "required_dates": 20,
        "after_run": old_dir,
    }
    gate = await store.apply_live_gate(pg_full, 5, rec)  # no outcomes yet
    assert gate is not None and gate.insufficient and gate.resolved == 0
    assert (await store.load_runs(pg_full, (5,)))[5].state == "gated"
    await seed_live(pg_full, rec.dir_id, 99, p_up_good=True, in_band=0.8, dates=30, shown=False)
    gate = await store.apply_live_gate(pg_full, 5, rec)
    assert gate is not None and gate.resolved == 99 and gate.insufficient
    assert (await store.load_runs(pg_full, (5,)))[5].state == "gated"
    # a newer passing run while still recovering inherits the probation (no shortcut)
    await save(pg_full, passed=True)
    again = (await store.load_runs(pg_full, (5,)))[5]
    assert again.state == "gated" and again.recovering and again.dir_id > rec.dir_id


async def test_ml26_recovery_completes_with_100_good_resolved_on_20_dates(
    pg_full: asyncpg.Pool,
) -> None:
    await trip(pg_full)
    await save(pg_full, passed=True)
    rec = (await store.load_runs(pg_full, (5,)))[5]
    await seed_live(pg_full, rec.dir_id, 100, p_up_good=True, in_band=0.8, dates=20, shown=False)
    gate = await store.apply_live_gate(pg_full, 5, rec)
    assert gate is not None and not gate.tripped and not gate.insufficient
    assert gate.distinct_dates == 20
    ok = (await store.load_runs(pg_full, (5,)))[5]
    assert ok.state == "active_pass" and not ok.recovering
    vm = await vm_of(pg_full, ok.dir_id)
    assert "live_recovery" not in vm and vm["live_recovered"]["resolved"] == 100  # type: ignore[index]


async def test_ml26_a_trip_during_recovery_keeps_the_horizon_off(pg_full: asyncpg.Pool) -> None:
    await trip(pg_full)
    await save(pg_full, passed=True)
    rec = (await store.load_runs(pg_full, (5,)))[5]
    await seed_live(pg_full, rec.dir_id, 100, p_up_good=False, in_band=True, dates=25, shown=False)
    gate = await store.apply_live_gate(pg_full, 5, rec)
    assert gate is not None and gate.tripped
    still = (await store.load_runs(pg_full, (5,)))[5]
    assert still.state == "gated" and still.recovering


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
    assert 0 < shown["p_up"] < 1 and shown["ret_q10"] <= shown["ret_q50"] <= shown["ret_q90"]
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


# ML-24: predict below the universe minimum writes nothing
async def test_ml24_predict_with_fewer_than_20_eligible_stocks_writes_nothing(
    pg_full: asyncpg.Pool,
) -> None:
    out, panel = fast_output(0.5, passed=True)
    await store.save_training(pg_full, out, panel)  # type: ignore[arg-type]  # active pairs exist
    await seed_stocks(pg_full, 19, 1400, phi=0.5)  # one short of the minimum
    c = ctx()
    await run_predict(pg_full, c, today=date(2030, 1, 1))
    assert c.extra["status"] == "insufficient_universe" and c.extra["eligible"] == 19
    assert await pg_full.fetchval("SELECT count(*) FROM prediction") == 0
    assert c.rows_written == 0


# ML-29: the outcome horizon is exactly h trading days
async def test_ml29_outcomes_use_exactly_h_trading_days_with_holidays_and_gaps(
    pg_full: asyncpg.Pool,
) -> None:
    run = (await seed_pair(pg_full))[0]
    iid = int(
        await pg_full.fetchval(
            "INSERT INTO instrument (symbol, name) VALUES ('H', 'H') RETURNING id"
        )
    )
    days = weekdays(30, start=date(2024, 3, 4))  # Mon 4 Mar 2024
    holiday = date(2024, 3, 8)  # a Friday exchange holiday inside the window
    trading = [d for d in days if d != holiday]
    missing = trading[6]  # exactly 5 trading days after trading[1] (as_of): no bar stored
    for d in trading:
        if d == missing:
            continue
        px = 100.0 + trading.index(d)
        await pg_full.execute(
            "INSERT INTO price_daily (instrument_id, trade_date, open, high, low, close, "
            "adj_close, volume, source) VALUES ($1, $2, $3, $3, $3, $3, $3, 1000, 'import')",
            iid,
            d,
            px,
        )
    await pg_full.execute(
        "INSERT INTO market_holiday (holiday_date, segment) VALUES ($1, 'trading')", holiday
    )
    as_of = trading[1]
    await pg_full.execute(
        "INSERT INTO prediction (instrument_id, as_of, horizon_days, model_run_id, p_up, ret_q10, "
        "ret_q50, ret_q90, ref_close, shown) VALUES ($1, $2, 5, $3, 0.6, -0.05, 0, 0.05, 101, true)",
        iid,
        as_of,
        run,
    )
    # the bar 5 trading days after as_of is missing (a data gap): NOT resolved from the next row
    assert await store.resolve_outcomes(pg_full) == 0
    assert await pg_full.fetchval("SELECT count(*) FROM prediction_outcome") == 0
    # the bar arrives: resolved on exactly that day, using it and the as_of bar
    await pg_full.execute(
        "INSERT INTO price_daily (instrument_id, trade_date, open, high, low, close, adj_close, "
        "volume, source) VALUES ($1, $2, 110, 110, 110, 110, 110.0, 1000, 'import')",
        iid,
        missing,
    )
    assert await store.resolve_outcomes(pg_full) == 1
    o = await pg_full.fetchrow("SELECT resolved_on, realized_return FROM prediction_outcome")
    assert o is not None and o["resolved_on"] == missing == trading[6]
    assert o["realized_return"] == pytest.approx(110.0 / 101.0 - 1.0)  # as_of close was 101
    # the 5-weekday offset differs because the holiday is skipped
    assert (missing - as_of).days == 8  # Tue 5 Mar + 8 days = Wed 13 Mar (6 weekdays, 5 trading)


# ML-09
async def test_ml09_timed_out_training_stores_nothing(pg_full: asyncpg.Pool) -> None:
    await seed_stocks(pg_full, 20, 1400)
    c = JobContext(job="train_models", deadline=0.0, clock=lambda: 1.0)  # already past
    await run_train(pg_full, c)
    assert c.timed_out and c.extra["status"] == "aborted_timeout"
    assert await pg_full.fetchval("SELECT count(*) FROM model_run") == 0


# ML-30 (DB part): predict after the queue only runs when a bar is newer than the last as_of
async def test_ml30_has_new_bar_compares_the_latest_bar_with_the_latest_prediction(
    pg_full: asyncpg.Pool,
) -> None:
    from worker.ml.jobs import has_new_bar

    assert not await has_new_bar(pg_full)  # no bars at all
    await seed_stocks(pg_full, 1, 10)
    assert await has_new_bar(pg_full)  # bars, no prediction yet
    run = (await seed_pair(pg_full))[0]
    iid = int(await pg_full.fetchval("SELECT id FROM instrument WHERE symbol = 'S00'"))
    last = await pg_full.fetchval("SELECT max(trade_date) FROM price_daily")
    await pg_full.execute(
        "INSERT INTO prediction (instrument_id, as_of, horizon_days, model_run_id, p_up, ret_q10, "
        "ret_q50, ret_q90, ref_close, shown) VALUES ($1, $2, 5, $3, 0.6, -0.05, 0, 0.05, 100, true)",
        iid,
        last,
        run,
    )
    assert not await has_new_bar(pg_full)
    await pg_full.execute(
        "INSERT INTO price_daily (instrument_id, trade_date, open, high, low, close, adj_close, "
        "volume, source) VALUES ($1, $2, 1, 1, 1, 1, 1, 1, 'import')",
        iid,
        last + timedelta(days=1),
    )
    assert await has_new_bar(pg_full)
