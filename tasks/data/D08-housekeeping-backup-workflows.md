# D08 - Housekeeping, backup, workflows

| Field | Value |
|---|---|
| Track | data |
| Depends on | D01..D07 |
| Size | M (S < 0.5 day, M 0.5-1.5 days, L 1.5-4 days of focused work) |

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
