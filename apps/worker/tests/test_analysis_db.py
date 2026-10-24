"""``compute_analysis`` against Postgres (RET-90 .. RET-93): idempotence, retention, stale
snapshots, warnings, screener metrics and the ``post_import`` wiring."""

from __future__ import annotations

import json
from datetime import date, timedelta
from typing import Any

import asyncpg
import numpy as np
import pytest

from worker import analysis_db, jobs
from worker.analytics.snapshot import VERSION
from worker.post_import import PgPostImportStore, SymbolProcessor, run_post_import

pytestmark = [pytest.mark.anyio, pytest.mark.integration]

START = date(2022, 1, 3)


def weekdays(n: int, start: date = START) -> list[date]:
    out: list[date] = []
    d = start
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d)
        d += timedelta(days=1)
    return out


def closes(n: int, seed: int = 1) -> np.ndarray:
    rng = np.random.default_rng(seed)
    return 100 * np.cumprod(1 + rng.normal(0.0004, 0.01, n))


async def seed(
    pool: asyncpg.Pool,
    symbol: str,
    n: int,
    *,
    suspect_at: set[int] | None = None,
    sector: str | None = None,
) -> int:
    iid = int(
        await pool.fetchval(
            "INSERT INTO instrument (symbol, name, sector, industry) VALUES ($1, $1, $2, $2) "
            "ON CONFLICT (symbol) DO UPDATE SET name = EXCLUDED.name RETURNING id",
            symbol,
            sector,
        )
    )
    await add_bars(pool, iid, n, suspect_at=suspect_at)
    return iid


async def add_bars(
    pool: asyncpg.Pool, iid: int, n: int, *, suspect_at: set[int] | None = None
) -> None:
    c, days = closes(n), weekdays(n)
    suspect_at = suspect_at or set()
    await pool.executemany(
        "INSERT INTO price_daily (instrument_id, trade_date, open, high, low, close, adj_close, "
        "volume, source, suspect) VALUES ($1, $2, $3, $4, $5, $3, $3, $6, 'import', $7) "
        "ON CONFLICT (instrument_id, trade_date) DO NOTHING",
        [
            (
                iid,
                days[i],
                float(c[i]),
                float(c[i] * 1.01),
                float(c[i] * 0.99),
                500_000 + i,
                i in suspect_at,
            )
            for i in range(n)
        ],
    )


async def snapshot_rows(pool: asyncpg.Pool, iid: int) -> list[asyncpg.Record]:
    return await pool.fetch(
        "SELECT as_of, indicators, scores, version FROM analysis_snapshot "
        "WHERE instrument_id = $1 ORDER BY as_of",
        iid,
    )


def doc(raw: Any) -> dict[str, Any]:
    out = json.loads(raw) if isinstance(raw, str) else raw
    assert isinstance(out, dict)
    return out


async def test_ret90_snapshot_written_idempotent_and_scores_left_for_d05b(
    pg_full: asyncpg.Pool,
) -> None:
    iid = await seed(pg_full, "AAA", 120)
    first = await analysis_db.compute_analysis(pg_full, "AAA")
    assert first["status"] == "ok" and first["bars"] == 120
    rows = await snapshot_rows(pg_full, iid)
    assert len(rows) == 1 and rows[0]["version"] == VERSION
    assert rows[0]["as_of"] == weekdays(120)[-1]
    assert doc(rows[0]["scores"]) == {}
    # D05b may have stored scores for this as_of: a re-run must not wipe them
    await pg_full.execute(
        'UPDATE analysis_snapshot SET scores = \'{"trend": {"score": 70}}\'::jsonb '
        "WHERE instrument_id = $1",
        iid,
    )
    await analysis_db.compute_analysis(pg_full, "AAA")
    again = await snapshot_rows(pg_full, iid)
    assert len(again) == 1 and doc(again[0]["indicators"]) == doc(rows[0]["indicators"])
    assert doc(again[0]["scores"]) == {"trend": {"score": 70}}


# RET-96: the snapshot writer refuses NaN/Infinity instead of storing it in jsonb
async def test_ret96_snapshot_writer_refuses_nan(
    pg_full: asyncpg.Pool, monkeypatch: pytest.MonkeyPatch
) -> None:
    iid = await seed(pg_full, "NAN", 120)
    real = analysis_db.build_snapshot

    def poisoned(*a: Any, **k: Any) -> dict[str, Any] | None:
        snap = real(*a, **k)
        assert snap is not None
        snap["last_close"] = float("nan")
        return snap

    monkeypatch.setattr(analysis_db, "build_snapshot", poisoned)
    with pytest.raises(ValueError):
        await analysis_db.compute_analysis(pg_full, "NAN")
    assert await snapshot_rows(pg_full, iid) == []


async def test_ret90_keeps_latest_30_and_only_the_newest_has_series(pg_full: asyncpg.Pool) -> None:
    iid = await seed(pg_full, "BBB", 60)
    for n in range(60, 95):  # 35 successive as_of dates
        await add_bars(pg_full, iid, n + 1)
        await analysis_db.compute_analysis(pg_full, "BBB")
    rows = await snapshot_rows(pg_full, iid)
    assert len(rows) == 30
    assert rows[-1]["as_of"] == weekdays(95)[-1]
    newest = doc(rows[-1]["indicators"])
    assert "series" in newest and "analysis" in newest
    for r in rows[:-1]:
        old = doc(r["indicators"])
        assert "series" not in old and "analysis" not in old
        assert old["technicals"]["rsi14"] is not None  # scalars survive for history


async def test_ret90_stale_snapshots_do_not_survive_a_trim_or_delete(pg_full: asyncpg.Pool) -> None:
    iid = await seed(pg_full, "CCC", 100, sector="Banks")
    await analysis_db.compute_analysis(pg_full, "CCC")
    await analysis_db.recompute_screener(pg_full, ["CCC"])
    days = weekdays(100)
    # the owner deletes the 10 newest bars: the snapshot of the old last bar must go
    await pg_full.execute(
        "DELETE FROM price_daily WHERE instrument_id = $1 AND trade_date > $2", iid, days[89]
    )
    await analysis_db.compute_analysis(pg_full, "CCC")
    rows = await snapshot_rows(pg_full, iid)
    assert [r["as_of"] for r in rows] == [days[89]]
    # trimmed below 60 bars: nothing left to analyse, price metrics leave the screener row
    await pg_full.execute(
        "DELETE FROM price_daily WHERE instrument_id = $1 AND trade_date < $2", iid, days[50]
    )
    res = await analysis_db.compute_analysis(pg_full, "CCC")
    assert res["status"] == "insufficient_bars"
    assert await snapshot_rows(pg_full, iid) == []
    metrics = doc(
        await pg_full.fetchval("SELECT metrics FROM screener_row WHERE instrument_id=$1", iid)
    )
    assert "rsi14" not in metrics and "price" not in metrics and metrics["sector"] == "Banks"
    assert (await analysis_db.compute_analysis(pg_full, "NOPE"))["status"] == "unknown_symbol"


async def test_ind92_suspect_bars_are_excluded_before_anything_else(pg_full: asyncpg.Pool) -> None:
    iid = await seed(pg_full, "DDD", 65, suspect_at={3, 4, 5, 6, 7, 8})  # 59 valid bars
    assert (await analysis_db.compute_analysis(pg_full, "DDD"))["status"] == "insufficient_bars"
    await seed(pg_full, "EEE", 70, suspect_at={64, 69})
    await analysis_db.compute_analysis(pg_full, "EEE")
    eid = int(await pg_full.fetchval("SELECT id FROM instrument WHERE symbol = 'EEE'"))
    snap = doc((await snapshot_rows(pg_full, eid))[0]["indicators"])
    assert snap["bars"] == 68  # the two suspect rows are gone, nothing was forward-filled
    assert snap["as_of"] == weekdays(70)[68].isoformat()
    assert iid != eid


async def test_ret91_warnings_come_from_actions_db_stock_warnings(pg_full: asyncpg.Pool) -> None:
    iid = await seed(pg_full, "FFF", 100)
    await analysis_db.compute_analysis(pg_full, "FFF")
    assert doc((await snapshot_rows(pg_full, iid))[0]["indicators"])["warnings"] == []
    await pg_full.execute(
        "INSERT INTO corporate_action (instrument_id, ex_date, action_type, status, ratio_num, "
        "ratio_den, source) VALUES ($1, $2, 'split', 'detected', 1, 2, 'detected')",
        iid,
        weekdays(100)[50],
    )
    await analysis_db.compute_analysis(pg_full, "FFF")
    snap = doc((await snapshot_rows(pg_full, iid))[0]["indicators"])
    assert "UNCONFIRMED_ACTION" in snap["warnings"]


async def test_benchmark_and_risk_free_rate_come_from_the_database(pg_full: asyncpg.Pool) -> None:
    n = 900  # about 3.4 years: enough for the 3Y window and Sharpe-like
    iid = await seed(pg_full, "GGG", n)
    rng = np.random.default_rng(8)
    idx = 20000 * np.cumprod(1 + rng.normal(0.0004, 0.009, n))
    await pg_full.executemany(
        "INSERT INTO market_series (code, trade_date, value) VALUES ('NIFTY50', $1, $2)",
        [(d, float(v)) for d, v in zip(weekdays(n), idx, strict=True)],
    )
    await analysis_db.compute_analysis(pg_full, "GGG")
    risk = doc((await snapshot_rows(pg_full, iid))[0]["indicators"])["returns"]["risk"]
    assert risk["beta_252"] is not None and risk["risk_free_rate"] == 0.065
    s_default = risk["sharpe_3y"]
    assert s_default is not None and risk["vol_3y"] is not None
    await pg_full.execute(
        "INSERT INTO app_setting (key, value) VALUES ('RISK_FREE_RATE', '0.05'::jsonb)"
    )
    await analysis_db.compute_analysis(pg_full, "GGG")
    risk2 = doc((await snapshot_rows(pg_full, iid))[0]["indicators"])["returns"]["risk"]
    assert risk2["risk_free_rate"] == 0.05
    # (cagr - rf) / vol: lowering rf by 0.015 raises the ratio by 0.015 / vol_3y(as a fraction)
    assert risk2["sharpe_3y"] - s_default == pytest.approx(0.015 / (risk["vol_3y"] / 100), rel=1e-9)


async def test_ret92_screener_row_price_metrics_keep_foreign_keys(pg_full: asyncpg.Pool) -> None:
    iid = await seed(pg_full, "HHH", 300, sector="IT")
    await pg_full.execute(
        "INSERT INTO screener_row (instrument_id, as_of, metrics) VALUES ($1, $2, $3::jsonb)",
        iid,
        date(2020, 1, 1),
        json.dumps({"roe": 18.5, "rsi14": 1.0, "ret_1y": 999.0}),  # roe is D05b's; rest is stale
    )
    await analysis_db.compute_analysis(pg_full, "HHH")
    assert await analysis_db.recompute_screener(pg_full, ["HHH", "NOPE"]) == 1
    row = await pg_full.fetchrow(
        "SELECT as_of, metrics FROM screener_row WHERE instrument_id=$1", iid
    )
    assert row is not None
    m = doc(row["metrics"])
    snap = doc((await snapshot_rows(pg_full, iid))[0]["indicators"])
    assert row["as_of"] == weekdays(300)[-1]
    assert m["roe"] == 18.5  # fundamentals untouched
    assert m["rsi14"] == snap["technicals"]["rsi14"] != 1.0  # stale value replaced
    assert m["price"] == snap["last_close"] and m["sector"] == "IT" and m["industry"] == "IT"
    assert m["ret_1y"] == snap["returns"]["calendar"]["ret_1y"]
    assert set(m) <= {
        "roe",
        "price",
        "rsi14",
        "dist_52w_high_pct",
        "ret_1m",
        "ret_6m",
        "ret_1y",
        "sector",
        "industry",
    }  # only whitelisted screener keys (docs/03 section 9)


async def test_ret93_post_import_runs_analysis_then_screener_and_is_resumable(
    pg_full: asyncpg.Pool,
) -> None:
    symbols = ["AAA", "BBB", "CCC"]
    for s in symbols:
        await seed(pg_full, s, 100)
    job_id = await pg_full.fetchval(
        "INSERT INTO refresh_job (kind, target, status, result) "
        "VALUES ('post_import', 'batch:1', 'running', $1::jsonb) RETURNING id",
        json.dumps({"remaining": symbols, "symbols_total": 3, "symbols_done": 0}),
    )
    hooks = analysis_db.production_hooks(pg_full)
    step = SymbolProcessor(pg_full, hooks=hooks)
    store = PgPostImportStore(pg_full)
    started: list[str] = []

    async def counting(symbol: str) -> dict[str, Any]:
        started.append(symbol)
        return await step(symbol)

    res = await run_post_import(
        store,
        job_id=job_id,
        target="batch:1",
        step=counting,
        should_stop=lambda: len(started) >= 2,  # 3.5-minute stop, simulated
        hooks=hooks,
    )
    assert res.status == "partial"
    assert await pg_full.fetchval("SELECT count(*) FROM analysis_snapshot") == 2
    assert await pg_full.fetchval("SELECT count(*) FROM screener_row") == 0  # only after the last
    cont = await pg_full.fetchrow("SELECT id FROM refresh_job WHERE status = 'queued'")
    assert cont is not None
    assert await store.claim(cont["id"])
    res2 = await run_post_import(
        store,
        job_id=cont["id"],
        target="batch:1",
        step=step,
        should_stop=lambda: False,
        hooks=hooks,
    )
    assert res2.status == "ok" and res2.result["failed"] == []
    assert await pg_full.fetchval("SELECT count(*) FROM analysis_snapshot") == 3
    assert await pg_full.fetchval("SELECT count(*) FROM screener_row") == 3
    # re-running a symbol never duplicates snapshots
    await step("AAA")
    assert await pg_full.fetchval("SELECT count(*) FROM analysis_snapshot") == 3


async def test_compute_analysis_cli_job_is_registered() -> None:
    from worker import job_defs  # noqa: F401  (registers on import)

    spec = jobs.CLI_JOBS["compute_analysis"]
    assert spec.name == "compute_analysis" and spec.timeout_s > 0
