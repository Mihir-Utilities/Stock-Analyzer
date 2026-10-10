# D02 - Broker adapter and instrument sync

| Field | Value |
|---|---|
| Track | data |
| Depends on | D01, T01 |
| Size | L (S < 0.5 day, M 0.5-1.5 days, L 1.5-4 days of focused work) |

## Read first
- docs/01-data-sources.md sections 3.1-3.6
- docs/04-worker-jobs.md 3.1, 3.3
- docs/BROKER_DECISION.md
- docs/07-edge-cases-tests.md BRK-*
- `CLAUDE.md` (rules), `docs/00-legal-and-safety.md` (Safe Edition guards)

## Goal
Implement the chosen broker's read-only adapter (instrument master, candles, quotes, index candles), session checks and the instrument sync job.

## In scope
- Adapter implementing `BrokerSource` for the chosen broker only, with typed errors and chunked candle requests
- Token read/decrypt from `broker_session` (never stored elsewhere)
- `sync_instruments` job with validation, change detection, probing, tracked-set recompute
- `broker_session_check` job and Telegram reminders (once per slot)
- Manual price mode: skip all broker work cleanly

## Out of scope (do not do in this task)
- Order APIs of any kind
- Automated login

## Deliverables
- `apps/worker/adapters/broker_<name>.py`
- jobs `sync_instruments`, `broker_session_check`
- fixtures and tests

## Steps
1. Implement adapter against recorded fixtures first, then verify live with the owner session
2. Implement master validation and change-detection rules
3. Implement tracked-set recompute (watchlist + portfolio + training basket + LRU)

## Acceptance criteria (all must be true)
- [ ] BRK-01, BRK-02, BRK-05, BRK-06, BRK-07, BRK-15 pass
- [ ] Master validation aborts without deleting data when invalid
- [ ] No code path calls an order endpoint (SAF-02)

## Required tests (from `docs/07-edge-cases-tests.md`)
- `BRK-01` (see `docs/07-edge-cases-tests.md`)
- `BRK-02` (see `docs/07-edge-cases-tests.md`)
- `BRK-05` (see `docs/07-edge-cases-tests.md`)
- `BRK-06` (see `docs/07-edge-cases-tests.md`)
- `BRK-07` (see `docs/07-edge-cases-tests.md`)
- `BRK-15` (see `docs/07-edge-cases-tests.md`)
- `SAF-02` (see `docs/07-edge-cases-tests.md`)

## Definition of done
- [ ] Behavior matches the cited spec sections exactly (note section numbers in the PR description).
- [ ] Tests above exist, run in CI and pass; new edge cases discovered are added to `docs/07-edge-cases-tests.md`.
- [ ] Loading/empty/partial/stale/error states implemented for any UI work.
- [ ] No secrets or personal data in code, logs or fixtures; deny-list check passes.
- [ ] `docs/RUNBOOK.md` updated for any new variable, job or failure mode.
- [ ] Questions or spec conflicts recorded in `docs/OPEN_QUESTIONS.md` instead of guessed.
