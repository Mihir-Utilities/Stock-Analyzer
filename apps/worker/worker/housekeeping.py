"""``housekeeping`` (docs/04 3.10, manual price mode).

Imported price data is **never** deleted here, not even by size. The job only
* deletes expired operational rows (sessions, codes, OAuth states, jobs, runs, alert events,
  upload rows);
* un-tracks stocks tracked solely as ``opened`` that hold no imported prices and no owner data,
  beyond the LRU cap;
* deletes MF NAVs older than 12 months for schemes nobody opened or follows (never a scheme's
  newest NAV);
* measures the database against ``DB_SOFT_LIMIT_MB`` (an environment variable, the same source the
  API reads; the API computes ``db.warn_level`` itself) and sends one Telegram notice per 70/85/95 %
  crossing, remembering the highest announced level in ``app_setting.DB_WARN_NOTIFIED`` (SYS-02).

Every step is computed from data state, so a late or skipped cron simply catches up (SYS-03).
"""

from __future__ import annotations

import html
import json
import logging
import os
from dataclasses import dataclass
from typing import Any, Protocol

import asyncpg

from worker.db import create_pool
from worker.runner import JobContext

log = logging.getLogger("worker.housekeeping")

HOUSEKEEPING_TIMEOUT_S = 20 * 60  # docs/04 section 2
DEFAULT_SOFT_LIMIT_MB = 380
DEFAULT_LRU_CAP = 150

# warn levels in escalating order; "limit" = at or above 100 % (imports rejected by the API)
LEVELS = ("ok", "70", "85", "95", "limit")
_THRESHOLDS = ((100, "limit"), (95, "95"), (85, "85"), (70, "70"))
SETTING_NOTIFIED = "DB_WARN_NOTIFIED"

# (name, shared FROM/WHERE) so a dry run counts exactly what a run deletes.
_PURGES: tuple[tuple[str, str], ...] = (
    (
        "session",
        "FROM session WHERE (expires_at < now() - interval '7 days') "
        "OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '7 days')",
    ),
    ("telegram_link_code", "FROM telegram_link_code WHERE expires_at < now() - interval '1 day'"),
    ("broker_oauth_state", "FROM broker_oauth_state WHERE expires_at < now() - interval '1 day'"),
    (
        # a `partial` post_import with remaining symbols is still work for process_queued_jobs
        "refresh_job",
        "FROM refresh_job WHERE requested_at < now() - interval '90 days' "
        "AND status NOT IN ('queued','running') "
        "AND NOT (status = 'partial' AND coalesce(result->'remaining', '[]'::jsonb) "
        "NOT IN ('[]'::jsonb, 'null'::jsonb))",
    ),
    (
        "ingestion_run",
        "FROM ingestion_run WHERE started_at < now() - interval '180 days' AND status <> 'running'",
    ),
    ("alert_event", "FROM alert_event WHERE fired_at < now() - interval '400 days'"),
    ("import_upload", "FROM import_upload WHERE expires_at < now()"),
)

# Stocks tracked solely as `opened` that hold nothing of the owner's: no imported prices, not on
# the watchlist, no portfolio/alert/action/fundamental/shareholding rows (docs/04 3.10: owner data
# is never evicted). Written for the alias ``i`` so the same text guards the atomic UPDATE.
_LRU_EXEMPT = (
    "i.is_tracked AND i.tracked_reason = 'opened' "
    "AND NOT EXISTS (SELECT 1 FROM price_daily x WHERE x.instrument_id = i.id) "
    "AND NOT EXISTS (SELECT 1 FROM watchlist_item x WHERE x.instrument_id = i.id) "
    "AND NOT EXISTS (SELECT 1 FROM portfolio_txn x WHERE x.instrument_id = i.id) "
    "AND NOT EXISTS (SELECT 1 FROM portfolio_adjustment x WHERE x.instrument_id = i.id) "
    "AND NOT EXISTS (SELECT 1 FROM alert x WHERE x.instrument_id = i.id) "
    "AND NOT EXISTS (SELECT 1 FROM corporate_action x WHERE x.instrument_id = i.id "
    "AND NOT (x.source = 'detected' AND x.status = 'detected')) "
    "AND NOT EXISTS (SELECT 1 FROM fundamental_value x WHERE x.instrument_id = i.id "
    "AND x.source IN ('manual','csv_import','screener_import')) "
    "AND NOT EXISTS (SELECT 1 FROM shareholding x WHERE x.instrument_id = i.id)"
)
_LRU_BEYOND_CAP = (
    f"SELECT i.id FROM instrument i WHERE {_LRU_EXEMPT} "  # noqa: S608
    "ORDER BY i.last_opened_at DESC NULLS LAST, i.symbol OFFSET $1"
)

# MF NAVs older than 12 months (IST calendar) of schemes that are unopened: never opened
# (`last_opened_at IS NULL`; the API sets it when a scheme page is opened), not tracked, not on the
# watchlist, not an alert target and holds no mutual fund transactions (B15). A scheme's newest NAV
# is never deleted, so a scheme whose latest NAV is itself older than 12 months keeps it.
_MF_OLD_NAV = (
    "FROM mf_nav n WHERE n.nav_date < "
    "(((now() AT TIME ZONE 'Asia/Kolkata')::date) - interval '12 months')::date "
    "AND n.nav_date < (SELECT max(m.nav_date) FROM mf_nav m WHERE m.scheme_code = n.scheme_code) "
    "AND NOT EXISTS (SELECT 1 FROM mf_scheme s WHERE s.code = n.scheme_code "
    "AND (s.is_tracked OR s.last_opened_at IS NOT NULL)) "
    "AND NOT EXISTS (SELECT 1 FROM watchlist_item w WHERE w.mf_scheme_code = n.scheme_code) "
    "AND NOT EXISTS (SELECT 1 FROM alert a WHERE a.mf_scheme_code = n.scheme_code) "
    "AND NOT EXISTS (SELECT 1 FROM mf_txn x WHERE x.scheme_code = n.scheme_code)"
)


class Notifier(Protocol):
    async def send_html(self, text: str) -> None: ...


@dataclass(frozen=True)
class SizeVerdict:
    size_mb: float
    limit_mb: int
    level: str  # one of LEVELS
    notify: str | None  # threshold to announce now ("70", "85", "95") or None
    notified: str  # value to store as the highest announced level


def warn_level(size_mb: float, limit_mb: int) -> str:
    """Level for a database size: ok below 70 %, then 70, 85, 95, limit at 100 % and above."""
    if limit_mb <= 0:
        return "ok"
    pct = size_mb * 100.0 / limit_mb
    for threshold, name in _THRESHOLDS:
        if pct >= threshold:
            return name
    return "ok"


def judge_size(size_mb: float, limit_mb: int, last_notified: str) -> SizeVerdict:
    """One notice per crossing (SYS-02). A notice goes out when the level is a new, higher
    threshold than the last announced one; when the size falls the memory falls with it, so a
    later re-crossing announces again. ``limit`` is only a level (the API rejects imports); the
    95 % notice already warned the owner."""
    level = warn_level(size_mb, limit_mb)
    last = last_notified if last_notified in LEVELS else "ok"
    rank, last_rank = LEVELS.index(level), LEVELS.index(last)
    if rank > last_rank:
        announce = level if level != "limit" else (None if last_rank >= 3 else "95")
        return SizeVerdict(size_mb, limit_mb, level, announce, level)
    return SizeVerdict(size_mb, limit_mb, level, None, level if rank < last_rank else last)


def notice_text(size_mb: float, limit_mb: int, threshold: str) -> str:
    """Telegram text (parse_mode HTML): escaped as a whole, dynamic parts included."""
    pct = size_mb * 100.0 / limit_mb
    return html.escape(
        f"Database passed {threshold}% of the {limit_mb} MB limit: {size_mb:.0f} MB used "
        f"({pct:.0f}%). Imported prices are never deleted automatically; free space with "
        "Trim history or Delete prices in the Import center. At 100% price imports are "
        "rejected.",
        quote=False,
    )


async def _setting(pool: asyncpg.Pool, key: str) -> Any:
    raw = await pool.fetchval("SELECT value::text FROM app_setting WHERE key = $1", key)
    return None if raw is None else json.loads(raw)


def _positive_int(raw: object) -> int | None:
    try:
        value = int(str(raw).strip())
    except (TypeError, ValueError):
        return None
    return value if value > 0 else None


def soft_limit_mb() -> int:
    """``DB_SOFT_LIMIT_MB`` from the environment only: the API reads the same variable, so the
    worker and the Admin page cannot disagree. Empty or invalid falls back to 380."""
    return _positive_int(os.environ.get("DB_SOFT_LIMIT_MB", "")) or DEFAULT_SOFT_LIMIT_MB


async def _setting_int(pool: asyncpg.Pool, key: str, default: int) -> int:
    """Env var overrides the stored default (``.env.example``); invalid values fall back."""
    for candidate in (os.environ.get(key, "").strip(), await _setting(pool, key)):
        if candidate in (None, ""):
            continue
        value = _positive_int(candidate)
        if value is not None:
            return value
    return default


async def _put_setting(pool: asyncpg.Pool, key: str, value: Any) -> None:
    await pool.execute(
        "INSERT INTO app_setting (key, value) VALUES ($1, $2::jsonb) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
        key,
        json.dumps(value),
    )


async def purge_expired(pool: asyncpg.Pool, *, dry_run: bool) -> dict[str, int]:
    out: dict[str, int] = {}
    for name, where in _PURGES:
        if dry_run:
            out[name] = int(await pool.fetchval(f"SELECT count(*) {where}"))  # noqa: S608
        else:
            tag = await pool.execute(f"DELETE {where}")  # noqa: S608
            out[name] = int(tag.split()[-1])
    return out


async def untrack_lru(pool: asyncpg.Pool, cap: int, *, dry_run: bool) -> list[str]:
    """Un-track the least recently opened `opened`-only stocks beyond ``cap`` (derived rows only;
    imported, watchlist, portfolio and owner-data stocks are exempt). One UPDATE re-checks the
    exemptions, so a row that gains data meanwhile is skipped. Returns the symbols."""
    if dry_run:
        rows = await pool.fetch(
            f"SELECT i.symbol FROM instrument i WHERE i.id IN ({_LRU_BEYOND_CAP})",  # noqa: S608
            cap,
        )
    else:
        rows = await pool.fetch(
            "UPDATE instrument i SET is_tracked = false, tracked_reason = NULL, "  # noqa: S608
            f"updated_at = now() WHERE i.id IN ({_LRU_BEYOND_CAP}) AND {_LRU_EXEMPT} "
            "RETURNING i.symbol",
            cap,
        )
    return sorted(str(r["symbol"]) for r in rows)


async def trim_mf_navs(pool: asyncpg.Pool, *, dry_run: bool) -> int:
    if dry_run:
        return int(await pool.fetchval(f"SELECT count(*) {_MF_OLD_NAV}"))  # noqa: S608
    tag = await pool.execute(
        "DELETE FROM mf_nav WHERE (scheme_code, nav_date) IN "  # noqa: S608
        f"(SELECT n.scheme_code, n.nav_date {_MF_OLD_NAV})"
    )
    return int(tag.split()[-1])


async def db_size_mb(pool: asyncpg.Pool) -> float:
    return float(await pool.fetchval("SELECT pg_database_size(current_database())")) / 1048576


async def check_size(
    pool: asyncpg.Pool, notifier: Notifier | None, *, dry_run: bool
) -> dict[str, Any]:
    limit = soft_limit_mb()
    size_mb = await db_size_mb(pool)
    last = await _setting(pool, SETTING_NOTIFIED)
    verdict = judge_size(size_mb, limit, last if isinstance(last, str) else "ok")
    summary: dict[str, Any] = {
        "size_mb": round(size_mb, 1),
        "limit_mb": limit,
        "level": verdict.level,
        "notice": verdict.notify,
    }
    if dry_run:
        return summary
    notified = verdict.notified
    if verdict.notify and notifier is not None:
        await notifier.send_html(notice_text(size_mb, limit, verdict.notify))
        if getattr(notifier, "last_status", "sent") != "sent":
            # not delivered (no token, chat not linked, send failed): announce again next run
            notified = last if isinstance(last, str) and last in LEVELS else "ok"
            summary["notice"] = f"{verdict.notify}:undelivered"
    await _put_setting(pool, SETTING_NOTIFIED, notified)
    return summary


async def run_housekeeping(
    pool: asyncpg.Pool, ctx: JobContext, notifier: Notifier | None = None
) -> dict[str, Any]:
    dry = ctx.dry_run
    purged = await purge_expired(pool, dry_run=dry)
    cap = await _setting_int(pool, "OPENED_STOCKS_LRU_CAP", DEFAULT_LRU_CAP)
    untracked = await untrack_lru(pool, cap, dry_run=dry)
    mf_deleted = await trim_mf_navs(pool, dry_run=dry)
    size = await check_size(pool, notifier, dry_run=dry)
    ctx.add_rows(0 if dry else sum(purged.values()) + len(untracked) + mf_deleted)
    # counts only: no symbol names reach the run row, the log or the --dry-run print (S2)
    ctx.extra.update(
        {
            "purged": purged,
            "lru_untracked_count": len(untracked),
            "mf_nav_deleted": mf_deleted,
            "size": size,
        }
    )
    log.info("housekeeping done", extra={"dry_run": dry, "size_level": size["level"]})
    return {
        "purged": purged,
        "lru_untracked": untracked,
        "mf_nav_deleted": mf_deleted,
        "size": size,
    }


async def housekeeping_job(ctx: JobContext) -> None:
    from worker.notify import TelegramNotifier

    pool = await create_pool()
    try:
        await run_housekeeping(pool, ctx, TelegramNotifier(pool))
    finally:
        await pool.close()
