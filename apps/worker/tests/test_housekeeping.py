"""D08 housekeeping (docs/04 3.10): SYS-02 size thresholds and notices, SYS-03 catch-up,
SYS-05 overlapping runs. Imported prices are never deleted (manual price mode)."""

from __future__ import annotations

import json
import os
from typing import Any

import asyncpg
import pytest

from worker import housekeeping, jobs
from worker.housekeeping import judge_size, notice_text, run_housekeeping, warn_level
from worker.runner import JobContext, JobSpec, run_job

pytestmark = pytest.mark.anyio


# --------------------------------------------------------------------------- SYS-02 (pure)
@pytest.mark.parametrize(
    ("size", "level"),
    [
        (0, "ok"),
        (265.9, "ok"),
        (266.0, "70"),  # 70 % of 380
        (322.0, "70"),  # 85 % = 323: just below stays 70
        (323.0, "85"),
        (361.0, "95"),
        (379.9, "95"),
        (380.0, "limit"),
        (500.0, "limit"),
    ],
)
def test_sys02_warn_level_thresholds(size: float, level: str) -> None:
    assert warn_level(size, 380) == level


def test_sys02_one_notice_per_crossing() -> None:
    notified = "ok"
    sent: list[str] = []
    for size in (200, 270, 275, 330, 335, 362, 370, 380, 390):
        v = judge_size(size, 380, notified)
        if v.notify:
            sent.append(v.notify)
        notified = v.notified
    assert sent == ["70", "85", "95"]  # repeated runs in a band and the limit stay quiet


def test_sys02_recrossing_after_a_drop_notifies_again() -> None:
    v = judge_size(300, 380, "ok")
    assert v.notify == "70"
    v = judge_size(100, 380, v.notified)  # owner trimmed history
    assert (v.level, v.notify, v.notified) == ("ok", None, "ok")
    assert judge_size(300, 380, v.notified).notify == "70"


def test_sys02_jump_straight_to_limit_still_warns_once() -> None:
    v = judge_size(390, 380, "ok")
    assert v.level == "limit"
    assert v.notify == "95"
    assert judge_size(390, 380, v.notified).notify is None


def test_sys02_notice_text_states_policy_and_has_no_html_specials() -> None:
    text = notice_text(300, 380, "70")
    assert "never deleted automatically" in text
    assert "<" not in text and "&" not in text


def test_sys02_nonpositive_limit_is_ok() -> None:
    assert warn_level(100, 0) == "ok"


# --------------------------------------------------------------------------- SYS-05 / registry
async def test_sys05_overlapping_housekeeping_second_run_is_skipped(run_store) -> None:  # type: ignore[no-untyped-def]
    started = await run_store.try_lock("housekeeping")
    assert started is not None

    async def never(ctx: JobContext) -> None:
        raise AssertionError("must not run while another run holds the lock")

    res = await run_job(JobSpec("housekeeping", 1200, never), run_store)
    assert res.status == "skipped"
    assert res.details["reason"] == "already_running"


def test_d08_jobs_are_registered_with_spec_timeouts() -> None:
    from worker import job_defs

    job_defs.register_all()
    assert jobs.CLI_JOBS["housekeeping"].timeout_s == 20 * 60
    assert jobs.CLI_JOBS["backup_user_data"].timeout_s == 10 * 60


# --------------------------------------------------------------------------- DB (seeded)
class FakeNotifier:
    def __init__(self, status: str = "sent") -> None:
        self.messages: list[str] = []
        self.last_status = status

    async def send_html(self, text: str) -> None:
        self.messages.append(text)


async def _scalar(pool: asyncpg.Pool, sql: str, *args: Any) -> Any:
    return await pool.fetchval(sql, *args)


async def _seed_ops(pool: asyncpg.Pool) -> None:
    await pool.execute(
        """
        INSERT INTO session (token_hash, expires_at, revoked_at) VALUES
          ('\\x01', now() - interval '8 days', NULL),
          ('\\x02', now() - interval '2 days', NULL),
          ('\\x03', now() + interval '10 days', now() - interval '8 days'),
          ('\\x04', now() + interval '10 days', NULL);
        INSERT INTO telegram_link_code (code_hash, expires_at) VALUES
          ('\\x01', now() - interval '2 days'), ('\\x02', now() - interval '12 hours');
        INSERT INTO broker_oauth_state (state_hash, expires_at) VALUES
          ('\\x01', now() - interval '2 days'), ('\\x02', now() + interval '1 hour');
        INSERT INTO refresh_job (kind, target, status, requested_at) VALUES
          ('mf_refresh', '1', 'ok', now() - interval '100 days'),
          ('mf_refresh', '2', 'queued', now() - interval '100 days'),
          ('mf_refresh', '3', 'ok', now() - interval '10 days');
        INSERT INTO ingestion_run (job, status, started_at) VALUES
          ('a', 'ok', now() - interval '200 days'),
          ('a', 'ok', now() - interval '100 days'),
          ('b', 'running', now() - interval '200 days');
        INSERT INTO import_upload (id, kind, content, expires_at) VALUES
          ('00000000-0000-0000-0000-000000000001', 'prices', '\\x00', now() - interval '1 minute'),
          ('00000000-0000-0000-0000-000000000002', 'prices', '\\x00', now() + interval '1 hour');
        """
    )
    iid = await pool.fetchval(
        "INSERT INTO instrument (symbol, name) VALUES ('ALRT','Alert Co') RETURNING id"
    )
    aid = await pool.fetchval(
        "INSERT INTO alert (target_type, instrument_id, kind, params) "
        "VALUES ('stock', $1, 'price_above', '{}') RETURNING id",
        iid,
    )
    await pool.execute(
        "INSERT INTO alert_event (alert_id, fired_at, dedupe_key, payload) VALUES "
        "($1, now() - interval '401 days', 'old', '{}'), ($1, now() - interval '399 days', 'new', '{}')",
        aid,
    )


@pytest.mark.integration
async def test_sys03_catch_up_deletes_everything_past_its_age_in_one_run(
    pg_full: asyncpg.Pool,
) -> None:
    """Several weekly runs were skipped: one late run removes all that is due (data state, not
    the calendar, decides) and a second run changes nothing (idempotent)."""
    await _seed_ops(pg_full)
    ctx = JobContext(job="housekeeping")
    first = await run_housekeeping(pg_full, ctx, FakeNotifier())
    assert first["purged"] == {
        "session": 2,
        "telegram_link_code": 1,
        "broker_oauth_state": 1,
        "refresh_job": 1,
        "ingestion_run": 1,
        "alert_event": 1,
        "import_upload": 1,
    }
    assert await _scalar(pg_full, "SELECT count(*) FROM session") == 2
    assert await _scalar(pg_full, "SELECT count(*) FROM refresh_job") == 2  # queued kept
    assert (
        await _scalar(pg_full, "SELECT count(*) FROM ingestion_run WHERE status = 'running'") == 1
    )
    again = await run_housekeeping(pg_full, JobContext(job="housekeeping"), FakeNotifier())
    assert sum(again["purged"].values()) == 0


async def _all_counts(pool: asyncpg.Pool) -> dict[str, int]:
    tables = [
        r["tablename"]
        for r in await pool.fetch("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")
    ]
    return {
        t: int(await pool.fetchval(f'SELECT count(*) FROM "{t}"'))  # noqa: S608
        for t in sorted(tables)
    }


@pytest.mark.integration
async def test_dry_run_through_the_runner_prints_counts_only_and_changes_nothing(
    pg_full: asyncpg.Pool, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The real job function runs under run_job(dry_run=True) against the database."""
    from worker import job_defs
    from worker.runner import run_job

    job_defs.register_all()
    await _seed_ops(pg_full)
    await pg_full.execute(
        "INSERT INTO instrument (symbol, name, is_tracked, tracked_reason, last_opened_at) VALUES "
        "('SECRETSYM','x',true,'opened', now() - interval '5 days'),"
        "('NEWER','x',true,'opened', now())"
    )
    monkeypatch.setenv("OPENED_STOCKS_LRU_CAP", "1")
    monkeypatch.setenv("DATABASE_URL", os.environ["TEST_DATABASE_URL"])
    monkeypatch.setattr(housekeeping, "create_pool", _same_pool(pg_full))
    before = await _all_counts(pg_full)
    result = await run_job(jobs.CLI_JOBS["housekeeping"], None, dry_run=True)
    assert result.status == "ok", result.error
    assert result.rows_written == 0
    assert result.details["purged"]["session"] == 2
    assert result.details["lru_untracked_count"] == 1
    assert "SECRETSYM" not in json.dumps(result.details)  # counts only, no symbol names
    assert await _all_counts(pg_full) == before
    assert (
        await _scalar(pg_full, "SELECT count(*) FROM app_setting WHERE key = 'DB_WARN_NOTIFIED'")
        == 0
    )


def _same_pool(pool: asyncpg.Pool):  # type: ignore[no-untyped-def]
    class _Keep:
        async def close(self) -> None:  # the fixture owns the pool
            return None

        def __getattr__(self, name: str) -> Any:
            return getattr(pool, name)

    async def create_pool(dsn: str | None = None) -> Any:
        return _Keep()

    return create_pool


def test_cli_dry_run_prints_scrubbed_details(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    from worker import __main__ as cli
    from worker.runner import RunResult

    async def fake_run(args: Any, store: Any = None) -> RunResult:
        details = {"purged": {"session": 2}, "note": "token=123456:ABC-secretsecretsecretsecret"}
        return RunResult("housekeeping", "ok", None, 0, None, 0, None, details)

    monkeypatch.setattr(cli, "_run", fake_run)
    assert cli.main(["run", "housekeeping", "--dry-run"]) == 0
    printed = json.loads(capsys.readouterr().out)
    assert printed["dry_run"] is True
    assert printed["details"]["purged"] == {"session": 2}
    assert "ABC-secretsecret" not in json.dumps(printed)
    assert cli.main(["run", "housekeeping"]) == 0
    assert "details" not in json.loads(capsys.readouterr().out)


async def _price(pool: asyncpg.Pool, iid: int) -> None:
    await pool.execute(
        "INSERT INTO price_daily (instrument_id, trade_date, open, high, low, close, adj_close, "
        "source) VALUES ($1, '2026-01-02', 10, 11, 9, 10, 10, 'import')",
        iid,
    )


@pytest.mark.integration
async def test_sys02_lru_untracks_only_opened_without_prices_and_keeps_exempt_stocks(
    pg_full: asyncpg.Pool, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OPENED_STOCKS_LRU_CAP", "2")
    ids: dict[str, int] = {}
    for sym, reason, age in [
        ("O1", "opened", 1),
        ("O2", "opened", 2),
        ("O3", "opened", 3),
        ("O4", "opened", 4),
        ("OP", "opened", 9),  # has imported prices: exempt
        ("WL", "opened", 9),  # on the watchlist: exempt
        ("PF", "opened", 9),  # in the portfolio: exempt
        ("IM", "imported", 9),  # imported: exempt
    ]:
        ids[sym] = int(
            await pg_full.fetchval(
                "INSERT INTO instrument (symbol, name, is_tracked, tracked_reason, last_opened_at) "
                "VALUES ($1, $1, true, $2, now() - make_interval(days => $3)) RETURNING id",
                sym,
                reason,
                age,
            )
        )
    await _price(pg_full, ids["OP"])
    await _price(pg_full, ids["IM"])
    await pg_full.execute("INSERT INTO watchlist_item (instrument_id) VALUES ($1)", ids["WL"])
    await pg_full.execute(
        "INSERT INTO portfolio_txn (instrument_id, side, qty, price, trade_date) "
        "VALUES ($1, 'buy', 1, 10, '2026-01-02')",
        ids["PF"],
    )
    out = await run_housekeeping(pg_full, JobContext(job="housekeeping"), FakeNotifier())
    assert sorted(out["lru_untracked"]) == ["O3", "O4"]  # the two least recently opened
    rows = {
        r["symbol"]: r["is_tracked"]
        for r in await pg_full.fetch("SELECT symbol, is_tracked FROM instrument")
    }
    assert sorted(s for s, t in rows.items() if not t) == ["O3", "O4"]
    assert await _scalar(pg_full, "SELECT count(*) FROM price_daily") == 2


@pytest.mark.integration
async def test_sys02_prices_are_never_deleted_even_over_the_limit(
    pg_full: asyncpg.Pool, monkeypatch: pytest.MonkeyPatch
) -> None:
    iid = int(
        await pg_full.fetchval(
            "INSERT INTO instrument (symbol, name, is_tracked, tracked_reason) "
            "VALUES ('IMP','Imp',true,'imported') RETURNING id"
        )
    )
    await _price(pg_full, iid)
    monkeypatch.setenv("DB_SOFT_LIMIT_MB", "1")  # the database is far above 1 MB
    notifier = FakeNotifier()
    out = await run_housekeeping(pg_full, JobContext(job="housekeeping"), notifier)
    assert out["size"]["level"] == "limit"
    assert await _scalar(pg_full, "SELECT count(*) FROM price_daily") == 1
    assert await _scalar(pg_full, "SELECT count(*) FROM instrument WHERE is_tracked") == 1
    # one source only: no DB_WARN_LEVEL is written, only the notice memory
    assert (
        await _scalar(pg_full, "SELECT count(*) FROM app_setting WHERE key = 'DB_WARN_LEVEL'") == 0
    )
    assert (
        await _scalar(
            pg_full, "SELECT value #>> '{}' FROM app_setting WHERE key = 'DB_WARN_NOTIFIED'"
        )
        == "limit"
    )


def test_soft_limit_comes_from_the_environment_only(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("DB_SOFT_LIMIT_MB", raising=False)
    assert housekeeping.soft_limit_mb() == 380
    monkeypatch.setenv("DB_SOFT_LIMIT_MB", "250")
    assert housekeeping.soft_limit_mb() == 250
    for bad in ("", "abc", "0", "-5"):
        monkeypatch.setenv("DB_SOFT_LIMIT_MB", bad)  # empty = workflow variable not set
        assert housekeeping.soft_limit_mb() == 380


@pytest.mark.integration
async def test_an_app_setting_row_does_not_override_the_environment_limit(
    pg_full: asyncpg.Pool, monkeypatch: pytest.MonkeyPatch
) -> None:
    await pg_full.execute("INSERT INTO app_setting (key, value) VALUES ('DB_SOFT_LIMIT_MB', '1')")
    monkeypatch.setenv("DB_SOFT_LIMIT_MB", "100000")
    out = await run_housekeeping(pg_full, JobContext(job="housekeeping"), FakeNotifier())
    assert out["size"]["limit_mb"] == 100000 and out["size"]["level"] == "ok"


def test_notice_text_is_html_escaped() -> None:
    assert "<b>" not in notice_text(300, 380, "<b>")
    assert "&lt;b&gt;" in notice_text(300, 380, "<b>")


@pytest.mark.integration
async def test_sys02_levels_stored_and_one_telegram_notice_per_crossing(
    pg_full: asyncpg.Pool, monkeypatch: pytest.MonkeyPatch
) -> None:
    size = {"mb": 0.0}

    async def fake_size(pool: asyncpg.Pool) -> float:
        return size["mb"]

    monkeypatch.setattr(housekeeping, "db_size_mb", fake_size)
    notifier = FakeNotifier()  # DB_SOFT_LIMIT_MB is the 380 default

    async def run_at(mb: float) -> str:
        size["mb"] = mb
        out = await run_housekeeping(pg_full, JobContext(job="housekeeping"), notifier)
        return str(out["size"]["level"])

    assert await run_at(100) == "ok"
    assert notifier.messages == []
    assert await run_at(270) == "70"
    assert await run_at(280) == "70"  # same band, no second notice
    assert len(notifier.messages) == 1
    assert await run_at(330) == "85"
    assert await run_at(365) == "95"
    assert len(notifier.messages) == 3
    assert await run_at(381) == "limit"
    assert len(notifier.messages) == 3  # the limit itself adds no notice
    memory = await pg_full.fetchval(
        "SELECT value #>> '{}' FROM app_setting WHERE key = 'DB_WARN_NOTIFIED'"
    )
    assert memory == "limit"
    assert await run_at(100) == "ok"  # owner freed space
    assert await run_at(270) == "70"
    assert len(notifier.messages) == 4


@pytest.mark.integration
async def test_undelivered_notice_is_retried_next_run(
    pg_full: asyncpg.Pool, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def fake_size(pool: asyncpg.Pool) -> float:
        return 280.0

    monkeypatch.setattr(housekeeping, "db_size_mb", fake_size)
    quiet = FakeNotifier(status="no_token")
    await run_housekeeping(pg_full, JobContext(job="housekeeping"), quiet)
    working = FakeNotifier()
    await run_housekeeping(pg_full, JobContext(job="housekeeping"), working)
    assert len(working.messages) == 1
    await run_housekeeping(pg_full, JobContext(job="housekeeping"), working)
    assert len(working.messages) == 1


@pytest.mark.integration
async def test_hkx01_mf_navs_older_than_12_months_only_for_unopened_schemes(
    pg_full: asyncpg.Pool,
) -> None:
    """A scheme is kept when tracked, opened (last_opened_at set), on the watchlist or alerted."""
    await pg_full.execute(
        "INSERT INTO mf_scheme (code, name, is_tracked, last_opened_at) VALUES "
        "(1,'plain',false,NULL),(2,'tracked',true,NULL),(3,'watched',false,NULL),"
        "(4,'alerted',false,NULL),(5,'opened',false, now() - interval '30 days')"
    )
    await pg_full.execute("INSERT INTO watchlist_item (mf_scheme_code) VALUES (3)")
    await pg_full.execute(
        "INSERT INTO alert (target_type, mf_scheme_code, kind, params) "
        "VALUES ('mf', 4, 'nav_above', '{}')"
    )
    for code in (1, 2, 3, 4, 5):
        await pg_full.execute(
            "INSERT INTO mf_nav (scheme_code, nav_date, nav) VALUES "
            "($1, (now() - interval '13 months')::date, 10), ($1, (now() - interval '2 months')::date, 11)",
            code,
        )
    out = await run_housekeeping(pg_full, JobContext(job="housekeeping"), FakeNotifier())
    assert out["mf_nav_deleted"] == 1
    left = {
        r["scheme_code"]: r["n"]
        for r in await pg_full.fetch("SELECT scheme_code, count(*) n FROM mf_nav GROUP BY 1")
    }
    assert left == {1: 1, 2: 2, 3: 2, 4: 2, 5: 2}  # the opened-but-untracked scheme keeps its NAVs


@pytest.mark.integration
async def test_hkx02_opened_untracked_scheme_with_13_month_old_nav_is_kept(
    pg_full: asyncpg.Pool,
) -> None:
    await pg_full.execute(
        "INSERT INTO mf_scheme (code, name, is_tracked, last_opened_at) "
        "VALUES (7,'opened only',false, now())"
    )
    await pg_full.execute(
        "INSERT INTO mf_nav (scheme_code, nav_date, nav) VALUES "
        "(7, (now() - interval '13 months')::date, 10), (7, (now() - interval '1 day')::date, 11)"
    )
    dry = await run_housekeeping(pg_full, JobContext(job="housekeeping", dry_run=True))
    assert dry["mf_nav_deleted"] == 0
    await run_housekeeping(pg_full, JobContext(job="housekeeping"), FakeNotifier())
    assert await _scalar(pg_full, "SELECT count(*) FROM mf_nav WHERE scheme_code = 7") == 2


@pytest.mark.integration
async def test_hkx03_a_schemes_newest_nav_is_never_deleted(pg_full: asyncpg.Pool) -> None:
    """A closed scheme whose latest NAV is older than 12 months keeps that NAV; older ones go."""
    await pg_full.execute("INSERT INTO mf_scheme (code, name) VALUES (8,'closed'),(9,'live')")
    await pg_full.execute(
        "INSERT INTO mf_nav (scheme_code, nav_date, nav) VALUES "
        "(8, (now() - interval '20 months')::date, 9), (8, (now() - interval '15 months')::date, 10),"
        "(9, (now() - interval '14 months')::date, 9), (9, (now() - interval '1 month')::date, 10)"
    )
    out = await run_housekeeping(pg_full, JobContext(job="housekeeping"), FakeNotifier())
    assert out["mf_nav_deleted"] == 2  # 8: the 20-month row; 9: the 14-month row
    rows = await pg_full.fetch(
        "SELECT scheme_code, nav_date FROM mf_nav WHERE scheme_code IN (8, 9) ORDER BY 1, 2"
    )
    assert [r["scheme_code"] for r in rows] == [8, 9]
    # idempotent: the kept newest rows survive a second run
    again = await run_housekeeping(pg_full, JobContext(job="housekeeping"), FakeNotifier())
    assert again["mf_nav_deleted"] == 0


@pytest.mark.integration
async def test_hkx04_owner_entered_data_exempts_a_stock_from_the_lru(
    pg_full: asyncpg.Pool, monkeypatch: pytest.MonkeyPatch
) -> None:
    """docs/04 3.10: owner-entered data is never evicted, so a stock holding fundamentals,
    shareholding, a confirmed action, a portfolio adjustment or an alert stays tracked."""
    monkeypatch.setenv("OPENED_STOCKS_LRU_CAP", "1")
    ids: dict[str, int] = {}
    for sym in ("FUN", "SHR", "ACT", "ALR", "FREE", "NEW"):
        ids[sym] = int(
            await pg_full.fetchval(
                "INSERT INTO instrument (symbol, name, is_tracked, tracked_reason, last_opened_at) "
                "VALUES ($1,$1,true,'opened', now() - interval '900 days') RETURNING id",
                sym,
            )
        )
    await pg_full.execute(
        "UPDATE instrument SET last_opened_at = now() WHERE symbol = 'NEW'"
    )  # the one stock inside the cap
    await pg_full.execute(
        "INSERT INTO fundamental_value (instrument_id, basis, period_type, period_end, metric_key, "
        "value, source) VALUES ($1,'consolidated','A','2020-03-31','pnl.revenue',1,'manual')",
        ids["FUN"],
    )
    await pg_full.execute(
        "INSERT INTO shareholding (instrument_id, quarter_end, source) "
        "VALUES ($1,'2020-03-31','manual')",
        ids["SHR"],
    )
    await pg_full.execute(
        "INSERT INTO corporate_action (instrument_id, ex_date, action_type, status, source) "
        "VALUES ($1,'2020-03-31','dividend','confirmed','manual')",
        ids["ACT"],
    )
    await pg_full.execute(
        "INSERT INTO alert (target_type, instrument_id, kind, params) "
        "VALUES ('stock', $1, 'price_above', '{}')",
        ids["ALR"],
    )
    out = await run_housekeeping(pg_full, JobContext(job="housekeeping"), FakeNotifier())
    assert out["lru_untracked"] == ["FREE"]  # only the stock without any owner data goes
    tracked = {
        r["symbol"] for r in await pg_full.fetch("SELECT symbol FROM instrument WHERE is_tracked")
    }
    assert tracked == {"FUN", "SHR", "ACT", "ALR", "NEW"}
    assert await _scalar(pg_full, "SELECT count(*) FROM fundamental_value") == 1
    assert await _scalar(pg_full, "SELECT count(*) FROM shareholding") == 1
    assert await _scalar(pg_full, "SELECT count(*) FROM corporate_action") == 1
    assert await _scalar(pg_full, "SELECT count(*) FROM alert") == 1


class _SpyPool:
    """Records the statements a function sends, then forwards them to the real pool."""

    def __init__(self, pool: asyncpg.Pool) -> None:
        self.pool = pool
        self.sql: list[str] = []

    async def fetch(self, sql: str, *args: Any) -> Any:
        self.sql.append(sql)
        return await self.pool.fetch(sql, *args)

    async def execute(self, sql: str, *args: Any) -> Any:
        self.sql.append(sql)
        return await self.pool.execute(sql, *args)


@pytest.mark.integration
async def test_hkx05_lru_untrack_is_one_atomic_statement(pg_full: asyncpg.Pool) -> None:
    await pg_full.execute(
        "INSERT INTO instrument (symbol, name, is_tracked, tracked_reason, last_opened_at) "
        "VALUES ('A','A',true,'opened', now()),('B','B',true,'opened', now() - interval '1 day')"
    )
    spy = _SpyPool(pg_full)
    gone = await housekeeping.untrack_lru(spy, 1, dry_run=False)  # type: ignore[arg-type]
    assert gone == ["B"]
    assert len(spy.sql) == 1 and spy.sql[0].startswith("UPDATE instrument")
    # the UPDATE re-checks the exemptions itself (a row that gained a price meanwhile is skipped)
    assert "NOT EXISTS (SELECT 1 FROM price_daily" in spy.sql[0]
    assert "RETURNING" in spy.sql[0]


@pytest.mark.integration
async def test_hkx06_partial_refresh_job_with_remaining_work_is_kept(
    pg_full: asyncpg.Pool,
) -> None:
    await pg_full.execute(
        "INSERT INTO refresh_job (kind, target, status, requested_at, result) VALUES "
        "('post_import','batch:1','partial', now() - interval '100 days', '{\"remaining\":[\"AAA\"]}'),"
        "('post_import','batch:2','partial', now() - interval '100 days', '{\"remaining\":[]}'),"
        "('post_import','batch:3','ok', now() - interval '100 days', NULL)"
    )
    out = await run_housekeeping(pg_full, JobContext(job="housekeeping"), FakeNotifier())
    assert out["purged"]["refresh_job"] == 2
    assert await _scalar(pg_full, "SELECT target FROM refresh_job") == "batch:1"


@pytest.mark.integration
async def test_hkx07_a_full_run_leaves_every_owner_table_untouched(
    pg_full: asyncpg.Pool, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Before/after counts for every owner table across a complete run (also over the limit)."""
    monkeypatch.setenv("DB_SOFT_LIMIT_MB", "1")
    monkeypatch.setenv("OPENED_STOCKS_LRU_CAP", "1")
    await _seed_ops(pg_full)
    iid = int(
        await pg_full.fetchval(
            "INSERT INTO instrument (symbol, name, is_tracked, tracked_reason, last_opened_at) "
            "VALUES ('OWN','Own',true,'opened', now() - interval '900 days') RETURNING id"
        )
    )
    await _price(pg_full, iid)
    await pg_full.execute("INSERT INTO watchlist_item (instrument_id) VALUES ($1)", iid)
    await pg_full.execute(
        "INSERT INTO portfolio_txn (instrument_id, side, qty, price, trade_date) "
        "VALUES ($1,'buy',1,10,'2020-01-02')",
        iid,
    )
    ca = await pg_full.fetchval(
        "INSERT INTO corporate_action (instrument_id, ex_date, action_type, status, source) "
        "VALUES ($1,'2020-03-31','split','confirmed','manual') RETURNING id",
        iid,
    )
    await pg_full.execute(
        "INSERT INTO portfolio_adjustment (instrument_id, corporate_action_id, effective_date, "
        "qty_multiplier) VALUES ($1,$2,'2020-03-31',2)",
        iid,
        ca,
    )
    await pg_full.execute(
        "INSERT INTO alert (target_type, instrument_id, kind, params) "
        "VALUES ('stock', $1, 'price_above', '{}')",
        iid,
    )
    await pg_full.execute(
        "INSERT INTO fundamental_value (instrument_id, basis, period_type, period_end, metric_key, "
        "value, source) VALUES ($1,'consolidated','A','2020-03-31','pnl.revenue',1,'manual')",
        iid,
    )
    await pg_full.execute(
        "INSERT INTO shareholding (instrument_id, quarter_end, source) "
        "VALUES ($1,'2020-03-31','manual')",
        iid,
    )
    owner_tables = (
        "watchlist_item",
        "portfolio_txn",
        "portfolio_adjustment",
        "alert",
        "corporate_action",
        "price_daily",
        "fundamental_value",
        "shareholding",
        "instrument",
    )

    async def counts() -> dict[str, int]:
        return {t: int(await _scalar(pg_full, f"SELECT count(*) FROM {t}")) for t in owner_tables}  # noqa: S608

    before = await counts()
    assert all(n >= 1 for n in before.values())
    await run_housekeeping(pg_full, JobContext(job="housekeeping"), FakeNotifier())
    assert await counts() == before
    assert await _scalar(pg_full, "SELECT is_tracked FROM instrument WHERE symbol = 'OWN'") is True


def test_module_constants_follow_the_spec() -> None:
    assert housekeeping.DEFAULT_SOFT_LIMIT_MB == 380
    assert housekeeping.DEFAULT_LRU_CAP == 150
    assert housekeeping.LEVELS == ("ok", "70", "85", "95", "limit")
