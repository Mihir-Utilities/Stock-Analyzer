"""Registers the D03 jobs: CLI ``detect_actions``, ``readjust_prices``, ``process_queued_jobs``
and the worker-http handler for ``post_import``. Imported by ``__main__`` and ``http``.
"""

from __future__ import annotations

from worker import actions_db, alerts_db, analysis_db, jobs, mf_jobs
from worker.db import create_pool
from worker.notify import TelegramNotifier
from worker.post_import import (
    PgPostImportStore,
    SymbolProcessor,
    post_import_handler,
    process_queued_work,
)
from worker.runner import JobContext, JobSpec

DETECT_TIMEOUT_S = 10 * 60
READJUST_TIMEOUT_S = 10 * 60
COMPUTE_TIMEOUT_S = 10 * 60
PROCESS_QUEUED_TIMEOUT_S = 20 * 60  # docs/04 3.13: the 20-minute workflow timeout
EVALUATE_ALERTS_TIMEOUT_S = 8 * 60  # docs/04 section 2: evaluate_alerts (EOD) 8 min


async def _symbols(ctx: JobContext) -> list[str]:
    if ctx.symbols:
        return list(ctx.symbols)
    pool = await create_pool()
    try:
        rows = await pool.fetch("SELECT symbol FROM instrument WHERE is_tracked ORDER BY symbol")
    finally:
        await pool.close()
    return [str(r["symbol"]) for r in rows]


async def detect_actions_job(ctx: JobContext) -> None:
    """docs/04 3.2 from the CLI: ``--symbols`` or every tracked stock."""
    symbols = await _symbols(ctx)
    pool = await create_pool()
    try:

        async def one(symbol: str) -> None:
            out = await actions_db.detect_actions(pool, symbol, dry_run=ctx.dry_run)
            ctx.add_rows(0 if ctx.dry_run else len(out.new_actions))
            ctx.extra.setdefault("new_actions", {})[symbol] = out.summary()["new_actions"]

        await ctx.for_each(symbols, one)
    finally:
        await pool.close()


async def readjust_prices_job(ctx: JobContext) -> None:
    """Re-adjustment after an owner confirmation (docs/01 3.7; docs/05 8.2)."""
    symbols = await _symbols(ctx)
    pool = await create_pool()
    try:

        async def one(symbol: str) -> None:
            out = await actions_db.readjust_history(pool, symbol, dry_run=ctx.dry_run)
            ctx.add_rows(int(out["rows_updated"] or 0))
            if out["review_needed"]:
                ctx.extra.setdefault("review_needed", {})[symbol] = out["review_needed"]

        await ctx.for_each(symbols, one)
    finally:
        await pool.close()


async def process_queued_jobs_job(ctx: JobContext) -> None:
    pool = await create_pool()
    hooks = analysis_db.production_hooks(pool)
    try:
        summaries = await process_queued_work(
            PgPostImportStore(pool),
            SymbolProcessor(pool, notifier=TelegramNotifier(pool), hooks=hooks),
            ctx,
            hooks=hooks,
        )
        ctx.extra["jobs"] = summaries
        # docs/04 3.13: `predict` runs here once models exist (Phase 7, deferred by D-4).
    finally:
        await pool.close()


async def compute_analysis_job(ctx: JobContext) -> None:
    """docs/04 3.7 from the CLI (D05a part): ``--symbols`` or every tracked stock."""
    symbols = await _symbols(ctx)
    pool = await create_pool()
    try:

        async def one(symbol: str) -> None:
            if ctx.dry_run:
                return
            out = await analysis_db.compute_analysis(pool, symbol)
            ctx.add_rows(1 if out["status"] == "ok" else 0)
            if out["status"] != "ok":
                ctx.extra.setdefault("skipped", {})[symbol] = out["status"]

        await ctx.for_each(symbols, one)
        if not ctx.dry_run and not ctx.timed_out:
            await analysis_db.recompute_screener(pool, symbols)
    finally:
        await pool.close()


async def evaluate_alerts_job(ctx: JobContext) -> None:
    """docs/04 3.9, EOD run (19:30 IST): every active alert, then deliver what is pending."""
    pool = await create_pool()
    try:
        if ctx.dry_run:
            ctx.extra["alerts"] = int(
                await pool.fetchval("SELECT count(*) FROM alert WHERE status = 'active'")
            )
            return
        summary = await alerts_db.evaluate_alerts(pool, should_stop=ctx.past_deadline)
        ctx.items_total = int(summary["alerts"])
        ctx.items_failed = int(summary["errors"])
        ctx.add_rows(int(summary["events"]))
        ctx.extra["evaluate"] = summary
        if summary.get("stopped_early"):
            ctx.timed_out = True
        ctx.extra["delivery"] = await alerts_db.deliver_alerts(pool)
    finally:
        await pool.close()


def register_all() -> None:
    jobs.register_cli_job(JobSpec("compute_analysis", COMPUTE_TIMEOUT_S, compute_analysis_job))
    jobs.register_cli_job(JobSpec("detect_actions", DETECT_TIMEOUT_S, detect_actions_job))
    jobs.register_cli_job(JobSpec("readjust_prices", READJUST_TIMEOUT_S, readjust_prices_job))
    jobs.register_cli_job(
        JobSpec("process_queued_jobs", PROCESS_QUEUED_TIMEOUT_S, process_queued_jobs_job)
    )
    jobs.register_cli_job(
        JobSpec("evaluate_alerts", EVALUATE_ALERTS_TIMEOUT_S, evaluate_alerts_job)
    )
    jobs.register_http_handler("post_import", post_import_handler)
    # D04: mutual fund jobs
    jobs.register_cli_job(JobSpec("sync_mf_schemes", 20 * 60, mf_jobs.sync_mf_schemes_job))
    jobs.register_cli_job(JobSpec("ingest_mf_navs", 30 * 60, mf_jobs.ingest_mf_navs_job))
    jobs.register_http_handler("mf_refresh", mf_jobs.mf_refresh_handler)


register_all()
