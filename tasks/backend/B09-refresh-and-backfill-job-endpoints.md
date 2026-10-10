# B09 - Refresh and backfill job endpoints

| Field | Value |
|---|---|
| Track | backend |
| Depends on | B08, D01 |
| Size | M (S < 0.5 day, M 0.5-1.5 days, L 1.5-4 days of focused work) |

## Read first
- docs/03-api-spec.md section 7
- docs/04-worker-jobs.md section 4
- docs/07-edge-cases-tests.md API-06, BRK-12
- `CLAUDE.md` (rules), `docs/00-legal-and-safety.md` (Safe Edition guards)

## Goal
Let the UI queue on-demand price refresh/backfill jobs executed by the worker-http service.

## In scope
- POST refresh/backfill endpoints, GET jobs, cooldown and global limits, unique-active-job dedupe
- HMAC-signed fire-and-forget call to worker-http; row stays `queued` if the call fails
- `PRICE_MODE_MANUAL` and `broker_session_missing` handling

## Out of scope (do not do in this task)
- Executing the job (worker D02/D03)

## Deliverables
- handlers, signer, tests with a fake worker

## Steps
1. Implement HMAC signing exactly as the jobs spec
2. Implement rate/cooldown logic
3. Write concurrent-click test

## Acceptance criteria (all must be true)
- [ ] API-06 passes (one job for concurrent clicks)
- [ ] 429 includes `retry_after_seconds`
- [ ] Signature verified by a test worker

## Required tests (from `docs/07-edge-cases-tests.md`)
- `API-06` (see `docs/07-edge-cases-tests.md`)
- `BRK-12` (see `docs/07-edge-cases-tests.md`)
- `SEC-07` (see `docs/07-edge-cases-tests.md`)

## Definition of done
- [ ] Behavior matches the cited spec sections exactly (note section numbers in the PR description).
- [ ] Tests above exist, run in CI and pass; new edge cases discovered are added to `docs/07-edge-cases-tests.md`.
- [ ] Loading/empty/partial/stale/error states implemented for any UI work.
- [ ] No secrets or personal data in code, logs or fixtures; deny-list check passes.
- [ ] `docs/RUNBOOK.md` updated for any new variable, job or failure mode.
- [ ] Questions or spec conflicts recorded in `docs/OPEN_QUESTIONS.md` instead of guessed.
