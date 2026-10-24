"""Mutual fund jobs (docs/04 3.5, 3.6): ``sync_mf_schemes``, ``ingest_mf_navs``, ``mf_refresh``.

Logic is written against small Protocols (``MfStore``, list/history/AMFI sources) so unit tests run
on fixtures with in-memory fakes; ``PgMfStore`` is the production store (parameterised SQL,
``INSERT ... ON CONFLICT``). The cache document comes from ``worker.analytics.mf``.
"""

from __future__ import annotations

import json
import logging
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any, Protocol

import asyncpg

from worker.adapters.amfi import (
    DEFAULT_MIN_INTERVAL_S as AMFI_INTERVAL,
)
from worker.adapters.amfi import (
    AmfiClient,
    AmfiFile,
)
from worker.adapters.base import NotFound, SchemaError, build_guard
from worker.adapters.mfapi import (
    DEFAULT_MIN_INTERVAL_S as MFAPI_INTERVAL,
)
from worker.adapters.mfapi import (
    MfapiClient,
    NavHistory,
    NavPoint,
    SchemeList,
    SchemeListItem,
    SchemeMeta,
)
from worker.analytics.mf import DEFAULT_RISK_FREE, compute_mf_metrics, nav_jumps
from worker.db import PgSourceHealthStore
from worker.egress import make_client
from worker.errors import RetryableError, SourceDisabled
from worker.jobs import HttpJob, HttpJobResult
from worker.marketdate import ist_today
from worker.runner import JobContext

TRACKED_CAP = 150  # docs/04 3.5
log = logging.getLogger(__name__)

INACTIVE_AFTER_DAYS = 60  # docs/04 3.6; MF-06
UPSERT_CHUNK = 5000
# D04R-1: status changes need a plausible AMFI file (a truncated or header-only file must not
# mark ~38k schemes inactive): at least this many rows AND at least this fraction of the previous
# successfully applied file.
AMFI_MIN_ROWS = 5000
AMFI_MIN_FRACTION = 0.5
SOURCE_ERRORS = (RetryableError, SourceDisabled, SchemaError)
SYNC_ERRORS = (*SOURCE_ERRORS, NotFound)


class SchemeListSource(Protocol):
    async def list_schemes(self) -> SchemeList: ...


class NavSource(Protocol):
    async def nav_history(
        self, code: int, start: date | None = None, end: date | None = None
    ) -> NavHistory: ...


class AmfiSource(Protocol):
    async def latest_navs(self) -> AmfiFile: ...


class MfStore(Protocol):
    async def upsert_list(self, items: list[SchemeListItem]) -> int: ...
    async def apply_amfi(self, amfi: AmfiFile) -> int: ...
    async def scheme_state(self) -> dict[int, tuple[str, date | None]]: ...
    async def set_status(self, changes: list[tuple[int, str]]) -> None: ...
    async def tracked_codes(self, limit: int, only: list[int] | None) -> list[int]: ...
    async def scheme_exists(self, code: int) -> bool: ...
    async def last_nav_date(self, code: int) -> date | None: ...
    async def upsert_navs(self, code: int, points: list[NavPoint]) -> int: ...
    async def update_meta(self, code: int, meta: SchemeMeta, last_nav: date | None) -> None: ...
    async def load_series(self, code: int) -> tuple[list[date], list[float]]: ...
    async def save_cache(self, code: int, as_of: date, metrics: dict[str, Any]) -> None: ...
    async def risk_free_rate(self) -> float: ...
    async def previous_amfi_rows(self) -> int | None: ...


def decide_status(amfi_date: date | None, last_nav: date | None, today: date, current: str) -> str:
    """MF-06 / MF-18: inactive when the freshest known NAV date is missing or > 60 days old.

    The freshest of the AMFI value date (scheme listed in the file) and ``last_nav_date`` counts;
    a scheme absent from AMFI with no stored NAV has no evidence of life and is inactive.
    """
    known = [d for d in (amfi_date, last_nav) if d is not None]
    if not known:
        return "inactive"
    return "inactive" if max(known) < today - timedelta(days=INACTIVE_AFTER_DAYS) else "active"


# --------------------------------------------------------------------------- sync_mf_schemes
async def run_sync_mf_schemes(
    ctx: JobContext,
    store: MfStore,
    mfapi: SchemeListSource,
    amfi: AmfiSource,
    today: date,
) -> None:
    listing: SchemeList | None = None
    amfi_file: AmfiFile | None = None
    try:
        listing = await mfapi.list_schemes()
    except SYNC_ERRORS as exc:
        ctx.extra["mfapi_error"] = type(exc).__name__
    try:
        amfi_file = await amfi.latest_navs()
    except SYNC_ERRORS as exc:
        ctx.extra["amfi_error"] = type(exc).__name__  # a bad file keeps the old data (MF-19)
    if listing is None and amfi_file is None:
        raise RuntimeError("both mfapi and AMFI are unavailable; nothing was written")
    if listing is None:
        ctx.mark_partial("mfapi_unavailable")
    if amfi_file is None:
        ctx.mark_partial("amfi_unavailable")
    if listing is not None:
        ctx.extra["schemes_listed"] = len(listing.items)
        ctx.extra["list_rejected"] = listing.rejected
    if amfi_file is not None:
        ctx.extra["amfi_rows"] = len(amfi_file.rows)
        ctx.extra["amfi_rejected"] = amfi_file.rejected
        ctx.extra["amfi_reject_reasons"] = amfi_file.reasons
        ctx.extra["amfi_duplicates"] = amfi_file.duplicates  # last row of a code wins
    if ctx.dry_run:
        return
    if listing is not None:
        for i in range(0, len(listing.items), UPSERT_CHUNK):
            ctx.add_rows(await store.upsert_list(listing.items[i : i + UPSERT_CHUNK]))
    if amfi_file is not None:
        ctx.add_rows(await store.apply_amfi(amfi_file))
        # Only a plausible, successfully parsed AMFI file may change status (D04R-1).
        previous = await store.previous_amfi_rows()
        n_rows = len(amfi_file.rows)
        floor = max(AMFI_MIN_ROWS, int(AMFI_MIN_FRACTION * previous) if previous else 0)
        if n_rows < floor:
            ctx.extra["status_skipped"] = (
                f"amfi_rows_below_floor: {n_rows} < {floor} (previous {previous})"
            )
            ctx.mark_partial("amfi_implausibly_small")
            log.warning("sync_mf_schemes: status changes refused", extra={"rows": n_rows})
            return
        amfi_dates = {r.code: r.nav_date for r in amfi_file.rows}
        changes: list[tuple[int, str]] = []
        for code, (status, last_nav) in (await store.scheme_state()).items():
            new = decide_status(amfi_dates.get(code), last_nav, today, status)
            if new != status:
                changes.append((code, new))
        await store.set_status(changes)
        ctx.extra["amfi_status_rows"] = n_rows  # read back by previous_amfi_rows
        ctx.extra["status_changed"] = len(changes)
        ctx.extra["now_inactive"] = sum(1 for _, s in changes if s == "inactive")


# --------------------------------------------------------------------------- ingest_mf_navs
class _LazyAmfi:
    """One AMFI download per run, only when mfapi fails (MF-09)."""

    def __init__(self, source: AmfiSource) -> None:
        self._source = source
        self._file: AmfiFile | None = None

    async def get(self) -> AmfiFile:
        if self._file is None:
            self._file = await self._source.latest_navs()
        return self._file


async def ingest_scheme(
    ctx: JobContext,
    store: MfStore,
    mfapi: NavSource,
    amfi: _LazyAmfi,
    code: int,
    today: date,
    risk_free: float,
) -> None:
    if not await store.scheme_exists(code):
        raise LookupError(f"scheme {code} is not in mf_scheme")
    last = await store.last_nav_date(code)
    # Re-fetch the last stored date too: a corrected NAV for it is refreshed (idempotent upsert).
    start = last

    points: list[NavPoint] = []
    meta: SchemeMeta | None = None
    if start is None or start <= today:
        try:
            hist = await mfapi.nav_history(code, start, today if start else None)
            points, meta = hist.points, hist.meta
            if hist.rejected:
                ctx.extra.setdefault("nav_rejected", {})[str(code)] = hist.rejected
        except SOURCE_ERRORS as exc:
            # MF-09: mfapi down -> AMFI latest NAV; history stays from the DB (stale chip in UI).
            row = (await amfi.get()).by_code().get(code)
            if row is None:
                raise
            points = [NavPoint(row.nav_date, row.nav)]
            ctx.extra.setdefault("amfi_fallback", []).append(code)
            ctx.extra["mfapi_error"] = type(exc).__name__
            ctx.mark_partial("mfapi_unavailable_amfi_fallback")
    if ctx.dry_run:
        ctx.add_rows(0)
        ctx.extra.setdefault("would_write", {})[str(code)] = len(points)
        return
    if points:
        ctx.add_rows(await store.upsert_navs(code, points))
    dates, navs = await store.load_series(code)
    if meta is not None or dates:
        await store.update_meta(
            code,
            meta or SchemeMeta(None, None, None, None, None, None, None),
            dates[-1] if dates else None,
        )
    metrics = compute_mf_metrics(dates, navs, risk_free=risk_free)
    if metrics is not None:
        await store.save_cache(code, dates[-1], metrics)
    new_dates = {p.nav_date for p in points}
    flagged = [j for j in nav_jumps(dates, navs) if date.fromisoformat(j["date"]) in new_dates]
    if flagged:  # MF-08: kept, flagged in details
        ctx.extra.setdefault("nav_jumps", {})[str(code)] = flagged


async def run_ingest_mf_navs(
    ctx: JobContext,
    store: MfStore,
    mfapi: NavSource,
    amfi: AmfiSource,
    today: date,
    only: list[int] | None = None,
) -> None:
    codes = await store.tracked_codes(TRACKED_CAP, only)
    risk_free = await store.risk_free_rate()
    lazy = _LazyAmfi(amfi)

    async def one(code: int) -> None:
        await ingest_scheme(ctx, store, mfapi, lazy, code, today, risk_free)

    await ctx.for_each(codes, one)


# --------------------------------------------------------------------------- production store
class PgMfStore:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool

    async def upsert_list(self, items: list[SchemeListItem]) -> int:
        await self._pool.execute(
            "INSERT INTO mf_scheme (code, name, isin_growth, isin_div_reinvest, plan, option_type) "
            "SELECT * FROM unnest($1::int[], $2::text[], $3::text[], $4::text[], $5::text[], "
            "$6::text[]) "
            "ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, "
            "isin_growth = COALESCE(EXCLUDED.isin_growth, mf_scheme.isin_growth), "
            "isin_div_reinvest = COALESCE(EXCLUDED.isin_div_reinvest, "
            "mf_scheme.isin_div_reinvest), "
            "plan = EXCLUDED.plan, option_type = EXCLUDED.option_type, updated_at = now()",
            [i.code for i in items],
            [i.name for i in items],
            [i.isin_growth for i in items],
            [i.isin_div_reinvest for i in items],
            [i.plan for i in items],
            [i.option_type for i in items],
        )
        return len(items)

    async def apply_amfi(self, amfi: AmfiFile) -> int:
        rows = amfi.rows
        for i in range(0, len(rows), UPSERT_CHUNK):
            chunk = rows[i : i + UPSERT_CHUNK]
            await self._pool.execute(
                "INSERT INTO mf_scheme (code, name, fund_house, scheme_type, category, plan, "
                "option_type, isin_growth, isin_div_reinvest) "
                "SELECT * FROM unnest($1::int[], $2::text[], $3::text[], $4::text[], $5::text[], "
                "$6::text[], $7::text[], $8::text[], $9::text[]) "
                "ON CONFLICT (code) DO UPDATE SET fund_house = EXCLUDED.fund_house, "
                "scheme_type = EXCLUDED.scheme_type, category = EXCLUDED.category, "
                "plan = CASE WHEN mf_scheme.plan IS NULL OR mf_scheme.plan = 'unknown' "
                "  THEN EXCLUDED.plan ELSE mf_scheme.plan END, "
                "option_type = CASE WHEN mf_scheme.option_type IS NULL "
                "  OR mf_scheme.option_type = 'unknown' "
                "  THEN EXCLUDED.option_type ELSE mf_scheme.option_type END, "
                "isin_growth = COALESCE(mf_scheme.isin_growth, EXCLUDED.isin_growth), "
                "isin_div_reinvest = COALESCE(mf_scheme.isin_div_reinvest, "
                "  EXCLUDED.isin_div_reinvest), updated_at = now()",
                [r.code for r in chunk],
                [r.name for r in chunk],
                [r.fund_house for r in chunk],
                [r.scheme_type for r in chunk],
                [r.category for r in chunk],
                [r.plan for r in chunk],
                [r.option_type for r in chunk],
                [r.isin_growth for r in chunk],
                [r.isin_div_reinvest for r in chunk],
            )
        return len(rows)

    async def scheme_state(self) -> dict[int, tuple[str, date | None]]:
        rows = await self._pool.fetch("SELECT code, status, last_nav_date FROM mf_scheme")
        return {int(r["code"]): (r["status"], r["last_nav_date"]) for r in rows}

    async def set_status(self, changes: list[tuple[int, str]]) -> None:
        for i in range(0, len(changes), UPSERT_CHUNK):
            chunk = changes[i : i + UPSERT_CHUNK]
            await self._pool.execute(
                "UPDATE mf_scheme s SET status = c.status, updated_at = now() "
                "FROM unnest($1::int[], $2::text[]) AS c(code, status) WHERE s.code = c.code",
                [c for c, _ in chunk],
                [s for _, s in chunk],
            )

    async def tracked_codes(self, limit: int, only: list[int] | None) -> list[int]:
        if only:
            rows = await self._pool.fetch(
                "SELECT code FROM mf_scheme WHERE code = ANY($1::int[]) ORDER BY code", only
            )
        else:
            rows = await self._pool.fetch(
                "SELECT code FROM mf_scheme WHERE is_tracked "
                "ORDER BY last_opened_at DESC NULLS LAST, code LIMIT $1",
                limit,
            )
        return [int(r["code"]) for r in rows]

    async def scheme_exists(self, code: int) -> bool:
        return bool(await self._pool.fetchval("SELECT 1 FROM mf_scheme WHERE code = $1", code))

    async def last_nav_date(self, code: int) -> date | None:
        value = await self._pool.fetchval(
            "SELECT max(nav_date) FROM mf_nav WHERE scheme_code = $1", code
        )
        return value if isinstance(value, date) else None

    async def upsert_navs(self, code: int, points: list[NavPoint]) -> int:
        for i in range(0, len(points), UPSERT_CHUNK):
            chunk = points[i : i + UPSERT_CHUNK]
            await self._pool.execute(
                "INSERT INTO mf_nav (scheme_code, nav_date, nav) "
                "SELECT $1, d, n FROM unnest($2::date[], $3::float8[]) AS t(d, n) "
                "ON CONFLICT (scheme_code, nav_date) DO UPDATE SET nav = EXCLUDED.nav",
                code,
                [p.nav_date for p in chunk],
                [float(p.nav) for p in chunk],
            )
        return len(points)

    async def update_meta(self, code: int, meta: SchemeMeta, last_nav: date | None) -> None:
        await self._pool.execute(
            "UPDATE mf_scheme SET fund_house = COALESCE(fund_house, $2), "
            "scheme_type = COALESCE(scheme_type, $3), category = COALESCE(category, $4), "
            "isin_growth = COALESCE(isin_growth, $5), "
            "isin_div_reinvest = COALESCE(isin_div_reinvest, $6), "
            "last_nav_date = COALESCE($7, last_nav_date), updated_at = now() WHERE code = $1",
            code,
            meta.fund_house,
            meta.scheme_type,
            meta.category,
            meta.isin_growth,
            meta.isin_div_reinvest,
            last_nav,
        )

    async def load_series(self, code: int) -> tuple[list[date], list[float]]:
        rows = await self._pool.fetch(
            "SELECT nav_date, nav FROM mf_nav WHERE scheme_code = $1 ORDER BY nav_date", code
        )
        return [r["nav_date"] for r in rows], [float(r["nav"]) for r in rows]

    async def save_cache(self, code: int, as_of: date, metrics: dict[str, Any]) -> None:
        await self._pool.execute(
            "INSERT INTO mf_return_cache (scheme_code, as_of, metrics) VALUES ($1, $2, $3::jsonb) "
            "ON CONFLICT (scheme_code) DO UPDATE SET as_of = EXCLUDED.as_of, "
            "metrics = EXCLUDED.metrics",
            code,
            as_of,
            json.dumps(metrics, allow_nan=False),
        )

    async def previous_amfi_rows(self) -> int | None:
        value = await self._pool.fetchval(
            "SELECT (details->>'amfi_status_rows')::int FROM ingestion_run "
            "WHERE job = 'sync_mf_schemes' AND status IN ('ok', 'partial') "
            "AND details ? 'amfi_status_rows' ORDER BY started_at DESC, id DESC LIMIT 1"
        )
        return int(value) if value is not None else None

    async def risk_free_rate(self) -> float:
        value = await self._pool.fetchval(
            "SELECT value FROM app_setting WHERE key = 'RISK_FREE_RATE'"
        )
        try:
            rate = float(json.loads(value)) if isinstance(value, str) else float(value)
        except (TypeError, ValueError):
            rate = float(os.environ.get("RISK_FREE_RATE") or DEFAULT_RISK_FREE)
        return rate


# --------------------------------------------------------------------------- wiring
@dataclass
class _Runtime:
    store: PgMfStore
    mfapi: MfapiClient
    amfi: AmfiClient


@asynccontextmanager
async def _runtime(pool: asyncpg.Pool) -> AsyncIterator[_Runtime]:
    health = PgSourceHealthStore(pool)
    async with make_client() as client:
        yield _Runtime(
            PgMfStore(pool),
            MfapiClient(
                client,
                build_guard(
                    "mfapi",
                    health,
                    default_interval=MFAPI_INTERVAL,
                    env_var="MFAPI_MIN_INTERVAL_SEC",
                ),
            ),
            AmfiClient(client, build_guard("amfi", health, default_interval=AMFI_INTERVAL)),
        )


async def sync_mf_schemes_job(ctx: JobContext) -> None:
    from worker.db import create_pool

    pool = await create_pool()
    try:
        async with _runtime(pool) as rt:
            await run_sync_mf_schemes(ctx, rt.store, rt.mfapi, rt.amfi, ist_today())
    finally:
        await pool.close()


async def ingest_mf_navs_job(ctx: JobContext) -> None:
    from worker.db import create_pool

    only = [int(s) for s in ctx.symbols or [] if s.isdigit()] or None
    pool = await create_pool()
    try:
        async with _runtime(pool) as rt:
            await run_ingest_mf_navs(ctx, rt.store, rt.mfapi, rt.amfi, ist_today(), only)
    finally:
        await pool.close()


async def mf_refresh_handler(job: HttpJob) -> HttpJobResult:
    """worker-http kind ``mf_refresh``: ``target`` is the scheme code (read from the DB row)."""
    from worker.post_import import _shared_pool

    if not job.target.isdigit():
        return HttpJobResult("failed", error="target is not a scheme code")
    code = int(job.target)
    ctx = JobContext(job="mf_refresh")
    pool = await _shared_pool()
    async with _runtime(pool) as rt:
        await run_ingest_mf_navs(ctx, rt.store, rt.mfapi, rt.amfi, ist_today(), [code])
    result: dict[str, Any] = {"rows_written": ctx.rows_written, **ctx.extra}
    if ctx.items_failed:
        return HttpJobResult("failed", result, error=ctx.errors[0]["error"] if ctx.errors else None)
    return HttpJobResult("partial" if ctx.marked_partial else "ok", result)
