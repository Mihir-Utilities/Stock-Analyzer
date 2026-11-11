"""INV-A05 and INV-A06 (docs/07) against Postgres: the investment-context blocks are written by
``compute_analysis`` for the newest snapshot, survive a re-run, are pruned from older snapshots
like the other heavy arrays, and read their ``INV_*`` settings and the holidays from the database.
The date of the computation is the ``now`` argument (no wall clock)."""

from __future__ import annotations

import json
import time
from datetime import UTC, date, datetime

import asyncpg
import pytest
from test_analysis_db import add_bars, closes, doc, seed, snapshot_rows, weekdays

from worker import analysis_db

pytestmark = [pytest.mark.anyio, pytest.mark.integration]

NOW = datetime(2026, 11, 11, 9, 0, tzinfo=UTC)  # 14:30 IST on 2026-11-11


async def test_inv_a05_blocks_written_idempotent_and_newest_keeps_them(
    pg_full: asyncpg.Pool,
) -> None:
    iid = await seed(pg_full, "AAA", 700)
    await analysis_db.compute_analysis(pg_full, "AAA", now=NOW)
    first = doc((await snapshot_rows(pg_full, iid))[0]["indicators"])["analysis"]
    for key in ("year_returns", "seasonality", "position", "drawdown_profile", "sip_backtest"):
        assert key in first, key
    assert (
        len(first["seasonality"]["months"]) == 12 and len(first["sip_backtest"]["variants"]) == 29
    )
    await analysis_db.compute_analysis(pg_full, "AAA", now=NOW)  # idempotent per as_of
    again = await snapshot_rows(pg_full, iid)
    assert len(again) == 1 and doc(again[0]["indicators"])["analysis"] == first
    # a later import: the older snapshot loses the heavy arrays, the newest keeps seasonality
    await add_bars(pg_full, iid, 710)
    await analysis_db.compute_analysis(pg_full, "AAA", now=NOW)
    rows = await snapshot_rows(pg_full, iid)
    assert len(rows) == 2
    assert "analysis" not in doc(rows[0]["indicators"])
    assert "seasonality" in doc(rows[1]["indicators"])["analysis"]
    # a trim of the newest bars: the stale snapshot goes and the blocks are recomputed
    days = weekdays(710)
    await pg_full.execute(
        "DELETE FROM price_daily WHERE instrument_id = $1 AND trade_date > $2", iid, days[600]
    )
    await analysis_db.compute_analysis(pg_full, "AAA", now=NOW)
    rows = await snapshot_rows(pg_full, iid)
    assert rows[-1]["as_of"] == days[600]
    assert (
        doc(rows[-1]["indicators"])["analysis"]["seasonality"]["last_bar"] == days[600].isoformat()
    )


async def test_inv_a06_settings_and_holidays_come_from_the_database(
    pg_full: asyncpg.Pool,
) -> None:
    iid = await seed(pg_full, "BBB", 700)

    async def seasonality() -> dict[str, object]:
        await analysis_db.compute_analysis(pg_full, "BBB", now=NOW)
        rows = await snapshot_rows(pg_full, iid)
        return doc(rows[-1]["indicators"])["analysis"]["seasonality"]  # type: ignore[no-any-return]

    base = await seasonality()
    assert base["min_years"] == 3 and base["small_sample_years"] == 5  # documented fallbacks
    await pg_full.execute(
        "INSERT INTO app_setting (key, value) VALUES ('INV_MIN_YEARS', '2'::jsonb), "
        "('INV_SMALL_YEARS', '\"4\"'::jsonb), ('INV_DD_TOL', 'null'::jsonb)"
    )
    changed = await seasonality()
    assert changed["min_years"] == 2 and changed["small_sample_years"] == 4
    two_years = [m for m in changed["months"] if m["n_years"] == 2]  # type: ignore[attr-defined]
    assert two_years and all(m["green_pct"] is not None for m in two_years)
    for m in base["months"]:  # type: ignore[attr-defined]
        if m["n_years"] == 2:
            assert m["green_pct"] is None and m["green_pct_reason"] == "too_few_years"


async def test_inv_a06_holidays_decide_whether_a_month_is_complete(pg_full: asyncpg.Pool) -> None:
    iid = await seed(pg_full, "CCC", 80)
    days = weekdays(80)
    # remove the last weekday of the first full month: without a holiday the month is incomplete
    month_ends = {d for i, d in enumerate(days[:-1]) if days[i + 1].month != d.month}
    gap = sorted(month_ends)[1]  # the first month has no cell, so take the second
    await pg_full.execute(
        "DELETE FROM price_daily WHERE instrument_id = $1 AND trade_date = $2", iid, gap
    )
    await analysis_db.compute_analysis(pg_full, "CCC", now=NOW)
    ind = doc((await snapshot_rows(pg_full, iid))[0]["indicators"])["analysis"]
    reasons = {(r[0], r[1]): r[2] for r in ind["month_year_reasons"]}
    assert reasons.get((gap.year, gap.month)) == "incomplete_month_data"
    await pg_full.execute(
        "INSERT INTO market_holiday (holiday_date, segment, description, source) "
        "VALUES ($1, 'trading', 'test', 'import')",
        gap,
    )
    await analysis_db.compute_analysis(pg_full, "CCC", now=NOW)
    ind = doc((await snapshot_rows(pg_full, iid))[0]["indicators"])["analysis"]
    cells = {(r[0], r[1]): r[2] for r in ind["month_year"]}
    assert cells[(gap.year, gap.month)] is not None  # the holiday makes the month complete


async def test_inv_s08_stored_size_and_compute_time_for_a_25_year_stock(
    pg_full: asyncpg.Pool,
) -> None:
    n = 6500
    iid = int(
        await pg_full.fetchval(
            "INSERT INTO instrument (symbol, name) VALUES ('LONG', 'LONG') RETURNING id"
        )
    )
    days, c = weekdays(n, date(2000, 1, 3)), closes(n)
    await pg_full.executemany(
        "INSERT INTO price_daily (instrument_id, trade_date, open, high, low, close, adj_close, "
        "volume, source) VALUES ($1, $2, $3, $3, $3, $3, $3, 1000, 'import')",
        [(iid, days[i], float(c[i])) for i in range(n)],
    )
    started = time.perf_counter()
    await analysis_db.compute_analysis(pg_full, "LONG", now=NOW)
    took = time.perf_counter() - started
    size = await pg_full.fetchval(
        "SELECT pg_column_size(indicators) FROM analysis_snapshot WHERE instrument_id = $1", iid
    )
    new = doc((await snapshot_rows(pg_full, iid))[0]["indicators"])["analysis"]
    blocks = {
        k: new[k]
        for k in (
            "year_returns",
            "seasonality",
            "position",
            "drawdown_profile",
            "holding_periods",
            "entry_study",
            "vol_regime",
            "sip_backtest",
            "risk_adjusted",
        )
    }
    grown = len(json.dumps(blocks, separators=(",", ":")))
    print(
        f"B16 compute_analysis {n} bars: {took:.2f}s, indicators {size} bytes, new blocks {grown}"
    )
    assert size < 200_000 and grown < 20_000
    assert took < 30  # the existing per-stock compute is a few seconds; blocks add well under 1 s
