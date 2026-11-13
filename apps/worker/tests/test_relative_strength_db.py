"""RST-P06, RST-P08, RST-B03 and RST-B04 (docs/07) against Postgres: the sector peers are read once
per ``compute_analysis``, matched by trimmed case-insensitive sector among tracked stocks only, and
the stored block is pruned with the other heavy arrays. The date comes from the ``now`` argument."""

from __future__ import annotations

import json
from datetime import UTC, date, datetime
from typing import Any

import asyncpg
import numpy as np
import pytest
from test_analysis_db import closes, doc, snapshot_rows, weekdays

from worker import analysis_db

pytestmark = [pytest.mark.anyio, pytest.mark.integration]

NOW = datetime(2026, 11, 11, 9, 0, tzinfo=UTC)
N = 300


async def stock(
    pool: asyncpg.Pool,
    symbol: str,
    sector: str | None,
    *,
    tracked: bool = True,
    n: int = N,
    drift: float = 0.0004,
    seed: int = 1,
) -> int:
    iid = int(
        await pool.fetchval(
            "INSERT INTO instrument (symbol, name, sector, is_tracked) VALUES ($1, $1, $2, $3) "
            "RETURNING id",
            symbol,
            sector,
            tracked,
        )
    )
    rng = np.random.default_rng(seed)
    c = 100 * np.cumprod(1 + rng.normal(drift, 0.01, n))
    days = weekdays(n)
    await pool.executemany(
        "INSERT INTO price_daily (instrument_id, trade_date, open, high, low, close, adj_close, "
        "volume, source) VALUES ($1, $2, $3, $3, $3, $3, $3, 1000, 'import')",
        [(iid, days[i], float(c[i])) for i in range(n)],
    )
    return iid


async def index(pool: asyncpg.Pool, n: int = N) -> None:
    c = closes(n, seed=99)
    await pool.executemany(
        "INSERT INTO market_series (code, trade_date, value) VALUES ('NIFTY50', $1, $2)",
        [(d, float(v)) for d, v in zip(weekdays(n), c, strict=True)],
    )


async def block(pool: asyncpg.Pool, iid: int) -> dict[str, Any]:
    rows = await snapshot_rows(pool, iid)
    out = doc(rows[-1]["indicators"])["analysis"]["relative_strength"]
    assert isinstance(out, dict)
    return out


class Spy:
    """Delegates to the pool and records every SQL text."""

    def __init__(self, pool: asyncpg.Pool) -> None:
        self.pool, self.sql = pool, []  # type: ignore[var-annotated]

    def __getattr__(self, name: str) -> Any:
        target = getattr(self.pool, name)
        if name not in ("fetch", "fetchrow", "fetchval", "execute"):
            return target

        async def wrapped(query: str, *args: Any) -> Any:
            self.sql.append(query)
            return await target(query, *args)

        return wrapped


async def test_rst_p06_rp3_sector_matching_and_unclassified(pg_full: asyncpg.Pool) -> None:
    await index(pg_full)
    s = await stock(pg_full, "S", "Banks", seed=1)
    await stock(pg_full, "P1", "Banks", seed=2)
    await stock(pg_full, "P2", "banks ", seed=3)
    p3 = await stock(pg_full, "P3", None, seed=4)
    await stock(pg_full, "P4", "Banks", tracked=False, seed=5)  # untracked: never a peer
    await stock(pg_full, "P5", "Banks", n=N - 10, seed=6)  # last bar earlier: no bar dated on E
    await analysis_db.compute_analysis(pg_full, "S", now=NOW)
    peers = (await block(pg_full, s))["vs_peers"]
    assert peers["sector"] == "Banks" and peers["peers_in_sector"] == 3  # P1, P2, P5
    assert peers["excluded"] == 1  # P5
    assert [w["n_peers"] for w in peers["windows"]] == [2, 2, 2]
    assert all(w["reason"] == "too_few_peers" and w["rank"] is None for w in peers["windows"])
    # the unclassified stock has no peers and is nobody's peer
    await analysis_db.compute_analysis(pg_full, "P3", now=NOW)
    out = await block(pg_full, p3)
    assert out["vs_peers"] is None and out["vs_peers_reason"] == "no_sector"
    # a third qualifying peer unlocks the ranks
    await stock(pg_full, "P6", " BANKS", seed=7)
    await analysis_db.compute_analysis(pg_full, "S", now=NOW)
    peers = (await block(pg_full, s))["vs_peers"]
    assert peers["peers_in_sector"] == 4 and peers["excluded"] == 1
    for w in peers["windows"]:
        assert w["n_peers"] == 3 and w["n_total"] == 4
        assert 1 <= w["rank"] <= 4 and 0 <= w["percentile"] <= 100
        assert w["small_sample"] is True and w["reason"] is None
    vs = (await block(pg_full, s))["vs_index"]
    assert vs is not None and vs["aligned_rows"] == N


async def test_rst_p08_one_extra_grouped_read(pg_full: asyncpg.Pool) -> None:
    await stock(pg_full, "S", "Banks", seed=1)
    await stock(pg_full, "P1", "Banks", seed=2)
    await stock(pg_full, "X", None, seed=3)
    spy = Spy(pg_full)
    await analysis_db.compute_analysis(spy, "S", now=NOW)  # type: ignore[arg-type]
    peer_reads = [q for q in spy.sql if "LEFT JOIN price_daily" in q]
    assert len(peer_reads) == 1
    spy.sql.clear()
    await analysis_db.compute_analysis(spy, "X", now=NOW)  # type: ignore[arg-type]
    assert not [q for q in spy.sql if "LEFT JOIN price_daily" in q]  # no sector: no peer read


async def test_rst_b03_a_failing_peer_read_gives_compute_error_and_a_snapshot(
    pg_full: asyncpg.Pool, monkeypatch: pytest.MonkeyPatch
) -> None:
    await index(pg_full)
    s = await stock(pg_full, "S", "Banks", seed=1)
    await stock(pg_full, "P1", "Banks", seed=2)
    monkeypatch.setattr(analysis_db, "PEER_LOOKBACK_DAYS", "bad")
    out = await analysis_db.compute_analysis(pg_full, "S", now=NOW)
    assert out["status"] == "ok"
    rs = await block(pg_full, s)
    assert rs["vs_peers"] is None and rs["vs_peers_reason"] == "compute_error"
    assert rs["vs_index"] is not None  # the other half is intact


async def test_rst_b04_pruned_with_older_snapshots_and_small(pg_full: asyncpg.Pool) -> None:
    n = 6500
    await index(pg_full, n)
    s = await stock(pg_full, "LONG", "Banks", n=n, seed=1)
    for i in range(8):
        await stock(pg_full, f"Q{i}", "Banks", n=n, seed=10 + i)
    await analysis_db.compute_analysis(pg_full, "LONG", now=NOW)
    rs = await block(pg_full, s)
    size = len(json.dumps(rs, separators=(",", ":")))
    assert size < 12_000, size
    assert rs["vs_peers"]["windows"][2]["n_peers"] == 8
    assert rs["vs_index"]["rolling_year"]["windows"] == n - 252
    # a later bar: the older snapshot loses the block with the rest of `analysis`
    days = weekdays(n + 1)
    await pg_full.execute(
        "INSERT INTO price_daily (instrument_id, trade_date, open, high, low, close, adj_close, "
        "volume, source) VALUES ($1, $2, 100, 100, 100, 100, 100, 1000, 'import')",
        s,
        days[-1],
    )
    await analysis_db.compute_analysis(pg_full, "LONG", now=NOW)
    rows = await snapshot_rows(pg_full, s)
    assert len(rows) == 2
    assert "analysis" not in doc(rows[0]["indicators"])
    assert "relative_strength" in doc(rows[1]["indicators"])["analysis"]
    assert rows[1]["as_of"] == date.fromisoformat(days[-1].isoformat())


async def test_rst_p06b_rp3_tab_and_nbsp_sector_labels_match_like_python_trim(
    pg_full: asyncpg.Pool,
) -> None:
    """N3: SQL btrim and Python strip agree on tabs, newlines and NBSP, in both directions."""
    s = await stock(pg_full, "S", "\tBanks\u00a0", seed=1)  # the stock's own label has junk too
    for i, label in enumerate(["BANKS", "banks\n", "\u00a0Banks", "Bank", "Banks Ltd"]):
        await stock(pg_full, f"P{i}", label, seed=20 + i)
    await analysis_db.compute_analysis(pg_full, "S", now=NOW)
    peers = (await block(pg_full, s))["vs_peers"]
    assert peers["sector"] == "Banks"
    assert (
        peers["peers_in_sector"] == 3
    )  # BANKS, "banks\n", NBSP-Banks; not "Bank", not "Banks Ltd"
    assert all(w["n_peers"] == 3 for w in peers["windows"])
