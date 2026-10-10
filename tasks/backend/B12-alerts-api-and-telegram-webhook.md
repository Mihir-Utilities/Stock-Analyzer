# B12 - Alerts API and Telegram webhook

| Field | Value |
|---|---|
| Track | backend |
| Depends on | B02 |
| Size | M (S < 0.5 day, M 0.5-1.5 days, L 1.5-4 days of focused work) |

## Read first
- docs/03-api-spec.md section 13
- docs/01-data-sources.md section 6
- docs/07-edge-cases-tests.md ALR-*
- `CLAUDE.md` (rules), `docs/00-legal-and-safety.md` (Safe Edition guards)

## Goal
CRUD for alerts, Telegram link codes and the secure webhook receiver.

## In scope
- Alert CRUD with per-kind param validation and `THRESHOLD_ALREADY_MET` check using the latest price
- Link-code generation (sha256 stored, 15 min, single use), unlink, test message (1/min)
- Public webhook: secret header constant-time compare, `/start <code>` only, ignore other chats
- Alert events history

## Out of scope (do not do in this task)
- Evaluating alerts and sending messages (worker D06)

## Deliverables
- handlers, validators, tests

## Steps
1. Implement param schemas per kind and limits (200 active)
2. Implement webhook handler and tests with fake Telegram payloads

## Acceptance criteria (all must be true)
- [ ] ALR-01, ALR-11, ALR-12, ALR-13, ALR-15 pass
- [ ] Webhook rejects wrong secret and stores nothing

## Required tests (from `docs/07-edge-cases-tests.md`)
- `ALR-01` (see `docs/07-edge-cases-tests.md`)
- `ALR-11` (see `docs/07-edge-cases-tests.md`)
- `ALR-12` (see `docs/07-edge-cases-tests.md`)
- `ALR-13` (see `docs/07-edge-cases-tests.md`)
- `ALR-15` (see `docs/07-edge-cases-tests.md`)

## Definition of done
- [ ] Behavior matches the cited spec sections exactly (note section numbers in the PR description).
- [ ] Tests above exist, run in CI and pass; new edge cases discovered are added to `docs/07-edge-cases-tests.md`.
- [ ] Loading/empty/partial/stale/error states implemented for any UI work.
- [ ] No secrets or personal data in code, logs or fixtures; deny-list check passes.
- [ ] `docs/RUNBOOK.md` updated for any new variable, job or failure mode.
- [ ] Questions or spec conflicts recorded in `docs/OPEN_QUESTIONS.md` instead of guessed.
