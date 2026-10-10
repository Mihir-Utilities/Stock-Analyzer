# D01 - Worker scaffold, limiter, circuit breaker, job runner

| Field | Value |
|---|---|
| Track | data |
| Depends on | T00, T02 |
| Size | M (S < 0.5 day, M 0.5-1.5 days, L 1.5-4 days of focused work) |

## Read first
- docs/04-worker-jobs.md sections 1, 4, 5
- docs/01-data-sources.md section 1
- `CLAUDE.md` (rules), `docs/00-legal-and-safety.md` (Safe Edition guards)

## Goal
Build the shared worker foundation: CLI, HTTP service, locks, throttling, circuit breakers, logging.

## In scope
- `python -m worker run <job>` CLI and `uvicorn worker.http:app` with HMAC auth
- `ingestion_run` lock/unlock helper, per-item isolation helper, structured logging with scrubber
- Async rate limiter with jitter, retry/backoff helper, circuit breaker backed by `source_health`
- Deny-list unit test (SAF-01) for worker imports
- Fixture recorder/loader utilities

## Out of scope (do not do in this task)
- Any source adapter

## Deliverables
- `apps/worker/{cli,http,runner,limiter,breaker,db,fixtures}`
- tests

## Steps
1. Implement runner contract (lock, timeout, partial status)
2. Implement HMAC verification exactly as spec
3. Test limiter spacing and breaker transitions with a fake clock

## Acceptance criteria (all must be true)
- [ ] SYS-05 and SEC-07 tests pass
- [ ] Breaker opens after 5 failures and recovers after 3 successes
- [ ] Runner marks `partial` on timeout

## Required tests (from `docs/07-edge-cases-tests.md`)
- `SYS-05` (see `docs/07-edge-cases-tests.md`)
- `SEC-07` (see `docs/07-edge-cases-tests.md`)
- `SEC-08` (see `docs/07-edge-cases-tests.md`)
- `SAF-01` (see `docs/07-edge-cases-tests.md`)
- `SYS-09` (see `docs/07-edge-cases-tests.md`)

## Definition of done
- [ ] Behavior matches the cited spec sections exactly (note section numbers in the PR description).
- [ ] Tests above exist, run in CI and pass; new edge cases discovered are added to `docs/07-edge-cases-tests.md`.
- [ ] Loading/empty/partial/stale/error states implemented for any UI work.
- [ ] No secrets or personal data in code, logs or fixtures; deny-list check passes.
- [ ] `docs/RUNBOOK.md` updated for any new variable, job or failure mode.
- [ ] Questions or spec conflicts recorded in `docs/OPEN_QUESTIONS.md` instead of guessed.
