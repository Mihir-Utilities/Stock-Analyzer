"""``backup_user_data`` and the restore drill (docs/04 3.11).

Exports the owner's own data as JSON lines, encrypts it with ``age`` to the owner's **public**
key and writes only the ciphertext. The plaintext goes to ``age`` over stdin and never touches
the disk. What is never exported: ``broker_session``, ``broker_oauth_state``, ``session``,
``password_hash``, login counters, any ``app_setting`` whose key looks like a secret, prices and
every derived table. Restore needs the private key, which only the owner holds.

File format (one JSON object per line, UTF-8):
  line 1  ``{"format": 1, "created_at": ..., "counts": {table: n}, "tables": [...]}``
  others  ``{"table": "<name>", "row": {...}}``   (``row`` is the Postgres ``to_jsonb`` text)
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import re
import shutil
import subprocess  # noqa: S404 - runs the local `age` binary with a fixed argument list
import sys
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import asyncpg

from worker.db import create_pool
from worker.runner import JobContext

log = logging.getLogger("worker.backup")

BACKUP_TIMEOUT_S = 10 * 60  # docs/04 section 2
FORMAT_VERSION = 1
BATCH = 2000

# An age X25519 public recipient. A private key ("AGE-SECRET-KEY-1...") is refused on purpose.
_AGE_PUBLIC = re.compile(r"^age1[02-9ac-hj-np-z]{58}$")
# app_setting keys that must never leave the database (defence in depth: none is expected).
_SECRET_KEY = re.compile(r"(token|secret|password|passwd|credential|private|hmac|key)", re.I)
_DERIVED_SETTINGS = ("DB_WARN_LEVEL", "DB_WARN_NOTIFIED")  # recomputed by housekeeping
# Column names that must never be exported (asserted over the table spec).
FORBIDDEN_COLUMNS = frozenset(
    {"password_hash", "token_enc", "token_hash", "state_hash", "code_hash", "broker_key"}
)
RESTORE_PLACEHOLDER_HASH = "!restore-reset-required"  # not an argon2id string: cannot log in


@dataclass(frozen=True)
class TableSpec:
    name: str
    columns: tuple[str, ...]
    where: str = "true"
    order_by: str = "1"
    conflict: str = "ON CONFLICT DO NOTHING"
    identity: bool = False  # has a GENERATED ALWAYS identity column to override on restore
    pk: str | None = None  # identity column to re-sync after restore


_REFERENCED_INSTRUMENTS = (
    "SELECT instrument_id FROM watchlist_item WHERE instrument_id IS NOT NULL "
    "UNION SELECT instrument_id FROM portfolio_txn "
    "UNION SELECT instrument_id FROM portfolio_adjustment "
    "UNION SELECT instrument_id FROM alert WHERE instrument_id IS NOT NULL "
    "UNION SELECT instrument_id FROM corporate_action "
    "WHERE NOT (source = 'detected' AND status = 'detected') "
    "UNION SELECT instrument_id FROM fundamental_value "
    "WHERE source IN ('manual','csv_import','screener_import') "
    "UNION SELECT instrument_id FROM shareholding"
)
_REFERENCED_SCHEMES = (
    "SELECT mf_scheme_code FROM watchlist_item WHERE mf_scheme_code IS NOT NULL "
    "UNION SELECT mf_scheme_code FROM alert WHERE mf_scheme_code IS NOT NULL"
)

# Restore order = dependency order.
TABLES: tuple[TableSpec, ...] = (
    TableSpec(
        "import_batch",
        (
            "id",
            "kind",
            "upload_group",
            "filename",
            "sha256",
            "row_count",
            "warning_count",
            "note",
            "created_at",
            "undone_at",
        ),
        where="kind <> 'prices'",
        identity=True,
        pk="id",
    ),
    TableSpec(
        "instrument",
        (
            "id",
            "symbol",
            "name",
            "isin",
            "series",
            "listing_date",
            "face_value",
            "sector",
            "industry",
            "company_type",
            "status",
            "instrument_kind",
            "is_tracked",
            "tracked_reason",
            "last_opened_at",
            "last_seen_in_master",
            "created_at",
            "updated_at",
        ),
        where=f"id IN ({_REFERENCED_INSTRUMENTS})",
        identity=True,
        pk="id",
    ),
    TableSpec(
        "mf_scheme",
        (
            "code",
            "name",
            "fund_house",
            "scheme_type",
            "category",
            "plan",
            "option_type",
            "isin_growth",
            "isin_div_reinvest",
            "status",
            "is_tracked",
            "last_opened_at",
            "last_nav_date",
            "updated_at",
        ),
        where=f"code IN ({_REFERENCED_SCHEMES})",
    ),
    TableSpec(
        "app_setting",
        ("key", "value", "updated_at"),
        where=(
            "key !~* '(token|secret|password|passwd|credential|private|hmac|key)' "
            "AND key NOT IN ('DB_WARN_LEVEL','DB_WARN_NOTIFIED')"
        ),
        conflict=(
            "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "
            "updated_at = EXCLUDED.updated_at"  # the owner's value wins over the seed default
        ),
    ),
    TableSpec(
        "app_user",
        ("id", "telegram_chat_id", "quiet_hours", "display_prefs", "created_at"),
        conflict=(
            "ON CONFLICT (id) DO UPDATE SET telegram_chat_id = EXCLUDED.telegram_chat_id, "
            "quiet_hours = EXCLUDED.quiet_hours, display_prefs = EXCLUDED.display_prefs"
        ),  # password_hash, failed_logins and locked_until of an existing row are not touched
    ),
    TableSpec(
        "watchlist_item",
        ("id", "instrument_id", "mf_scheme_code", "note", "added_at"),
        identity=True,
        pk="id",
    ),
    TableSpec(
        "portfolio_txn",
        (
            "id",
            "instrument_id",
            "side",
            "qty",
            "price",
            "fees",
            "trade_date",
            "note",
            "created_at",
            "updated_at",
        ),
        identity=True,
        pk="id",
    ),
    TableSpec(
        "corporate_action",
        (
            "id",
            "instrument_id",
            "ex_date",
            "record_date",
            "action_type",
            "status",
            "ratio_num",
            "ratio_den",
            "amount_per_share",
            "purpose_text",
            "parsed_ok",
            "source",
            "import_batch_id",
        ),
        where="NOT (source = 'detected' AND status = 'detected')",
        identity=True,
        pk="id",
    ),
    TableSpec(
        "portfolio_adjustment",
        (
            "id",
            "instrument_id",
            "corporate_action_id",
            "effective_date",
            "qty_multiplier",
            "note",
        ),
        identity=True,
        pk="id",
    ),
    TableSpec(
        "alert",
        (
            "id",
            "target_type",
            "instrument_id",
            "mf_scheme_code",
            "kind",
            "params",
            "status",
            "one_shot",
            "cooldown_minutes",
            "expires_on",
            "last_fired_at",
            "last_state",
            "created_at",
        ),
        identity=True,
        pk="id",
    ),
    TableSpec(
        "fundamental_value",
        (
            "instrument_id",
            "basis",
            "period_type",
            "period_end",
            "metric_key",
            "value",
            "unit",
            "source",
            "import_batch_id",
            "filed_on",
            "fetched_at",
        ),
        where="source IN ('manual','csv_import','screener_import')",
    ),
    TableSpec(
        "shareholding",
        (
            "instrument_id",
            "quarter_end",
            "promoter_pct",
            "fii_pct",
            "dii_pct",
            "mf_pct",
            "insurance_pct",
            "govt_pct",
            "public_pct",
            "other_pct",
            "promoter_pledged_pct",
            "shareholders_count",
            "filed_on",
            "revision",
            "source",
            "import_batch_id",
            "fetched_at",
        ),
    ),
)
_SPEC = {t.name: t for t in TABLES}

# Columns deliberately left out, per exported table (the guard test compares with the schema).
EXCLUDED_COLUMNS: dict[str, frozenset[str]] = {
    "instrument": frozenset({"broker_key", "broker_ok", "broker_checked_at"}),
    "app_user": frozenset({"password_hash", "failed_logins", "locked_until"}),
}


def assert_no_secret_columns() -> None:
    for spec in TABLES:
        bad = FORBIDDEN_COLUMNS.intersection(spec.columns)
        if bad:
            raise RuntimeError(f"backup exports forbidden columns {sorted(bad)} in {spec.name}")


def is_secret_setting_key(key: str) -> bool:
    return bool(_SECRET_KEY.search(key)) or key in _DERIVED_SETTINGS


def valid_age_recipient(value: str) -> bool:
    return bool(_AGE_PUBLIC.fullmatch(value.strip()))


def _select(spec: TableSpec) -> str:
    cols = ", ".join(spec.columns)
    return (
        f"SELECT to_jsonb(t)::text AS j FROM (SELECT {cols} FROM {spec.name} "  # noqa: S608
        f"WHERE {spec.where}) t ORDER BY j"
    )


@dataclass(frozen=True)
class Dump:
    text: str  # the JSON-lines document (plaintext: never written to disk)
    counts: dict[str, int]


async def build_dump(pool: asyncpg.Pool, *, now: datetime | None = None) -> Dump:
    assert_no_secret_columns()
    lines: list[str] = []
    counts: dict[str, int] = {}
    async with pool.acquire() as conn, conn.transaction(isolation="repeatable_read", readonly=True):
        for spec in TABLES:
            rows = await conn.fetch(_select(spec))
            counts[spec.name] = len(rows)
            prefix = json.dumps({"table": spec.name}, separators=(",", ":"))[:-1] + ',"row":'
            lines.extend(f"{prefix}{r['j']}}}" for r in rows)
    header = {
        "format": FORMAT_VERSION,
        "created_at": (now or datetime.now(UTC)).isoformat(),
        "counts": counts,
        "tables": [t.name for t in TABLES],
    }
    return Dump("\n".join([json.dumps(header, separators=(",", ":")), *lines]) + "\n", counts)


# --------------------------------------------------------------------------- age
AgeRunner = Callable[[list[str], bytes], bytes]


def run_age(args: list[str], data: bytes) -> bytes:
    exe = shutil.which("age")
    if exe is None:
        raise RuntimeError("the `age` binary is not installed (see docs/RUNBOOK.md, backups)")
    proc = subprocess.run(  # noqa: S603 - fixed argv, no shell; data goes over stdin
        [exe, *args], input=data, capture_output=True, check=False, timeout=120
    )
    if proc.returncode != 0:
        # age error text never contains key material, but keep the message short anyway
        raise RuntimeError(f"age failed with exit code {proc.returncode}")
    return proc.stdout


def encrypt(dump: Dump, recipient: str, runner: AgeRunner = run_age) -> bytes:
    """Encrypt to a public recipient only; a private key or garbage is refused."""
    recipient = recipient.strip()
    if not valid_age_recipient(recipient):
        raise ValueError("AGE_PUBLIC_KEY must be an age public key (age1...); never a private key")
    return runner(["-r", recipient], dump.text.encode("utf-8"))


# --------------------------------------------------------------------------- restore
@dataclass(frozen=True)
class RestoreReport:
    counts_in_file: dict[str, int]
    inserted: dict[str, int]
    present_after: dict[str, int]
    ok: bool
    problems: list[str]


def parse_dump(text: str) -> tuple[dict[str, Any], dict[str, list[str]]]:
    """Header and raw row JSON per table. Raises ``ValueError`` on a malformed or short file."""
    lines = [ln for ln in text.splitlines() if ln.strip()]
    if not lines:
        raise ValueError("empty backup file")
    header = json.loads(lines[0])
    if header.get("format") != FORMAT_VERSION:
        raise ValueError(f"unsupported backup format {header.get('format')!r}")
    rows: dict[str, list[str]] = {name: [] for name in header["tables"]}
    for line in lines[1:]:
        cut = line.index(',"row":')
        table = json.loads(line[:cut] + "}")["table"]
        if table not in rows:
            raise ValueError(f"unknown table {table!r} in backup")
        rows[table].append(line[cut + len(',"row":') : -1])
    for name, n in header["counts"].items():
        if len(rows.get(name, [])) != n:
            got = len(rows.get(name, []))
            raise ValueError(f"count mismatch for {name}: header {n}, file {got}")
    return header, rows


def _insert_sql(spec: TableSpec) -> str:
    cols = ", ".join(spec.columns)
    override = " OVERRIDING SYSTEM VALUE" if spec.identity else ""
    sql = (
        f"INSERT INTO {spec.name} ({cols}){override} "  # noqa: S608
        f"SELECT {cols} FROM jsonb_populate_recordset(null::{spec.name}, $1::jsonb) "
        f"{spec.conflict}"
    )
    if spec.name == "app_user":  # no password in the file: a locked placeholder, reset via seed
        sql = sql.replace(
            f"INSERT INTO app_user ({cols})",
            f"INSERT INTO app_user (password_hash, {cols})",
        ).replace(f"SELECT {cols}", f"SELECT '{RESTORE_PLACEHOLDER_HASH}', {cols}")
    return sql


async def restore_dump(pool: asyncpg.Pool, text: str, *, dry_run: bool = False) -> RestoreReport:
    """Restore into a database that has the schema (and ideally the seed): one transaction,
    ``ON CONFLICT`` per table, then counts are verified against the file header (SYS-08)."""
    header, rows = parse_dump(text)
    counts_in_file = {name: len(r) for name, r in rows.items()}
    inserted: dict[str, int] = {}
    present: dict[str, int] = {}
    problems: list[str] = []
    if dry_run:
        return RestoreReport(counts_in_file, {}, {}, True, [])
    async with pool.acquire() as conn, conn.transaction():
        for name in header["tables"]:
            spec = _SPEC[name]
            before = int(await conn.fetchval(f"SELECT count(*) FROM {name}"))  # noqa: S608
            for i in range(0, len(rows[name]), BATCH):
                payload = "[" + ",".join(rows[name][i : i + BATCH]) + "]"
                await conn.execute(_insert_sql(spec), payload)
            after = int(await conn.fetchval(f"SELECT count(*) FROM {name}"))  # noqa: S608
            inserted[name] = after - before
            present[name] = after
            if after < counts_in_file[name]:
                problems.append(f"{name}: {after} rows present, file has {counts_in_file[name]}")
            if spec.pk is not None:
                await conn.execute(
                    f"SELECT setval(pg_get_serial_sequence('{name}', '{spec.pk}'), "  # noqa: S608
                    f"GREATEST((SELECT COALESCE(max({spec.pk}), 1) FROM {name}), 1))"
                )
    return RestoreReport(counts_in_file, inserted, present, not problems, problems)


def decrypt(blob: bytes, identity_file: str, runner: AgeRunner = run_age) -> str:
    return runner(["-d", "-i", identity_file], blob).decode("utf-8")


# --------------------------------------------------------------------------- job
def backup_filename(now: datetime) -> str:
    return f"user_data-{now.strftime('%Y%m%d')}.jsonl.age"


async def run_backup(
    pool: asyncpg.Pool,
    ctx: JobContext,
    *,
    recipient: str,
    out_dir: Path,
    runner: AgeRunner = run_age,
    now: datetime | None = None,
) -> Path | None:
    """Build, encrypt and write. Dry run: build and count only (no key needed, nothing written)."""
    moment = now or datetime.now(UTC)
    dump = await build_dump(pool, now=moment)
    ctx.extra["counts"] = dump.counts
    ctx.items_total = len(dump.counts)
    if ctx.dry_run:
        return None
    blob = encrypt(dump, recipient, runner)
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / backup_filename(moment)
    path.write_bytes(blob)
    ctx.add_rows(sum(dump.counts.values()))
    ctx.extra["file"] = path.name
    ctx.extra["bytes"] = len(blob)
    return path


async def backup_user_data_job(ctx: JobContext) -> None:
    recipient = os.environ.get("AGE_PUBLIC_KEY", "").strip()
    if not recipient and not ctx.dry_run:
        raise RuntimeError("AGE_PUBLIC_KEY is not set: refusing to create an unencrypted backup")
    pool = await create_pool()
    try:
        await run_backup(
            pool,
            ctx,
            recipient=recipient,
            out_dir=Path(os.environ.get("BACKUP_OUT_DIR", "backup-out")),
        )
    finally:
        await pool.close()


# --------------------------------------------------------------------------- restore CLI
async def _restore_cli(args: argparse.Namespace) -> int:
    path = Path(args.file)
    if args.identity:
        text = decrypt(path.read_bytes(), args.identity)
    else:
        text = path.read_text(encoding="utf-8")
    pool = await create_pool()
    try:
        report = await restore_dump(pool, text, dry_run=args.dry_run)
    finally:
        await pool.close()
    print(
        json.dumps(
            {
                "ok": report.ok,
                "dry_run": bool(args.dry_run),
                "counts_in_file": report.counts_in_file,
                "inserted": report.inserted,
                "problems": report.problems,
            }
        )
    )
    return 0 if report.ok else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m worker.backup")
    sub = parser.add_subparsers(dest="command", required=True)
    rest = sub.add_parser("restore", help="restore a backup into DATABASE_URL (restore drill)")
    rest.add_argument("file", help="decrypted .jsonl, or the .age file with --identity")
    rest.add_argument("--identity", default=None, help="age private key file (stays with you)")
    rest.add_argument("--dry-run", action="store_true", help="verify the file only")
    args = parser.parse_args(sys.argv[1:] if argv is None else argv)
    return asyncio.run(_restore_cli(args))


if __name__ == "__main__":
    raise SystemExit(main())
