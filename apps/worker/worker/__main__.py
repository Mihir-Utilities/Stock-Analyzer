"""CLI entry point: ``python -m worker run <job> [--symbols] [--dry-run] [--record-fixtures]``."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys

from worker import jobs
from worker.logs import configure_logging
from worker.runner import RunResult, RunStore, run_job


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m worker")
    sub = parser.add_subparsers(dest="command")
    sub.add_parser("hello")
    run = sub.add_parser("run", help="run one job")
    run.add_argument("job")
    run.add_argument("--symbols", default=None, help="comma separated symbols")
    run.add_argument(
        "--dry-run", action="store_true", help="fetch/validate and print; write nothing"
    )
    run.add_argument("--record-fixtures", action="store_true", help="save redacted fixtures")
    return parser


async def _run(args: argparse.Namespace, store: RunStore | None = None) -> RunResult:
    spec = jobs.CLI_JOBS[args.job]
    symbols = (
        [s.strip().upper() for s in args.symbols.split(",") if s.strip()] if args.symbols else None
    )
    if args.dry_run:
        return await run_job(spec, None, dry_run=True, symbols=symbols, record_fixtures=False)
    from worker.db import PgRunStore, create_pool

    pool = await create_pool()
    try:
        return await run_job(
            spec,
            store or PgRunStore(pool),
            symbols=symbols,
            record_fixtures=args.record_fixtures,
        )
    finally:
        await pool.close()


def main(argv: list[str] | None = None) -> int:
    args_in = sys.argv[1:] if argv is None else argv
    if args_in[:1] == ["hello"]:
        print("india-analyzer worker: hello")
        return 0
    if args_in[:1] != ["run"]:
        print(
            "usage: python -m worker run <job> [--symbols A,B] [--dry-run] [--record-fixtures]",
            file=sys.stderr,
        )
        return 2
    try:
        args = _parser().parse_args(args_in)
    except SystemExit:
        return 2
    if args.job not in jobs.CLI_JOBS:
        known = ", ".join(sorted(jobs.CLI_JOBS)) or "(none registered yet)"
        print(f"usage: unknown job {args.job!r}; known jobs: {known}", file=sys.stderr)
        return 2
    configure_logging()
    result = asyncio.run(_run(args))
    print(
        json.dumps(
            {
                "job": result.job,
                "status": result.status,
                "run_id": result.run_id,
                "rows_written": result.rows_written,
                "items_total": result.items_total,
                "items_failed": result.items_failed,
                "error": result.error,
                "dry_run": bool(args.dry_run),
            }
        )
    )
    return 1 if result.status == "failed" else 0


if __name__ == "__main__":
    raise SystemExit(main())
