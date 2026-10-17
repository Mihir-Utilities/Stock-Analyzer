"""detect_actions, re-adjustment, warnings, soft flag and dismissals against Postgres 16:
ACT-01/03/04/08/09/10/11/12/15, BRK-19, D-K, D-O, D-U."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import asyncpg
import pytest
from pricegen import make_series

from worker import actions_db
from worker.analytics.actions import FLAG_LARGE_DROP, Bar

pytestmark = [pytest.mark.anyio, pytest.mark.integration]


class RecordingNotifier:
    def __init__(self) -> None:
        self.sent: list[str] = []

    async def send_html(self, text: str) -> None:
        self.sent.append(text)


async def seed(pool: asyncpg.Pool, symbol: str, bars: list[Bar]) -> int:
    """Instrument plus bars written the way an importer upserts them (raw: adj_close = close)."""
    iid = await pool.fetchval(
        "INSERT INTO instrument (symbol, name) VALUES ($1, $2) "
        "ON CONFLICT (symbol) DO UPDATE SET name = EXCLUDED.name RETURNING id",
        symbol,
        f"{symbol} Ltd",
    )
    await upsert_bars(pool, iid, bars)
    return int(iid)


async def upsert_bars(pool: asyncpg.Pool, iid: int, bars: list[Bar]) -> None:
    await pool.executemany(
        "INSERT INTO price_daily (instrument_id, trade_date, open, high, low, close, adj_close, "
        "volume, source, src_adjusted) VALUES ($1, $2, $3, $3, $3, $3, $3, $4, 'import', $5) "
        "ON CONFLICT (instrument_id, trade_date) DO UPDATE SET open = EXCLUDED.open, "
        "high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close, "
        "volume = EXCLUDED.volume, src_adjusted = EXCLUDED.src_adjusted",
        [(iid, b.trade_date, b.close, b.volume, b.src_adjusted) for b in bars],
    )


async def add_action(
    pool: asyncpg.Pool,
    iid: int,
    ex_date: date,
    action_type: str,
    num: int,
    den: int,
    status: str = "confirmed",
) -> None:
    await pool.execute(
        "INSERT INTO corporate_action (instrument_id, ex_date, action_type, status, ratio_num, "
        "ratio_den, source) VALUES ($1, $2, $3, $4, $5, $6, 'manual')",
        iid,
        ex_date,
        action_type,
        status,
        Decimal(num),
        Decimal(den),
    )


async def adj_closes(pool: asyncpg.Pool, iid: int) -> list[tuple[float, float]]:
    rows = await pool.fetch(
        "SELECT close, adj_close FROM price_daily WHERE instrument_id = $1 ORDER BY trade_date", iid
    )
    return [(r["close"], r["adj_close"]) for r in rows]


# --------------------------------------------------------------------------- detect_actions
async def test_act01_detected_row_note_once_and_idempotent(pg_full: asyncpg.Pool) -> None:
    bars = make_series(60, jumps={40: (0.5, 3.0)})
    await seed(pg_full, "AAA", bars)
    notifier = RecordingNotifier()
    out = await actions_db.detect_actions(pg_full, "AAA", notifier=notifier)
    assert [d.ex_date for d in out.new_actions] == [bars[40].trade_date]
    row = await pg_full.fetchrow("SELECT * FROM corporate_action")
    assert row is not None
    assert (row["status"], row["action_type"], row["source"]) == (
        "detected",
        "split_or_bonus",
        "detected",
    )
    assert (row["ratio_num"], row["ratio_den"]) == (Decimal(1), Decimal(2))
    assert notifier.sent == [
        f"Possible split/bonus on AAA ({bars[40].trade_date}). Confirm in the app."
    ]
    # ACT-09 / "once per action": a second run (and a third) adds nothing and sends nothing
    for _ in range(2):
        again = await actions_db.detect_actions(pg_full, "AAA", notifier=notifier)
        assert again.new_actions == [] and again.already_known == 1
    assert await pg_full.fetchval("SELECT count(*) FROM corporate_action") == 1
    assert len(notifier.sent) == 1
    # analytics warning, ML hidden marker (docs/01 3.7); detection does not touch prices
    iid = await actions_db.instrument_id_for(pg_full, "AAA")
    assert iid is not None
    assert await actions_db.stock_warnings(pg_full, iid) == ["UNCONFIRMED_ACTION"]
    assert all(c == a for c, a in await adj_closes(pg_full, iid))


async def test_notification_text_escapes_html_and_failure_does_not_fail_the_job(
    pg_full: asyncpg.Pool,
) -> None:
    assert actions_db.detected_message("M&M", date(2026, 3, 2)) == (
        "Possible split/bonus on M&amp;M (2026-03-02). Confirm in the app."
    )

    class Broken:
        async def send_html(self, text: str) -> None:
            raise RuntimeError("telegram down")

    await seed(pg_full, "BBB", make_series(60, jumps={40: (0.5, 3.0)}))
    out = await actions_db.detect_actions(pg_full, "BBB", notifier=Broken())
    assert len(out.new_actions) == 1


async def test_act02_real_crash_creates_no_action(pg_full: asyncpg.Pool) -> None:
    await seed(pg_full, "CRASH", make_series(60, jumps={40: (0.6, 1.0)}))
    out = await actions_db.detect_actions(pg_full, "CRASH")
    assert out.new_actions == []
    assert await pg_full.fetchval("SELECT count(*) FROM corporate_action") == 0


async def test_act04_rejected_action_is_not_redetected(pg_full: asyncpg.Pool) -> None:
    await seed(pg_full, "AAA", make_series(60, jumps={40: (0.5, 3.0)}))
    await actions_db.detect_actions(pg_full, "AAA")
    await pg_full.execute("UPDATE corporate_action SET status = 'rejected'")
    out = await actions_db.detect_actions(pg_full, "AAA")
    assert out.new_actions == []
    assert await pg_full.fetchval("SELECT status FROM corporate_action") == "rejected"
    iid = await actions_db.instrument_id_for(pg_full, "AAA")
    assert iid is not None
    assert await actions_db.stock_warnings(pg_full, iid) == []


async def test_owner_entered_action_on_the_same_date_blocks_a_second_candidate(
    pg_full: asyncpg.Pool,
) -> None:
    bars = make_series(60, jumps={40: (0.5, 3.0)})
    iid = await seed(pg_full, "AAA", bars)
    await add_action(pg_full, iid, bars[40].trade_date, "split", 2, 1)
    out = await actions_db.detect_actions(pg_full, "AAA")
    assert out.new_actions == [] and out.already_known == 1
    assert await pg_full.fetchval("SELECT count(*) FROM corporate_action") == 1


async def test_act11_ex_date_inside_adjusted_bars_sets_conflict_and_adjusts_nothing(
    pg_full: asyncpg.Pool,
) -> None:
    bars = make_series(60, jumps={40: (0.5, 3.0)}, adjusted_until=45)
    iid = await seed(pg_full, "ADJ", bars)
    notifier = RecordingNotifier()
    out = await actions_db.detect_actions(pg_full, "ADJ", notifier=notifier)
    assert [d.ex_date for d in out.new_actions] == [bars[40].trade_date]
    assert out.conflicts == [bars[40].trade_date]
    assert await pg_full.fetchval("SELECT status FROM corporate_action") == "detected"
    assert await actions_db.stock_warnings(pg_full, iid) == [
        "UNCONFIRMED_ACTION",
        "ADJUSTMENT_CONFLICT",
    ]
    assert all(c == a for c, a in await adj_closes(pg_full, iid))  # nothing adjusted
    # the owner confirms as a split: bars 0..45 are src_adjusted, so nothing changes at all
    await pg_full.execute(
        "UPDATE corporate_action SET status = 'confirmed', action_type = 'split',"
        " ratio_num = 2, ratio_den = 1"
    )
    res = await actions_db.readjust_history(pg_full, "ADJ", as_of=date(2026, 12, 31))
    assert res["rows_updated"] == 0
    assert all(c == a for c, a in await adj_closes(pg_full, iid))
    assert await actions_db.stock_warnings(pg_full, iid) == []  # no longer awaiting the owner


async def test_conflict_only_when_a_bar_around_the_ex_date_is_adjusted(
    pg_full: asyncpg.Pool,
) -> None:
    bars = make_series(60, jumps={40: (0.5, 3.0)}, adjusted_until=38)  # ends before t-1 (index 39)
    iid = await seed(pg_full, "RAW", bars)
    out = await actions_db.detect_actions(pg_full, "RAW")
    assert out.conflicts == []
    assert await actions_db.stock_warnings(pg_full, iid) == ["UNCONFIRMED_ACTION"]


async def test_act15_soft_flag_creates_no_action_and_no_warning(pg_full: asyncpg.Pool) -> None:
    bars = make_series(60, jumps={40: (2 / 3, 3.0)})  # 1:2 bonus ratio
    iid = await seed(pg_full, "BON", bars)
    out = await actions_db.detect_actions(pg_full, "BON")
    assert out.new_actions == []
    assert [f.trade_date for f in out.soft_flags] == [bars[40].trade_date]
    assert await pg_full.fetchval("SELECT count(*) FROM corporate_action") == 0
    assert await actions_db.stock_warnings(pg_full, iid) == []  # no UNCONFIRMED_ACTION


# --------------------------------------------------------------------------- re-adjustment
async def test_act03_readjust_applies_confirmed_split_in_one_pass_and_is_idempotent(
    pg_full: asyncpg.Pool,
) -> None:
    bars = make_series(60, jumps={40: (0.2, 5.0)})
    iid = await seed(pg_full, "SPL", bars)
    await actions_db.detect_actions(pg_full, "SPL")
    # detected, not confirmed: nothing is applied
    assert (await actions_db.readjust_history(pg_full, "SPL"))["rows_updated"] == 0
    await pg_full.execute(
        "UPDATE corporate_action SET status = 'confirmed', action_type = 'split', "
        "ratio_num = 10, ratio_den = 2"
    )
    res = await actions_db.readjust_history(pg_full, "SPL", as_of=date(2026, 12, 31))
    assert res["rows_updated"] == 40 and res["actions_applied"] == 1
    rows = await adj_closes(pg_full, iid)
    for i, (close, adj) in enumerate(rows):
        expected = close / 5 if i < 40 else close
        assert adj == pytest.approx(expected, rel=1e-12), i
    # the series is now continuous: adjusted day-over-day change at the ex-date is small
    assert abs(rows[40][1] / rows[39][1] - 1) < 0.02
    again = await actions_db.readjust_history(pg_full, "SPL", as_of=date(2026, 12, 31))
    assert again["rows_updated"] == 0
    # rejecting afterwards restores adj_close = close
    await pg_full.execute("UPDATE corporate_action SET status = 'rejected'")
    undone = await actions_db.readjust_history(pg_full, "SPL", as_of=date(2026, 12, 31))
    assert undone["rows_updated"] == 40
    assert all(c == a for c, a in await adj_closes(pg_full, iid))


async def test_act12_mixed_src_adjusted_bars_never_adjusted_twice(pg_full: asyncpg.Pool) -> None:
    raw = make_series(60, jumps={40: (0.5, 3.0)})
    # bars 0..19 came from an already adjusted file, bars 20..59 from a raw one
    bars = [Bar(b.trade_date, b.close, b.volume, i < 20) for i, b in enumerate(raw)]
    iid = await seed(pg_full, "MIX", bars)
    await add_action(pg_full, iid, raw[40].trade_date, "split", 2, 1)
    res = await actions_db.readjust_history(pg_full, "MIX", as_of=date(2026, 12, 31))
    assert res["rows_updated"] == 20  # only bars 20..39
    rows = await adj_closes(pg_full, iid)
    for i, (close, adj) in enumerate(rows):
        if i < 20 or i >= 40:
            assert adj == close, i  # src_adjusted bars and post-ex bars keep adj_close = close
        else:
            assert adj == pytest.approx(close / 2, rel=1e-12), i
    assert (await actions_db.readjust_history(pg_full, "MIX", as_of=date(2026, 12, 31)))[
        "rows_updated"
    ] == 0


async def test_adjustment_with_two_actions_matches_the_reference(pg_full: asyncpg.Pool) -> None:
    bars = make_series(60)
    iid = await seed(pg_full, "TWO", bars)
    await add_action(pg_full, iid, bars[20].trade_date, "bonus", 1, 1)  # x2
    await add_action(pg_full, iid, bars[40].trade_date, "split", 10, 2)  # x5
    await actions_db.readjust_history(pg_full, "TWO", as_of=date(2026, 12, 31))
    rows = await adj_closes(pg_full, iid)
    for i, (close, adj) in enumerate(rows):
        factor = (1 / 10) if i < 20 else (1 / 5 if i < 40 else 1.0)
        assert adj == pytest.approx(close * factor, rel=1e-12), i


async def test_act10_future_ex_date_is_not_applied(pg_full: asyncpg.Pool) -> None:
    bars = make_series(30)
    iid = await seed(pg_full, "FUT", bars)
    await add_action(pg_full, iid, date(2026, 11, 2), "split", 10, 2)
    assert (await actions_db.readjust_history(pg_full, "FUT", as_of=date(2026, 10, 17)))[
        "rows_updated"
    ] == 0
    assert all(c == a for c, a in await adj_closes(pg_full, iid))
    due = await actions_db.readjust_history(pg_full, "FUT", as_of=date(2026, 11, 2))
    assert due["rows_updated"] == 30


async def test_act08_review_types_are_never_applied(pg_full: asyncpg.Pool) -> None:
    bars = make_series(30)
    iid = await seed(pg_full, "REV", bars)
    await add_action(pg_full, iid, bars[10].trade_date, "rights", 1, 4)
    await add_action(pg_full, iid, bars[15].trade_date, "demerger", 1, 1)
    await add_action(pg_full, iid, bars[20].trade_date, "split_or_bonus", 1, 2)
    res = await actions_db.readjust_history(pg_full, "REV", as_of=date(2026, 12, 31))
    assert res["rows_updated"] == 0 and res["actions_applied"] == 0
    assert sorted(res["review_needed"]) == sorted(
        [
            f"{bars[10].trade_date}:rights",
            f"{bars[15].trade_date}:demerger",
            f"{bars[20].trade_date}:split_or_bonus",
        ]
    )


async def test_dry_run_writes_nothing(pg_full: asyncpg.Pool) -> None:
    bars = make_series(60, jumps={40: (0.5, 3.0)})
    iid = await seed(pg_full, "DRY", bars)
    out = await actions_db.detect_actions(pg_full, "DRY", dry_run=True)
    assert len(out.new_actions) == 1
    assert await pg_full.fetchval("SELECT count(*) FROM corporate_action") == 0
    await add_action(pg_full, iid, bars[30].trade_date, "split", 2, 1)
    res = await actions_db.readjust_history(pg_full, "DRY", as_of=date(2026, 12, 31), dry_run=True)
    assert res["rows_updated"] is None and res["actions_applied"] == 1
    assert all(c == a for c, a in await adj_closes(pg_full, iid))


async def test_unknown_symbol_raises(pg_full: asyncpg.Pool) -> None:
    with pytest.raises(LookupError):
        await actions_db.detect_actions(pg_full, "NOPE")
    with pytest.raises(LookupError):
        await actions_db.readjust_history(pg_full, "NOPE")


# --------------------------------------------------------------------------- BRK-19
async def test_brk19_reimporting_the_same_bars_keeps_counts_and_actions_stable(
    pg_full: asyncpg.Pool,
) -> None:
    bars = make_series(60, jumps={40: (0.5, 3.0)})
    iid = await seed(pg_full, "DUP", bars)
    await actions_db.detect_actions(pg_full, "DUP")
    for _ in range(2):  # the same file again, and a file with overlapping duplicate days
        await upsert_bars(pg_full, iid, bars + bars[20:45])
        await actions_db.detect_actions(pg_full, "DUP")
    assert await pg_full.fetchval("SELECT count(*) FROM price_daily") == 60
    assert await pg_full.fetchval("SELECT count(*) FROM corporate_action") == 1


# --------------------------------------------------------------------------- soft flag dismissals
async def test_dismiss_undo_and_per_bar_scope(pg_full: asyncpg.Pool) -> None:
    bars = make_series(80, jumps={30: (0.7, 1.0), 60: (0.7, 1.0)})  # two separate 30% drops
    iid = await seed(pg_full, "DRP", bars)
    flags = await actions_db.list_soft_flags(pg_full, "DRP")
    assert [f.trade_date for f in flags] == [bars[30].trade_date, bars[60].trade_date]

    assert await actions_db.dismiss_flag(pg_full, "DRP", FLAG_LARGE_DROP, bars[30].trade_date)
    assert not await actions_db.dismiss_flag(pg_full, "DRP", FLAG_LARGE_DROP, bars[30].trade_date)
    assert [f.trade_date for f in await actions_db.list_soft_flags(pg_full, "DRP")] == [
        bars[60].trade_date
    ]  # dismissing one drop does not silence the later one
    row = await pg_full.fetchrow("SELECT * FROM flag_dismissals")
    assert row is not None and row["instrument_id"] == iid and row["dismissed_at"] is not None

    # a prices re-import cannot orphan the dismissal (keyed to the date, not a price row)
    await upsert_bars(pg_full, iid, bars)
    await pg_full.execute("DELETE FROM price_daily WHERE instrument_id = $1", iid)
    await seed(pg_full, "DRP", bars)
    assert len(await actions_db.list_soft_flags(pg_full, "DRP")) == 1

    assert await actions_db.undo_dismiss_flag(pg_full, "DRP", FLAG_LARGE_DROP, bars[30].trade_date)
    assert not await actions_db.undo_dismiss_flag(
        pg_full, "DRP", FLAG_LARGE_DROP, bars[30].trade_date
    )
    assert len(await actions_db.list_soft_flags(pg_full, "DRP")) == 2
    assert await pg_full.fetchval("SELECT count(*) FROM flag_dismissals") == 0


async def test_soft_flag_disappears_once_an_action_exists_on_that_date(
    pg_full: asyncpg.Pool,
) -> None:
    bars = make_series(60, jumps={40: (2 / 3, 3.0)})
    iid = await seed(pg_full, "ADD", bars)
    assert len(await actions_db.list_soft_flags(pg_full, "ADD")) == 1
    await add_action(pg_full, iid, bars[40].trade_date, "bonus", 1, 2)  # "Add corporate action"
    assert await actions_db.list_soft_flags(pg_full, "ADD") == []
