# D08 - Housekeeping, backup, workflows

| Field | Value |
|---|---|
| Track | data |
| Depends on | D01, D03..D07 (D02 removed) |
| Size | M (S < 0.5 day, M 0.5-1.5 days, L 1.5-4 days of focused work) |

## Amendment: manual price mode (decisions D-1, D-2 and follow-ups, 2026-10-10)
Source of truth: `docs/OPEN_QUESTIONS.md` Decisions; updated specs: `docs/01` 7.0/7.1, `docs/03` 3, 4, 14, `docs/04` 3.9-3.13. Where this block conflicts with the sections below, **this block wins**.
- Housekeeping per `docs/04` 3.10 (manual mode): **never delete imported prices automatically**; imported/watchlist/portfolio stocks are exempt from LRU and the 12-month rule; Telegram notice + admin warning at 70/85/95% of `DB_SOFT_LIMIT_MB`; delete expired `import_upload` rows. Owner-initiated trim/delete live in B06a/F13a. BRK-14 (static IP) is N/A. Tests: SYS-02 (new wording), SYS-04, SYS-08.
- Workflows: no `sync_instruments`, `broker_session_check`, `ingest_prices_eod`, retry or intraday alert workflows; add `process_queued_jobs`; keep `evaluate_alerts` (EOD only), `ingest_mf_navs`, `sync_mf_schemes`, `housekeeping`, `backup_user_data` (no broker tokens exist), `keepalive`.

## Read first
- docs/04-worker-jobs.md sections 2, 3.10, 3.11, 5
- docs/07-edge-cases-tests.md SYS-*
- `CLAUDE.md` (rules), `docs/00-legal-and-safety.md` (Safe Edition guards)

## Goal
Create scheduled workflows, eviction/size controls, encrypted backups and the keep-alive.

## In scope
- GitHub workflows for every row of the schedule with `workflow_dispatch`, concurrency groups, timeouts, SHA-pinned actions
- `housekeeping` with the exact eviction order and 380 MB rule
- `backup_user_data` with `age` encryption (public key only)
- `keepalive` workflow
- RUNBOOK sections: reconnect broker daily, home-machine fallback, restore drill, plan B if Render hours are exhausted

## Out of scope (do not do in this task)
- Nothing else; stay within the scope above.

## Deliverables
- `.github/workflows/*.yml`, jobs, RUNBOOK updates, tests

## Steps
1. Write workflows from the schedule table (UTC cron)
2. Implement size-based eviction with tests on a seeded DB
3. Implement backup + restore script and a restore drill checklist

## Acceptance criteria (all must be true)
- [ ] SYS-02, SYS-03, SYS-04, SYS-05, SYS-08 verified
- [ ] Backup contains no broker tokens and no password hash

## Required tests (from `docs/07-edge-cases-tests.md`)
- `SYS-02` (see `docs/07-edge-cases-tests.md`)
- `SYS-03` (see `docs/07-edge-cases-tests.md`)
- `SYS-04` (see `docs/07-edge-cases-tests.md`)
- `SYS-08` (see `docs/07-edge-cases-tests.md`)
- `SYS-06` (see `docs/07-edge-cases-tests.md`)
- `BRK-14` (see `docs/07-edge-cases-tests.md`)

## Definition of done
- [ ] Behavior matches the cited spec sections exactly (note section numbers in the PR description).
- [ ] Tests above exist, run in CI and pass; new edge cases discovered are added to `docs/07-edge-cases-tests.md`.
- [ ] Loading/empty/partial/stale/error states implemented for any UI work.
- [ ] No secrets or personal data in code, logs or fixtures; deny-list check passes.
- [ ] `docs/RUNBOOK.md` updated for any new variable, job or failure mode.
- [ ] Questions or spec conflicts recorded in `docs/OPEN_QUESTIONS.md` instead of guessed.
