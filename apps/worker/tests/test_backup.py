"""D08 backup and restore drill (docs/04 3.11): SYS-08, plus the acceptance rule that a backup
holds no broker token and no password hash. Restore refuses a non-empty target and verifies every
row (HKX-10..HKX-17)."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import stat
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import asyncpg
import pytest

from worker import backup
from worker.backup import (
    TABLES,
    Dump,
    build_dump,
    decrypt,
    encrypt,
    parse_dump,
    restore_dump,
    run_backup,
    valid_age_recipient,
)
from worker.runner import JobContext

pytestmark = pytest.mark.anyio

PUBLIC = "age1" + "q" * 58
PRIVATE = "AGE-SECRET-KEY-1" + "Q" * 58
HASH = "$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHQ$hashhashhashhashhashhashhashhash"
TOKEN_ENC = b"SECRET-BROKER-TOKEN-CIPHERTEXT"
ALL_TABLES = [t.name for t in TABLES]


def fake_age(args: list[str], data: bytes) -> bytes:
    """Stands in for the age binary: 'encrypts' by wrapping, 'decrypts' by unwrapping."""
    if args[0] == "-r":
        return b"AGE-FAKE:" + data[::-1]
    assert args[0] == "-d"
    assert data.startswith(b"AGE-FAKE:")
    return data[len(b"AGE-FAKE:") :][::-1]


# --------------------------------------------------------------------------- pure
def test_recipient_must_be_a_public_key() -> None:
    assert valid_age_recipient(PUBLIC)
    assert not valid_age_recipient(PRIVATE)
    assert not valid_age_recipient("")
    assert not valid_age_recipient("age1short")


def test_encrypt_refuses_private_key_and_never_calls_age() -> None:
    called: list[object] = []
    with pytest.raises(ValueError, match="public key"):
        encrypt(Dump("x", {}), PRIVATE, lambda a, d: called.append(a) or b"")
    assert called == []


def test_spec_never_lists_secret_columns_or_tables() -> None:
    backup.assert_no_secret_columns()
    names = {t.name for t in TABLES}
    for forbidden in ("broker_session", "broker_oauth_state", "session", "telegram_link_code"):
        assert forbidden not in names
    app_user = next(t for t in TABLES if t.name == "app_user")
    assert "password_hash" not in app_user.columns


def test_mf_ledger_tables_are_exported_in_dependency_order() -> None:
    """MFH-F61 (D08 amendment, B15): the MF ledger and the fund-name mapping join the dump."""
    names = [t.name for t in TABLES]
    assert {"mf_txn", "mf_fund_name_map"} <= set(names)
    for dep, table in (
        ("mf_scheme", "mf_txn"),
        ("import_batch", "mf_txn"),
        ("mf_scheme", "mf_fund_name_map"),
    ):
        assert names.index(dep) < names.index(table)  # restore order = dependency order
    mf_txn = next(t for t in TABLES if t.name == "mf_txn")
    assert {"dedupe_key", "import_batch_id", "folio", "stamp_duty"} <= set(mf_txn.columns)
    assert dict(mf_txn.exprs).keys() == {
        "import_batch_id"
    }  # a prices batch reference is exported as NULL
    assert (
        "mf_txn" in backup._REFERENCED_SCHEMES and "mf_fund_name_map" in backup._REFERENCED_SCHEMES
    )


def test_jrn21_journal_notes_are_exported_after_the_transactions_they_link() -> None:
    """JRN-21 (B20): the decision journal is owner data, exported with its instruments, no secrets."""
    names = [t.name for t in TABLES]
    assert "journal_note" in names
    for dep in ("instrument", "portfolio_txn"):
        assert names.index(dep) < names.index("journal_note")  # restore order = dependency order
    spec = next(t for t in TABLES if t.name == "journal_note")
    assert spec.identity and spec.pk == "id"  # ids and the identity sequence survive a restore
    assert {
        "note_text",
        "price_at_note",
        "price_as_of",
        "review_on",
        "status",
        "portfolio_txn_id",
    } <= set(spec.columns)
    assert not backup.FORBIDDEN_COLUMNS.intersection(spec.columns)
    assert (
        "FROM journal_note" in backup._REFERENCED_INSTRUMENTS
    )  # a note keeps its stock in the dump


def test_only_allow_listed_settings_are_backed_up() -> None:
    for key in ("BROKER_TOKEN_KEY", "api_secret", "ADMIN_PASSWORD", "DB_WARN_NOTIFIED", "new_key"):
        assert not backup.is_backed_up_setting_key(key)
    for key in ("RISK_FREE_RATE", "DB_SOFT_LIMIT_MB", "PRICES_ALREADY_ADJUSTED"):
        assert backup.is_backed_up_setting_key(key)
    backup.assert_setting_allow_list_is_safe()  # no key of the list looks like a secret


def test_allow_list_guard_fails_on_a_secret_looking_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(backup, "BACKUP_SETTING_KEYS", (*backup.BACKUP_SETTING_KEYS, "api_token"))
    with pytest.raises(RuntimeError, match="secret-looking"):
        backup.assert_setting_allow_list_is_safe()


def test_parse_dump_rejects_count_mismatch_and_bad_format() -> None:
    header = {"format": 1, "created_at": "x", "counts": {"alert": 2}, "tables": ALL_TABLES}
    row = '{"table":"alert","row":{"id":1}}'
    with pytest.raises(ValueError, match="count mismatch"):
        parse_dump(json.dumps(header) + "\n" + row + "\n")
    with pytest.raises(ValueError, match="format"):
        parse_dump(json.dumps({**header, "format": 9}) + "\n")
    with pytest.raises(ValueError, match="empty"):
        parse_dump("")


def test_parse_dump_requires_every_table_in_the_header() -> None:
    short = {"format": 1, "created_at": "x", "counts": {}, "tables": ALL_TABLES[:-1]}
    with pytest.raises(ValueError, match="lacks table"):
        parse_dump(json.dumps(short) + "\n")
    extra = {"format": 1, "created_at": "x", "counts": {}, "tables": [*ALL_TABLES, "session"]}
    with pytest.raises(ValueError, match="unknown table"):
        parse_dump(json.dumps(extra) + "\n")


def test_parse_dump_keeps_row_text_exact() -> None:
    header = {
        "format": 1,
        "created_at": "x",
        "counts": {"portfolio_txn": 1},
        "tables": ALL_TABLES,
    }
    raw = '{"id":1,"qty":10.5000,"note":"a,\\"row\\":b"}'
    _, rows = parse_dump(json.dumps(header) + '\n{"table":"portfolio_txn","row":' + raw + "}\n")
    assert rows["portfolio_txn"] == [raw]  # numeric text (10.5000) is never re-rendered


# --------------------------------------------------------------------------- age (stub and real)
def _write_stub_age(directory: Path) -> None:
    """A fake `age` executable on PATH: echoes its argv and the reversed stdin; STUB_AGE_FAIL fails."""
    script = directory / "age_stub.py"
    script.write_text(
        "import os, sys\n"
        "if os.environ.get('STUB_AGE_FAIL'):\n"
        "    sys.stderr.write('age: error: bad thing token=123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ0123\\n')\n"
        "    sys.stderr.write('second line that is dropped\\n')\n"
        "    sys.exit(3)\n"
        "data = sys.stdin.buffer.read()\n"
        "sys.stdout.buffer.write(('ARGS:' + ' '.join(sys.argv[1:]) + '|').encode() + data[::-1])\n",
        encoding="utf-8",
    )
    if sys.platform == "win32":
        (directory / "age.cmd").write_text(f'@"{sys.executable}" "{script}" %*\n', encoding="utf-8")
    else:
        exe = directory / "age"
        exe.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{script}" "$@"\n', encoding="utf-8")
        exe.chmod(exe.stat().st_mode | stat.S_IEXEC)


def test_run_age_calls_the_binary_with_a_fixed_argv_and_stdin(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_stub_age(tmp_path)
    monkeypatch.setenv("PATH", str(tmp_path) + os.pathsep + os.environ["PATH"])
    out = backup.run_age(["-r", PUBLIC], b"abc")
    assert out == f"ARGS:-r {PUBLIC}|".encode() + b"cba"


def test_run_age_failure_keeps_a_scrubbed_first_line_only(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_stub_age(tmp_path)
    monkeypatch.setenv("PATH", str(tmp_path) + os.pathsep + os.environ["PATH"])
    monkeypatch.setenv("STUB_AGE_FAIL", "1")
    with pytest.raises(RuntimeError) as err:
        backup.run_age(["-r", PUBLIC], b"abc")
    msg = str(err.value)
    assert "exit code 3" in msg and "bad thing" in msg
    assert "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123" not in msg  # scrubbed
    assert "second line" not in msg


def test_run_age_without_the_binary_says_so(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(shutil, "which", lambda name: None)
    with pytest.raises(RuntimeError, match="not installed"):
        backup.run_age(["-r", PUBLIC], b"x")


@pytest.mark.skipif(
    shutil.which("age") is None or shutil.which("age-keygen") is None,
    reason="the age binary is not installed (apt install age)",
)
def test_real_age_round_trip(tmp_path: Path) -> None:
    key = tmp_path / "key.txt"
    subprocess.run(  # noqa: S603
        [shutil.which("age-keygen") or "", "-o", str(key)], capture_output=True, check=True
    )
    public = next(
        ln.split(":", 1)[1].strip()
        for ln in key.read_text().splitlines()
        if ln.lower().startswith("# public key:")
    )
    assert valid_age_recipient(public)
    blob = encrypt(Dump("hello owner data\n", {}), public)
    assert b"hello owner data" not in blob and blob.startswith(b"age-encryption.org")
    assert decrypt(blob, str(key)) == "hello owner data\n"
    with pytest.raises(RuntimeError, match="age failed"):
        decrypt(b"not an age file", str(key))


async def test_backup_needs_a_key_and_dry_run_does_not(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("AGE_PUBLIC_KEY", raising=False)
    with pytest.raises(RuntimeError, match="AGE_PUBLIC_KEY"):
        await backup.backup_user_data_job(JobContext(job="backup_user_data"))
    assert not list(tmp_path.iterdir())


# --------------------------------------------------------------------------- DB (SYS-08)
async def _seed_owner_data(pool: asyncpg.Pool) -> dict[str, int]:
    await pool.execute(
        "INSERT INTO app_user (password_hash, telegram_chat_id, quiet_hours, display_prefs, "
        'failed_logins) VALUES ($1, 4242, \'{"start":"22:00","end":"07:00","tz":"Asia/Kolkata"}\', '
        '\'{"theme":"light"}\', 3)',
        HASH,
    )
    await pool.execute(
        "INSERT INTO app_setting (key, value) VALUES ('RISK_FREE_RATE','0.071'), "
        "('PRICES_ALREADY_ADJUSTED','true'), ('BROKER_TOKEN_KEY','\"leak\"'), "
        "('DB_WARN_NOTIFIED','\"85\"'), ('unlisted_key','\"x\"')"
    )
    await pool.execute(
        "INSERT INTO broker_session (broker, token_enc, expires_at) "
        "VALUES ('angelone', $1, now() + interval '1 day')",
        TOKEN_ENC,
    )
    await pool.execute(
        "INSERT INTO session (token_hash, expires_at) VALUES ('\\xdeadbeef', now() + interval '1 day')"
    )
    batch = int(
        await pool.fetchval(
            "INSERT INTO import_batch (kind, filename, row_count, note) "
            "VALUES ('corporate_actions','ca.csv',1,'per filing') RETURNING id"
        )
    )
    prices_batch = int(
        await pool.fetchval(
            "INSERT INTO import_batch (kind, filename, row_count) "
            "VALUES ('prices','p.csv',5000) RETURNING id"
        )
    )
    ids: dict[str, int] = {"batch": batch, "prices_batch": prices_batch}
    for sym in ("AAA", "BBB", "CCC"):
        ids[sym] = int(
            await pool.fetchval(
                "INSERT INTO instrument (symbol, name, broker_key, broker_ok, is_tracked, tracked_reason) "
                "VALUES ($1, $1, 'NSE_EQ|SECRETKEY', true, true, 'imported') RETURNING id",
                sym,
            )
        )
    await pool.execute(  # prices are not backed up
        "INSERT INTO price_daily (instrument_id, trade_date, open, high, low, close, adj_close, source) "
        "VALUES ($1,'2026-01-02',10,11,9,10,10,'import')",
        ids["AAA"],
    )
    await pool.execute("INSERT INTO mf_scheme (code, name) VALUES (100,'Fund A'), (200,'Fund B')")
    await pool.execute(
        "INSERT INTO watchlist_item (instrument_id, note) VALUES ($1,'watch')", ids["AAA"]
    )
    await pool.execute("INSERT INTO watchlist_item (mf_scheme_code) VALUES (100)")
    # B15: mutual fund ledger (synthetic) and the fund-name mapping; scheme 300 is referenced only by them.
    await pool.execute("INSERT INTO mf_scheme (code, name) VALUES (300,'Fund C')")
    mf_batch = int(
        await pool.fetchval(
            "INSERT INTO import_batch (kind, filename, row_count) "
            "VALUES ('mf_statement','s.csv',2) RETURNING id"
        )
    )
    ids["mf_batch"] = mf_batch
    await pool.execute(
        "INSERT INTO mf_txn (scheme_code, folio, txn_type, txn_date, units, nav, amount, stamp_duty, "
        "source, note) VALUES (300,'12345/67','sip','2026-01-05',12.3450,81.0000,999.9500,0.0500,"
        "'manual','m1')"
    )
    await pool.execute(
        "INSERT INTO mf_txn (scheme_code, folio, txn_type, txn_date, units, nav, amount, stamp_duty, "
        "source, fund_name, fund_name_key, dedupe_key, import_batch_id) VALUES "
        "(300,'12345/67','purchase','2026-02-05',12.1000,82.6400,999.9400,0.0500,'import','Alpha Fund',"
        "'alpha fund','dk-1',$1), "
        "(300,'12345/67','purchase','2026-02-05',12.1000,82.6400,999.9400,0.0500,'import','Alpha Fund',"
        "'alpha fund','dk-2',$2)",
        mf_batch,
        prices_batch,  # a batch that is not exported: the reference is exported as NULL
    )
    await pool.execute(
        "INSERT INTO mf_fund_name_map (fund_name_key, fund_name, scheme_code, audit_note) "
        "VALUES ('alpha fund','Alpha Fund',300,'remapped 2026-11-11: 100 -> 300 (2 rows)')"
    )
    await pool.execute(
        "INSERT INTO portfolio_txn (instrument_id, side, qty, price, fees, trade_date, note) VALUES "
        "($1,'buy',10.5000,123.4500,1.2000,'2026-01-05','first'), "
        "($1,'sell',2.0000,130.0000,0,'2026-02-05',NULL)",
        ids["AAA"],
    )
    # B20: decision journal. DDD is referenced only by a note (the dump must keep it); one note links a txn.
    ids["DDD"] = int(
        await pool.fetchval(
            "INSERT INTO instrument (symbol, name, is_tracked, tracked_reason) "
            "VALUES ('DDD','DDD',true,'opened') RETURNING id"
        )
    )
    buy_id = int(await pool.fetchval("SELECT id FROM portfolio_txn WHERE side='buy'"))
    await pool.execute(
        "INSERT INTO journal_note (instrument_id, noted_on, note_text, price_at_note, price_as_of, "
        "review_on, status, reviewed_at, portfolio_txn_id) VALUES "
        "($1,'2026-01-05','Bought for the margin recovery <b>thesis</b> & M&M',123.4500,'2026-01-02',"
        "'2026-07-01','open',NULL,$2), "
        "($1,'2026-02-06','Second note, reviewed',NULL,NULL,NULL,'reviewed','2026-03-01T10:00:00+00',NULL), "
        "($3,'2026-02-07','Only watching',NULL,NULL,NULL,'open',NULL,NULL)",
        ids["AAA"],
        buy_id,
        ids["DDD"],
    )
    ca = int(
        await pool.fetchval(
            "INSERT INTO corporate_action (instrument_id, ex_date, action_type, status, ratio_num, "
            "ratio_den, source, import_batch_id) VALUES ($1,'2026-03-01','split','confirmed',5,1,"
            "'csv_import',$2) RETURNING id",
            ids["AAA"],
            batch,
        )
    )
    await pool.execute(  # heuristic, unconfirmed: not owner-entered
        "INSERT INTO corporate_action (instrument_id, ex_date, action_type, status, source) "
        "VALUES ($1,'2026-04-01','split_or_bonus','detected','detected')",
        ids["BBB"],
    )
    await pool.execute(
        "INSERT INTO portfolio_adjustment (instrument_id, corporate_action_id, effective_date, "
        "qty_multiplier, note) VALUES ($1,$2,'2026-03-01',5.00000000,'override')",
        ids["AAA"],
        ca,
    )
    await pool.execute(
        "INSERT INTO alert (target_type, instrument_id, kind, params) "
        "VALUES ('stock', $1, 'price_above', '{\"threshold\": 150.25}')",
        ids["AAA"],
    )
    await pool.execute(
        "INSERT INTO alert (target_type, mf_scheme_code, kind, params) "
        "VALUES ('mf', 100, 'nav_above', '{\"threshold\": 12.5}')"
    )
    await pool.execute(
        "INSERT INTO fundamental_value (instrument_id, basis, period_type, period_end, metric_key, "
        "value, source, import_batch_id) VALUES ($1,'consolidated','A','2025-03-31','pnl.revenue',"
        "1234.5,'manual',$2), ($1,'consolidated','A','2025-03-31','ratio.roe',12.3,'derived',NULL)",
        ids["CCC"],
        batch,
    )
    await pool.execute(
        "INSERT INTO shareholding (instrument_id, quarter_end, promoter_pct, source) "
        "VALUES ($1,'2025-12-31',55.5,'manual')",
        ids["CCC"],
    )
    return ids


@pytest.mark.integration
async def test_backup_has_no_broker_token_or_password_hash(pg_full: asyncpg.Pool) -> None:
    await _seed_owner_data(pg_full)
    dump = await build_dump(pg_full, now=datetime(2026, 11, 8, tzinfo=UTC))
    text = dump.text
    for needle in (
        HASH,
        "argon2id",
        "deadbeef",
        "SECRET-BROKER",
        "SECRETKEY",
        "leak",
        "password_hash",
        "DB_WARN_NOTIFIED",
        "unlisted_key",
    ):
        assert needle not in text
    assert "token_enc" not in text and "broker_key" not in text and "failed_logins" not in text
    assert dump.counts["app_user"] == 1
    assert dump.counts["app_setting"] == 2  # RISK_FREE_RATE, PRICES_ALREADY_ADJUSTED only
    assert (
        dump.counts["import_batch"] == 2
    )  # corporate_actions + mf_statement; the prices batch is not owner data
    assert dump.counts["corporate_action"] == 1  # the detected row is a heuristic
    assert dump.counts["fundamental_value"] == 1  # derived rows are recomputed
    assert (
        dump.counts["instrument"] == 3
    )  # AAA, CCC and DDD (a journal note); BBB is only a detected row
    assert dump.counts["journal_note"] == 3  # JRN-21
    assert dump.counts["mf_scheme"] == 2  # the watchlisted scheme and the scheme of the MF ledger
    assert dump.counts["mf_txn"] == 3 and dump.counts["mf_fund_name_map"] == 1  # MFH-F61


@pytest.mark.integration
async def test_hkx10_settings_sql_path_exports_only_the_allow_list(pg_full: asyncpg.Pool) -> None:
    """Every key of the allow-list is exported; secret-looking and unknown keys never are."""
    for key in backup.BACKUP_SETTING_KEYS:
        await pg_full.execute("INSERT INTO app_setting (key, value) VALUES ($1, '1')", key)
    for key in ("MY_API_TOKEN", "hmac_key", "DB_WARN_NOTIFIED", "DB_WARN_LEVEL", "brand_new"):
        await pg_full.execute("INSERT INTO app_setting (key, value) VALUES ($1, '\"s3\"')", key)
    dump = await build_dump(pg_full)
    exported = {
        json.loads(ln)["row"]["key"]
        for ln in dump.text.splitlines()[1:]
        if json.loads(ln)["table"] == "app_setting"
    }
    assert exported == set(backup.BACKUP_SETTING_KEYS)
    assert "s3" not in dump.text


@pytest.mark.integration
async def test_hkx11_corporate_action_batch_of_an_excluded_prices_batch_is_nulled(
    pg_full: asyncpg.Pool,
) -> None:
    ids = await _seed_owner_data(pg_full)
    await pg_full.execute(
        "INSERT INTO corporate_action (instrument_id, ex_date, action_type, status, ratio_num, "
        "ratio_den, source, import_batch_id) VALUES ($1,'2026-05-01','bonus','confirmed',1,1,"
        "'manual',$2)",
        ids["AAA"],
        ids["prices_batch"],
    )
    dump = await build_dump(pg_full)
    rows = [
        json.loads(ln)["row"]
        for ln in dump.text.splitlines()[1:]
        if json.loads(ln)["table"] == "corporate_action"
    ]
    by_type = {r["action_type"]: r["import_batch_id"] for r in rows}
    assert by_type == {
        "split": ids["batch"],
        "bonus": None,
    }  # kept batch stays, prices batch nulled
    # and the dump restores into a clean database without a dangling reference
    await pg_full.execute(_WIPE)
    report = await restore_dump(pg_full, dump.text)
    assert report.ok, report.problems
    assert await pg_full.fetchval("SELECT count(*) FROM corporate_action") == 2


@pytest.mark.integration
async def test_backup_file_is_ciphertext_only(pg_full: asyncpg.Pool, tmp_path: Path) -> None:
    await _seed_owner_data(pg_full)
    ctx = JobContext(job="backup_user_data")
    path = await run_backup(
        pg_full,
        ctx,
        recipient=PUBLIC,
        out_dir=tmp_path,
        runner=fake_age,
        now=datetime(2026, 11, 8, tzinfo=UTC),
    )
    assert path is not None and path.name == "user_data-20261108.jsonl.age"
    assert [p.name for p in tmp_path.iterdir()] == [path.name]  # no plaintext sibling
    assert path.read_bytes().startswith(b"AGE-FAKE:")
    assert b"portfolio_txn" not in path.read_bytes()  # only the wrapped (reversed) payload
    assert ctx.rows_written == sum(ctx.extra["counts"].values())


@pytest.mark.integration
async def test_backup_dry_run_writes_nothing(pg_full: asyncpg.Pool, tmp_path: Path) -> None:
    await _seed_owner_data(pg_full)
    ctx = JobContext(job="backup_user_data", dry_run=True)
    out = await run_backup(pg_full, ctx, recipient="", out_dir=tmp_path / "x", runner=fake_age)
    assert out is None and not (tmp_path / "x").exists()
    assert ctx.extra["counts"]["portfolio_txn"] == 2


@pytest.mark.integration
async def test_backup_job_dry_run_needs_no_key_and_writes_nothing(
    pg_full: asyncpg.Pool, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The real job function in dry-run mode: no AGE_PUBLIC_KEY, no file, counts reported."""
    await _seed_owner_data(pg_full)
    monkeypatch.delenv("AGE_PUBLIC_KEY", raising=False)
    monkeypatch.setenv("BACKUP_OUT_DIR", str(tmp_path / "out"))

    class _Keep:
        async def close(self) -> None:
            return None

        def __getattr__(self, name: str) -> Any:
            return getattr(pg_full, name)

    async def fake_pool(dsn: str | None = None) -> Any:
        return _Keep()

    monkeypatch.setattr(backup, "create_pool", fake_pool)
    ctx = JobContext(job="backup_user_data", dry_run=True)
    await backup.backup_user_data_job(ctx)
    assert not (tmp_path / "out").exists()
    assert ctx.extra["counts"]["portfolio_txn"] == 2 and ctx.rows_written == 0


_WIPE = (
    "TRUNCATE alert, portfolio_adjustment, corporate_action, journal_note, portfolio_txn, mf_txn, mf_fund_name_map, watchlist_item, "
    "fundamental_value, shareholding, import_batch, instrument, mf_scheme, app_setting, app_user, "
    "price_daily RESTART IDENTITY CASCADE"
)


@pytest.mark.integration
async def test_sys08_restore_drill_encrypted_dump_counts_and_values(
    pg_full: asyncpg.Pool, tmp_path: Path
) -> None:
    ids = await _seed_owner_data(pg_full)
    before = {t.name: int(await pg_full.fetchval(f"SELECT count(*) FROM {t.name}")) for t in TABLES}  # noqa: S608
    path = await run_backup(
        pg_full,
        JobContext(job="backup_user_data"),
        recipient=PUBLIC,
        out_dir=tmp_path,
        runner=fake_age,
    )
    assert path is not None

    # disaster: a new empty database, the seed has created the owner row with a NEW password
    await pg_full.execute(_WIPE)
    await pg_full.execute("INSERT INTO app_user (password_hash) VALUES ('NEW-HASH-FROM-SEED')")
    await pg_full.execute("INSERT INTO app_setting (key, value) VALUES ('RISK_FREE_RATE','0.065')")

    text = decrypt(path.read_bytes(), "owner.key", fake_age)
    verify = await restore_dump(pg_full, text, dry_run=True)
    assert verify.ok and verify.counts_in_file["portfolio_txn"] == 2
    assert (
        await pg_full.fetchval("SELECT count(*) FROM portfolio_txn") == 0
    )  # dry run wrote nothing

    report = await restore_dump(pg_full, text)
    assert report.ok, report.problems
    for name, n in report.counts_in_file.items():
        spec = next(t for t in TABLES if t.name == name)
        if not spec.seeded:
            assert report.inserted[name] == report.present_after[name] == n, name
    after = {t.name: int(await pg_full.fetchval(f"SELECT count(*) FROM {t.name}")) for t in TABLES}  # noqa: S608
    for name in after:
        if name == "app_user":
            assert after[name] == 1
        elif name == "app_setting":
            assert after[name] == 2
        else:
            assert after[name] == report.counts_in_file[name], name
    assert before["portfolio_txn"] == after["portfolio_txn"] == 2
    assert before["mf_txn"] == after["mf_txn"] == 3  # MFH-F61: the MF ledger round-trips

    mf_rows = await pg_full.fetch(
        "SELECT units, nav, amount, stamp_duty, folio, dedupe_key, import_batch_id FROM mf_txn ORDER BY id"
    )
    assert [str(mf_rows[0][k]) for k in ("units", "nav", "amount", "stamp_duty")] == [
        "12.3450",
        "81.0000",
        "999.9500",
        "0.0500",
    ]
    assert mf_rows[0]["folio"] == "12345/67" and mf_rows[0]["dedupe_key"] is None
    assert mf_rows[1]["dedupe_key"] == "dk-1" and mf_rows[1]["import_batch_id"] is not None
    assert mf_rows[2]["dedupe_key"] == "dk-2" and mf_rows[2]["import_batch_id"] is None
    assert (
        await pg_full.fetchval(
            "SELECT scheme_code FROM mf_fund_name_map WHERE fund_name_key='alpha fund'"
        )
        == 300
    )

    # values survive exactly
    txn = await pg_full.fetchrow(
        "SELECT qty, price, fees, note FROM portfolio_txn WHERE side='buy'"
    )
    assert (str(txn["qty"]), str(txn["price"]), str(txn["fees"]), txn["note"]) == (
        "10.5000",
        "123.4500",
        "1.2000",
        "first",
    )
    assert (
        await pg_full.fetchval("SELECT value #>> '{}' FROM app_setting WHERE key='RISK_FREE_RATE'")
        == "0.071"
    )
    assert (
        await pg_full.fetchval("SELECT params->>'threshold' FROM alert WHERE kind='price_above'")
        == "150.25"
    )
    assert (
        await pg_full.fetchval("SELECT qty_multiplier::text FROM portfolio_adjustment")
        == "5.00000000"
    )
    # FKs and ids intact
    assert await pg_full.fetchval("SELECT id FROM instrument WHERE symbol='AAA'") == ids["AAA"]
    assert (
        await pg_full.fetchval(
            "SELECT count(*) FROM portfolio_adjustment a JOIN corporate_action c ON c.id = a.corporate_action_id"
        )
        == 1
    )
    # the owner row keeps the NEW password, gets the profile back
    user = await pg_full.fetchrow(
        "SELECT password_hash, telegram_chat_id, display_prefs::text d FROM app_user"
    )
    assert user["password_hash"] == "NEW-HASH-FROM-SEED"  # noqa: S105
    assert user["telegram_chat_id"] == 4242 and "light" in user["d"]
    # prices are not part of the backup
    assert await pg_full.fetchval("SELECT count(*) FROM price_daily") == 0
    # JRN-22: the journal keeps ids, text, price, dates, status and the link; its sequence continues
    notes = await pg_full.fetch(
        "SELECT id, instrument_id, note_text, price_at_note::text p, price_as_of::text pd, "
        "review_on::text r, status, reviewed_at IS NOT NULL done, portfolio_txn_id FROM journal_note ORDER BY id"
    )
    assert [n["id"] for n in notes] == [1, 2, 3]
    assert notes[0]["note_text"] == "Bought for the margin recovery <b>thesis</b> & M&M"
    assert (notes[0]["p"], notes[0]["pd"], notes[0]["r"], notes[0]["status"]) == (
        "123.4500",
        "2026-01-02",
        "2026-07-01",
        "open",
    )
    assert notes[0]["portfolio_txn_id"] == await pg_full.fetchval(
        "SELECT id FROM portfolio_txn WHERE side='buy'"
    )
    assert notes[1]["status"] == "reviewed" and notes[1]["done"] and notes[1]["p"] is None
    assert notes[2]["instrument_id"] == await pg_full.fetchval(
        "SELECT id FROM instrument WHERE symbol='DDD'"
    )
    jid = await pg_full.fetchval(
        "INSERT INTO journal_note (instrument_id, noted_on, note_text) "
        "VALUES ($1,'2026-06-01','after restore') RETURNING id",
        ids["AAA"],
    )
    assert jid == 4
    # identity sequences continue after the restored ids
    nid = await pg_full.fetchval(
        "INSERT INTO portfolio_txn (instrument_id, side, qty, price, trade_date) "
        "VALUES ($1,'buy',1,1,'2026-06-01') RETURNING id",
        ids["AAA"],
    )
    assert nid > 2


@pytest.mark.integration
async def test_hkx12_second_restore_is_refused_and_changes_nothing(pg_full: asyncpg.Pool) -> None:
    """Restoring twice is NOT harmless any more: the second run finds owner data and refuses."""
    await _seed_owner_data(pg_full)
    dump = await build_dump(pg_full)
    await pg_full.execute(_WIPE)
    first = await restore_dump(pg_full, dump.text)
    assert first.ok, first.problems
    snapshot = {t.name: await pg_full.fetch(f"SELECT * FROM {t.name}") for t in TABLES}  # noqa: S608
    again = await restore_dump(pg_full, dump.text)
    assert not again.ok
    assert any("refused" in p and "instrument" in p for p in again.problems)
    for t in TABLES:
        assert await pg_full.fetch(f"SELECT * FROM {t.name}") == snapshot[t.name], t.name  # noqa: S608
    dry = await restore_dump(pg_full, dump.text, dry_run=True)
    assert not dry.ok and "owner data" in dry.problems[0]  # the dry run says so before the real run


@pytest.mark.integration
async def test_hkx13_id_collision_instrument_1_aaa_vs_existing_1_xyz_fails_and_rolls_back(
    pg_full: asyncpg.Pool,
) -> None:
    """The old ON CONFLICT DO NOTHING let owner rows attach to the wrong instrument."""
    await _seed_owner_data(pg_full)
    dump = await build_dump(pg_full)
    await pg_full.execute(_WIPE)
    await pg_full.execute("INSERT INTO app_user (password_hash) VALUES ('SEED')")
    await pg_full.execute(
        "INSERT INTO instrument (id, symbol, name) OVERRIDING SYSTEM VALUE VALUES (1,'XYZ','Other')"
    )
    assert (
        (await pg_full.fetchval("SELECT id FROM instrument WHERE symbol = 'XYZ'") == 1)
        and '"symbol":"AAA"' in dump.text.replace(" ", "")
        and '"id":1,' in dump.text.replace(" ", "")
    )
    # 1. default: refused up front, nothing touched
    report = await restore_dump(pg_full, dump.text)
    assert not report.ok and "refused" in report.problems[0]
    assert await pg_full.fetchval("SELECT count(*) FROM portfolio_txn") == 0
    assert await pg_full.fetchval("SELECT symbol FROM instrument") == "XYZ"
    # 2. even when the emptiness check is bypassed: the collision aborts and rolls back
    with pytest.raises(asyncpg.UniqueViolationError):
        await restore_dump(pg_full, dump.text, require_empty=False)
    assert await pg_full.fetchval("SELECT count(*) FROM import_batch") == 0  # earlier tables undone
    assert await pg_full.fetchval("SELECT count(*) FROM instrument") == 1


@pytest.mark.integration
async def test_hkx14_verification_catches_a_silently_swallowed_conflict(
    pg_full: asyncpg.Pool, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Defence in depth: even if an insert skipped a row (DO NOTHING), the per-row check fails
    and the restore rolls back. The old lower-bound count check passed here."""
    await _seed_owner_data(pg_full)
    dump = await build_dump(pg_full)
    await pg_full.execute(_WIPE)
    await pg_full.execute("INSERT INTO app_user (password_hash) VALUES ('SEED')")
    await pg_full.execute(
        "INSERT INTO instrument (id, symbol, name) OVERRIDING SYSTEM VALUE VALUES (1,'XYZ','Other')"
    )
    original = backup._insert_sql

    def lenient(spec: backup.TableSpec) -> str:
        sql = original(spec)
        return sql if "ON CONFLICT" in sql else sql + " ON CONFLICT DO NOTHING"

    monkeypatch.setattr(backup, "_insert_sql", lenient)
    report = await restore_dump(pg_full, dump.text, require_empty=False)
    assert not report.ok
    assert any(p.startswith("instrument:") for p in report.problems)
    # rolled back: only the pre-existing XYZ row remains, no owner rows
    assert await pg_full.fetchval("SELECT count(*) FROM instrument") == 1
    assert await pg_full.fetchval("SELECT count(*) FROM watchlist_item") == 0
    assert await pg_full.fetchval("SELECT symbol FROM instrument WHERE id = 1") == "XYZ"


@pytest.mark.integration
async def test_hkx15_sequence_is_never_lowered_below_its_current_value(
    pg_full: asyncpg.Pool,
) -> None:
    await _seed_owner_data(pg_full)
    dump = await build_dump(pg_full)
    await pg_full.execute(_WIPE)
    await pg_full.execute("SELECT setval(pg_get_serial_sequence('portfolio_txn','id'), 1000)")
    report = await restore_dump(pg_full, dump.text)
    assert report.ok, report.problems
    nid = await pg_full.fetchval(
        "INSERT INTO portfolio_txn (instrument_id, side, qty, price, trade_date) "
        "SELECT id,'buy',1,1,'2026-06-01' FROM instrument LIMIT 1 RETURNING id"
    )
    assert nid > 1000


@pytest.mark.integration
async def test_restore_without_a_seeded_owner_row_locks_the_login(pg_full: asyncpg.Pool) -> None:
    await _seed_owner_data(pg_full)
    dump = await build_dump(pg_full)
    await pg_full.execute(_WIPE)
    report = await restore_dump(pg_full, dump.text)
    assert report.ok
    stored = await pg_full.fetchval("SELECT password_hash FROM app_user")
    assert stored == backup.RESTORE_PLACEHOLDER_HASH and not stored.startswith("$argon2")


@pytest.mark.integration
async def test_restore_is_atomic_when_a_row_cannot_be_inserted(pg_full: asyncpg.Pool) -> None:
    await _seed_owner_data(pg_full)
    dump = await build_dump(pg_full)
    await pg_full.execute(_WIPE)
    broken = dump.text.replace('"side": "buy"', '"side": "hold"', 1)
    with pytest.raises(asyncpg.PostgresError):
        await restore_dump(pg_full, broken)
    assert await pg_full.fetchval("SELECT count(*) FROM instrument") == 0  # rolled back


# --------------------------------------------------------------------------- restore CLI
def _cli_args(file: Path, *, identity: str | None = None, dry_run: bool = True) -> Any:
    return argparse.Namespace(file=str(file), identity=identity, dry_run=dry_run)


async def test_hkx16_cli_refuses_an_age_file_without_identity(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    blob = tmp_path / "user_data-20261108.jsonl.age"
    blob.write_bytes(b"AGE-FAKE:xx")
    assert await backup._restore_cli(_cli_args(blob)) == 2
    assert "--identity" in capsys.readouterr().err


@pytest.mark.integration
async def test_hkx17_cli_warns_loudly_on_a_plaintext_restore(
    pg_full: asyncpg.Pool,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    await _seed_owner_data(pg_full)
    dump = await build_dump(pg_full)
    await pg_full.execute(_WIPE)
    plain = tmp_path / "user_data.jsonl"
    plain.write_text(dump.text, encoding="utf-8")

    class _Keep:
        async def close(self) -> None:
            return None

        def __getattr__(self, name: str) -> Any:
            return getattr(pg_full, name)

    async def fake_pool(dsn: str | None = None) -> Any:
        return _Keep()

    monkeypatch.setattr(backup, "create_pool", fake_pool)
    assert await backup._restore_cli(_cli_args(plain)) == 0
    captured = capsys.readouterr()
    assert "PLAINTEXT" in captured.err
    assert json.loads(captured.out)["ok"] is True


@pytest.mark.integration
async def test_every_column_is_exported_or_deliberately_excluded(pg_full: asyncpg.Pool) -> None:
    """A new column on an exported table fails here until it is exported or excluded on purpose."""
    for spec in TABLES:
        cols = {
            r["column_name"]
            for r in await pg_full.fetch(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_schema='public' AND table_name=$1",
                spec.name,
            )
        }
        missing = cols - set(spec.columns) - backup.EXCLUDED_COLUMNS.get(spec.name, frozenset())
        assert not missing, f"{spec.name}: {sorted(missing)}"
        assert set(spec.columns) <= cols, spec.name
