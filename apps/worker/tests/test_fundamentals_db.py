"""D05b against Postgres: ``compute_analysis`` writes the B05-4 fundamentals tree, scores and the
fundamental ``screener_row`` keys (FND-81.., SCO-81..); the risk pass; ``post_import`` wiring."""

from __future__ import annotations

import json
from datetime import UTC, date, datetime, timedelta
from typing import Any

import asyncpg
import numpy as np
import pytest
from test_analysis_db import doc, seed, snapshot_rows, weekdays
from test_fundamentals import democo

from worker import analysis_db
from worker.analytics.fundamentals import FUNDAMENTAL_SCREENER_KEYS, FundRow
from worker.post_import import SymbolProcessor

pytestmark = [pytest.mark.anyio, pytest.mark.integration]

ap = pytest.approx
NOW = datetime(2026, 11, 9, 8, 0, tzinfo=UTC)
FETCHED = datetime(2022, 6, 20, 9, 0, tzinfo=UTC)
WHITELIST = {
    "market_cap_cr", "price", "pe", "pb", "ev_ebitda", "div_yield", "roe", "roce", "debt_equity",
    "interest_coverage", "op_margin", "net_margin", "rev_growth_1y", "rev_growth_3y",
    "rev_growth_5y", "profit_growth_1y", "profit_growth_3y", "profit_growth_5y", "cfo_to_pat",
    "promoter_pct", "promoter_pledged_pct", "fii_pct", "dii_pct", "mf_pct", "fii_change_qoq",
    "mf_change_qoq", "rsi14", "dist_52w_high_pct", "ret_1m", "ret_6m", "ret_1y", "quality_score",
    "trend_score", "risk_score", "sector", "industry",
}  # fmt: skip


def shifted(rows: list[FundRow], years: int) -> list[FundRow]:
    """DEMOCO moved back in time so its periods precede the seeded price bars (2022)."""
    out = []
    for r in rows:
        end = r.period_end.replace(year=r.period_end.year - years)
        out.append(
            FundRow(r.basis, r.period_type, end, r.key, r.value, r.unit, r.source, None, FETCHED)
        )
    return out


async def insert_rows(pool: asyncpg.Pool, iid: int, rows: list[FundRow]) -> None:
    await pool.executemany(
        "INSERT INTO fundamental_value (instrument_id, basis, period_type, period_end, metric_key, "
        "value, unit, source, filed_on, fetched_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) "
        "ON CONFLICT DO NOTHING",
        [
            (iid, r.basis, r.period_type, r.period_end, r.key, r.value, r.unit, r.source,
             r.filed_on, r.fetched_at)
            for r in rows
        ],
    )  # fmt: skip


async def last_close(pool: asyncpg.Pool, iid: int) -> float:
    return float(
        await pool.fetchval(
            "SELECT close FROM price_daily WHERE instrument_id = $1 ORDER BY trade_date DESC LIMIT 1",
            iid,
        )
    )


async def screener(pool: asyncpg.Pool, iid: int) -> dict[str, Any]:
    symbol = await pool.fetchval("SELECT symbol FROM instrument WHERE id = $1", iid)
    await analysis_db.recompute_screener(pool, [symbol])
    return doc(
        await pool.fetchval("SELECT metrics FROM screener_row WHERE instrument_id = $1", iid)
    )


async def test_fnd_db_writes_the_b05_4_tree_scores_and_screener_keys(pg_full: asyncpg.Pool) -> None:
    iid = await seed(pg_full, "AAA", 120, sector="IT")
    await insert_rows(pg_full, iid, shifted(democo(), 4))
    out = await analysis_db.compute_analysis(pg_full, "AAA", now=NOW)
    assert out["status"] == "ok"
    row = (await snapshot_rows(pg_full, iid))[0]
    ind, scores = doc(row["indicators"]), doc(row["scores"])
    node = ind["fundamentals"]["consolidated"]["A"]  # B05-4: {basis: {Q|A: {...}}}
    assert node["periods"] == ["2019-03-31", "2020-03-31", "2021-03-31", "2022-03-31"]
    assert all(len(v) == 4 for v in node["derived"].values())
    assert node["derived"]["revenue_yoy"][-1] == ap(9.090909, abs=1e-6)
    assert node["ratios"]["roe"] == ap(33.658537, abs=1e-6)
    assert all(
        not isinstance(v, str) for v in node["ratios"].values()
    )  # the Go reader needs numbers
    px = await last_close(pg_full, iid)
    val = node["valuation"]
    assert val["pe_basis"] == "ttm" and val["pe_ttm"] == ap(px / 32.3, rel=1e-9)
    assert ind["fundamentals"]["consolidated"]["Q"]["ratios"] == node["ratios"]
    meta = ind["fundamentals_meta"]
    assert meta["computed_at"] == NOW.isoformat()
    assert meta["inputs_fetched_at"] == FETCHED.isoformat()
    assert meta["reason"] is None and meta["auto_basis"] == "consolidated"
    # scores: trend needs 200 bars; quality has 70 weight available (no CFO history, no holdings)
    assert scores["trend"]["reason"] == "insufficient_history"
    q = scores["quality"]
    assert q["coverage"] == ap(0.7) and q["score"] == ap(83.689001, abs=1e-5)
    # screener row: whitelisted keys only, unknown ones absent, scores copied
    s = await screener(pg_full, iid)
    assert set(s) <= WHITELIST
    assert s["pe"] == ap(px / 32.3, rel=1e-9) and s["roe"] == ap(33.658537, abs=1e-6)
    assert s["quality_score"] == ap(83.689001, abs=1e-5) and "trend_score" not in s
    assert s["sector"] == "IT" and "div_yield" not in s and "rev_growth_5y" not in s
    assert set(s) & set(FUNDAMENTAL_SCREENER_KEYS) >= {"pe", "pb", "roe", "market_cap_cr"}


async def test_fnd_db_recompute_picks_up_new_entries_and_is_idempotent(
    pg_full: asyncpg.Pool,
) -> None:
    iid = await seed(pg_full, "AAA", 120)
    await insert_rows(pg_full, iid, shifted(democo(), 4))
    await analysis_db.compute_analysis(pg_full, "AAA", now=NOW)
    first = (await snapshot_rows(pg_full, iid))[0]
    await analysis_db.compute_analysis(pg_full, "AAA", now=NOW)
    again = await snapshot_rows(pg_full, iid)
    assert len(again) == 1 and doc(again[0]["indicators"]) == doc(first["indicators"])
    # the owner enters a restated net profit later: the next run reflects it and the entry stamp
    later = FETCHED + timedelta(days=2)
    await insert_rows(
        pg_full, iid,
        [FundRow("consolidated", "A", date(2022, 3, 31), "pnl.net_profit", 720.0, "INR_CR",
                 "manual", None, later)],
    )  # fmt: skip
    await analysis_db.compute_analysis(pg_full, "AAA", now=NOW)
    ind = doc((await snapshot_rows(pg_full, iid))[0]["indicators"])
    node = ind["fundamentals"]["consolidated"]["A"]
    assert node["derived"]["net_margin"][-1] == ap(720 / 4800 * 100)
    assert ind["fundamentals_meta"]["inputs_fetched_at"] == later.isoformat()


async def test_fnd_db_no_owner_data_writes_empty_tree_with_reason(pg_full: asyncpg.Pool) -> None:
    iid = await seed(pg_full, "AAA", 120)
    await analysis_db.compute_analysis(pg_full, "AAA", now=NOW)
    row = (await snapshot_rows(pg_full, iid))[0]
    ind, scores = doc(row["indicators"]), doc(row["scores"])
    assert ind["fundamentals"] == {} and ind["fundamentals_screener"] == {}
    assert ind["fundamentals_meta"]["reason"] == "no_data_entered"
    assert scores["quality"]["score"] is None and scores["quality"]["reason"] == "no_data_entered"
    s = await screener(pg_full, iid)
    assert not set(s) & set(FUNDAMENTAL_SCREENER_KEYS)


async def test_fnd09_db_only_confirmed_split_adjusts_eps(pg_full: asyncpg.Pool) -> None:
    iid = await seed(pg_full, "AAA", 120)
    await insert_rows(pg_full, iid, shifted(democo(), 4))
    ex = date(2022, 4, 4)  # after FY22 results, before the last bar (2022-06-17)
    for status, purpose in (("detected", "d"), ("rejected", "r")):
        await pg_full.execute(
            "INSERT INTO corporate_action (instrument_id, ex_date, action_type, status, ratio_num, "
            "ratio_den, purpose_text, source) VALUES ($1, $2, 'split', $3, 10, 2, $4, 'manual')",
            iid, ex, status, purpose,
        )  # fmt: skip
    await analysis_db.compute_analysis(pg_full, "AAA", now=NOW)
    val = doc((await snapshot_rows(pg_full, iid))[0]["indicators"])["fundamentals"]["consolidated"][
        "A"
    ]["valuation"]
    assert val["eps_ttm"] == ap(32.3)  # detected and rejected actions are never applied
    await pg_full.execute(
        "INSERT INTO corporate_action (instrument_id, ex_date, action_type, status, ratio_num, "
        "ratio_den, purpose_text, source) VALUES ($1, $2, 'split', 'confirmed', 10, 2, 'c', 'manual')",
        iid, ex,
    )  # fmt: skip
    await analysis_db.compute_analysis(pg_full, "AAA", now=NOW)
    val = doc((await snapshot_rows(pg_full, iid))[0]["indicators"])["fundamentals"]["consolidated"][
        "A"
    ]["valuation"]
    assert val["eps_ttm"] == ap(32.3 / 5) and val["bvps"] == ap(110.0 / 5)
    # a confirmed dividend (INR/share) within the last 365 days feeds the yield
    await pg_full.execute(
        "INSERT INTO corporate_action (instrument_id, ex_date, action_type, status, "
        "amount_per_share, purpose_text, source) VALUES ($1, $2, 'dividend', 'confirmed', 6, 'x', 'manual')",
        iid, date(2022, 5, 2),
    )  # fmt: skip
    await analysis_db.compute_analysis(pg_full, "AAA", now=NOW)
    val = doc((await snapshot_rows(pg_full, iid))[0]["indicators"])["fundamentals"]["consolidated"][
        "A"
    ]["valuation"]
    assert val["div_yield"] == ap(6 / await last_close(pg_full, iid) * 100)


async def test_shp_db_screener_holder_keys(pg_full: asyncpg.Pool) -> None:
    iid = await seed(pg_full, "AAA", 120)
    await pg_full.execute(
        "INSERT INTO shareholding (instrument_id, quarter_end, promoter_pct, fii_pct, mf_pct, "
        "promoter_pledged_pct, source) VALUES ($1, '2022-03-31', 50, 18.5, 5.5, NULL, 'manual'), "
        "($1, '2021-12-31', 51, 17, 5.0, NULL, 'manual')",
        iid,
    )
    await analysis_db.compute_analysis(pg_full, "AAA", now=NOW)
    await analysis_db.recompute_screener(pg_full, ["AAA"])
    s = await screener(pg_full, iid)
    assert (
        s["promoter_pct"] == 50.0
        and s["fii_change_qoq"] == ap(1.5)
        and s["mf_change_qoq"] == ap(0.5)
    )
    assert "promoter_pledged_pct" not in s  # SHP-02: unknown is absent, never 0
    assert "dii_pct" not in s
    await pg_full.execute("DELETE FROM shareholding WHERE quarter_end = '2021-12-31'")
    await analysis_db.compute_analysis(pg_full, "AAA", now=NOW)
    await analysis_db.recompute_screener(pg_full, ["AAA"])
    one = await screener(pg_full, iid)
    assert "fii_change_qoq" not in one and one["fii_pct"] == 18.5  # SHP-04: single quarter


async def insert_bars(pool: asyncpg.Pool, iid: int, n: int, vol: float, seed_no: int) -> None:
    rng = np.random.default_rng(seed_no)
    c = 100 * np.cumprod(1 + rng.normal(0.0004, vol, n))
    days = weekdays(n)
    await pool.executemany(
        "INSERT INTO price_daily (instrument_id, trade_date, open, high, low, close, adj_close, "
        "volume, source) VALUES ($1, $2, $3, $4, $5, $3, $3, $6, 'import')",
        [
            (iid, days[i], float(c[i]), float(c[i] * 1.01), float(c[i] * 0.99), 100_000 * (iid + 1))
            for i in range(n)
        ],
    )


async def benchmark(pool: asyncpg.Pool, n: int) -> None:
    rng = np.random.default_rng(5)
    level = 1000 * np.cumprod(1 + rng.normal(0.0003, 0.008, n))
    await pool.executemany(
        "INSERT INTO market_series (code, trade_date, value) VALUES ('NIFTY50', $1, $2)",
        [(d, float(v)) for d, v in zip(weekdays(n), level, strict=True)],
    )


async def tracked(pool: asyncpg.Pool, symbol: str, n: int, vol: float, seed_no: int) -> int:
    iid = int(
        await pool.fetchval(
            "INSERT INTO instrument (symbol, name, is_tracked, tracked_reason) "
            "VALUES ($1, $1, true, 'imported') RETURNING id",
            symbol,
        )
    )
    await insert_bars(pool, iid, n, vol, seed_no)
    return iid


async def test_sco_db_risk_pass_needs_20_stocks_and_updates_screener(pg_full: asyncpg.Pool) -> None:
    await benchmark(pg_full, 260)
    ids: list[int] = []
    for i in range(19):
        ids.append(await tracked(pg_full, f"S{i:02d}", 260, 0.005 + 0.001 * i, 10 + i))
        await analysis_db.compute_analysis(pg_full, f"S{i:02d}", now=NOW)
    done = await analysis_db.recompute_risk_scores(pg_full)
    assert len(done) == 19
    first = doc((await snapshot_rows(pg_full, ids[0]))[0]["scores"])["risk"]
    assert first["score"] is None and first["reason"] == "universe_too_small"
    ids.append(await tracked(pg_full, "S19", 260, 0.024, 99))
    await analysis_db.compute_analysis(pg_full, "S19", now=NOW)
    assert len(await analysis_db.recompute_risk_scores(pg_full)) == 20
    low = doc((await snapshot_rows(pg_full, ids[0]))[0]["scores"])["risk"]
    high = doc((await snapshot_rows(pg_full, ids[19]))[0]["scores"])["risk"]
    assert low["reason"] is None and high["reason"] is None and low["universe_size"] == 20
    comps = {c["key"]: c for c in high["components"]}
    assert comps["vol_252"]["percentile"] == 100.0  # the most volatile stock of the universe
    assert low["score"] < high["score"] and high["label"] in ("medium", "high")
    # maxdd_3y needs 756 bars, so only 3 components exist: coverage 0.75, still scored
    assert comps["maxdd_3y"]["available"] is False and high["coverage"] == ap(0.75)
    await analysis_db.recompute_screener(pg_full, ["S00", "S19"])
    s = await screener(pg_full, ids[19])
    assert s["risk_score"] == ap(high["score"])


async def test_sco_db_post_import_hooks_run_the_risk_pass_for_everyone(
    pg_full: asyncpg.Pool,
) -> None:
    await benchmark(pg_full, 260)
    for i in range(20):
        await tracked(pg_full, f"S{i:02d}", 260, 0.005 + 0.001 * i, 10 + i)
    hooks = analysis_db.production_hooks(pg_full)
    step = SymbolProcessor(pg_full, hooks=hooks)
    for i in range(20):
        await step(f"S{i:02d}")
    await hooks.recompute_screener(["S00"])  # one symbol named: every stock's score is refreshed
    rows = await pg_full.fetch("SELECT metrics FROM screener_row")
    assert len(rows) == 20
    assert all("risk_score" in doc(r["metrics"]) for r in rows)
    json.dumps([doc(r["metrics"]) for r in rows], allow_nan=False)
