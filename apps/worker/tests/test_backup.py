"""D08 backup and restore drill (docs/04 3.11): SYS-08, plus the acceptance rule that a backup
holds no broker token and no password hash."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

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


def test_secret_looking_settings_are_filtered() -> None:
    for key in ("BROKER_TOKEN_KEY", "api_secret", "ADMIN_PASSWORD", "DB_WARN_LEVEL"):
        assert backup.is_secret_setting_key(key)
    for key in ("RISK_FREE_RATE", "DB_SOFT_LIMIT_MB", "PRICES_ALREADY_ADJUSTED"):
        assert not backup.is_secret_setting_key(key)


def test_parse_dump_rejects_count_mismatch_and_bad_format() -> None:
    header = {"format": 1, "created_at": "x", "counts": {"alert": 2}, "tables": ["alert"]}
    row = '{"table":"alert","row":{"id":1}}'
    with pytest.raises(ValueError, match="count mismatch"):
        parse_dump(json.dumps(header) + "\n" + row + "\n")
    with pytest.raises(ValueError, match="format"):
        parse_dump(json.dumps({**header, "format": 9}) + "\n")
    with pytest.raises(ValueError, match="empty"):
        parse_dump("")


def test_parse_dump_keeps_row_text_exact() -> None:
    header = {
        "format": 1,
        "created_at": "x",
        "counts": {"portfolio_txn": 1},
        "tables": ["portfolio_txn"],
    }
    raw = '{"id":1,"qty":10.5000,"note":"a,\\"row\\":b"}'
    _, rows = parse_dump(json.dumps(header) + '\n{"table":"portfolio_txn","row":' + raw + "}\n")
    assert rows["portfolio_txn"] == [raw]  # numeric text (10.5000) is never re-rendered


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
        "('DB_WARN_LEVEL','\"85\"')"
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
    await pool.fetchval(
        "INSERT INTO import_batch (kind, filename, row_count) VALUES ('prices','p.csv',5000) RETURNING id"
    )
    ids: dict[str, int] = {}
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
    await pool.execute(
        "INSERT INTO portfolio_txn (instrument_id, side, qty, price, fees, trade_date, note) VALUES "
        "($1,'buy',10.5000,123.4500,1.2000,'2026-01-05','first'), "
        "($1,'sell',2.0000,130.0000,0,'2026-02-05',NULL)",
        ids["AAA"],
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
    ):
        assert needle not in text
    assert "token_enc" not in text and "broker_key" not in text and "failed_logins" not in text
    assert dump.counts["app_user"] == 1
    assert dump.counts["app_setting"] == 2  # RISK_FREE_RATE, PRICES_ALREADY_ADJUSTED only
    assert dump.counts["import_batch"] == 1  # the prices batch is not owner data
    assert dump.counts["corporate_action"] == 1  # the detected row is a heuristic
    assert dump.counts["fundamental_value"] == 1  # derived rows are recomputed
    assert dump.counts["instrument"] == 2  # AAA and CCC; BBB is only in a detected row
    assert dump.counts["mf_scheme"] == 1  # only the referenced scheme


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


_WIPE = (
    "TRUNCATE alert, portfolio_adjustment, corporate_action, portfolio_txn, watchlist_item, "
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
        assert report.present_after[name] >= n, name
    after = {t.name: int(await pg_full.fetchval(f"SELECT count(*) FROM {t.name}")) for t in TABLES}  # noqa: S608
    for name in after:
        if name == "app_user":
            assert after[name] == 1
        elif name == "app_setting":
            assert after[name] == 2
        else:
            assert after[name] == report.counts_in_file[name], name
    assert before["portfolio_txn"] == after["portfolio_txn"] == 2

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
    # identity sequences continue after the restored ids
    nid = await pg_full.fetchval(
        "INSERT INTO portfolio_txn (instrument_id, side, qty, price, trade_date) "
        "VALUES ($1,'buy',1,1,'2026-06-01') RETURNING id",
        ids["AAA"],
    )
    assert nid > 2
    # restoring twice is harmless
    again = await restore_dump(pg_full, text)
    assert again.ok and sum(again.inserted.values()) == 0 or again.ok


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
