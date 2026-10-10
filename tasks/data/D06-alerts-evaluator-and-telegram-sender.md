# D06 - Alerts evaluator and Telegram sender

| Field | Value |
|---|---|
| Track | data |
| Depends on | D03, B12 |
| Size | M (S < 0.5 day, M 0.5-1.5 days, L 1.5-4 days of focused work) |

## Amendment: manual price mode (decisions D-1, D-2 and follow-ups, 2026-10-10)
Source of truth: `docs/OPEN_QUESTIONS.md` Decisions; updated specs: `docs/01` 7.0/7.1, `docs/03` 3, 4, 14, `docs/04` 3.9-3.13. Where this block conflicts with the sections below, **this block wins**.
- Manual-mode evaluation per `docs/04` 3.9: event-driven call at the end of `post_import` for the affected symbols **and** the 19:30 IST EOD run; no intraday run, no quotes, no broker reminders. Only bars newer than `alert.last_state.last_bar_date` can fire; the dedupe key includes the bar date; messages end "as of the last price import ({bar date})". ALR-14 is N/A in manual mode; add **ALR-18**.

## Read first
- docs/04-worker-jobs.md 3.9
- docs/01-data-sources.md section 6
- docs/07-edge-cases-tests.md ALR-*
- `CLAUDE.md` (rules), `docs/00-legal-and-safety.md` (Safe Edition guards)

## Goal
Evaluate all alert kinds with deduplication and deliver via Telegram with pacing, digests and quiet hours.

## In scope
- Evaluator per kind with the exact trigger rules
- Dedupe via `alert_event` unique key; cooldown/hysteresis; expiry; delisted handling
- Telegram sender (HTML escaping, 1.1 s spacing, digest > 10, retries 5x/15 min, pending-until-linked rules)
- Stale-price rule (no price alert if data older than 1 trading day)

## Out of scope (do not do in this task)
- Alert CRUD (B12)

## Deliverables
- jobs `evaluate_alerts` (intraday/EOD), sender, tests with fake Telegram server

## Steps
1. Implement evaluator with injected clock for tests
2. Implement sender with a fake HTTP server
3. Add quiet-hours and digest tests

## Acceptance criteria (all must be true)
- [ ] ALR-02..ALR-10, ALR-14, ALR-17 pass
- [ ] A fired alert is delivered exactly once under duplicate runs

## Required tests (from `docs/07-edge-cases-tests.md`)
- `ALR-02` (see `docs/07-edge-cases-tests.md`)
- `ALR-03` (see `docs/07-edge-cases-tests.md`)
- `ALR-04` (see `docs/07-edge-cases-tests.md`)
- `ALR-05` (see `docs/07-edge-cases-tests.md`)
- `ALR-06` (see `docs/07-edge-cases-tests.md`)
- `ALR-07` (see `docs/07-edge-cases-tests.md`)
- `ALR-08` (see `docs/07-edge-cases-tests.md`)
- `ALR-09` (see `docs/07-edge-cases-tests.md`)
- `ALR-10` (see `docs/07-edge-cases-tests.md`)
- `ALR-14` (see `docs/07-edge-cases-tests.md`)
- `ALR-17` (see `docs/07-edge-cases-tests.md`)

## Definition of done
- [ ] Behavior matches the cited spec sections exactly (note section numbers in the PR description).
- [ ] Tests above exist, run in CI and pass; new edge cases discovered are added to `docs/07-edge-cases-tests.md`.
- [ ] Loading/empty/partial/stale/error states implemented for any UI work.
- [ ] No secrets or personal data in code, logs or fixtures; deny-list check passes.
- [ ] `docs/RUNBOOK.md` updated for any new variable, job or failure mode.
- [ ] Questions or spec conflicts recorded in `docs/OPEN_QUESTIONS.md` instead of guessed.
