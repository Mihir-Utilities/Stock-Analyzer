# F12 - Alerts, Settings, Broker and Telegram

| Field | Value |
|---|---|
| Track | frontend |
| Depends on | F02, B08, B12 |
| Size | M (S < 0.5 day, M 0.5-1.5 days, L 1.5-4 days of focused work) |

## Read first
- docs/06-frontend-spec.md sections 6.8, 6.11
- docs/01-data-sources.md 3.4, 6
- `CLAUDE.md` (rules), `docs/00-legal-and-safety.md` (Safe Edition guards)

## Goal
Build alerts management, settings, broker connect/reconnect and Telegram linking.

## In scope
- Alerts list/create dialog with dynamic params and inline errors; history; quiet hours
- Telegram connect card with code, deep link, countdown and polling; test; unlink
- Settings: password, display, sessions, export; Broker card (status, minutes left, Connect/Reconnect/Disconnect, read-only note); About with safe-use policy and notices

## Out of scope (do not do in this task)
- Nothing else; stay within the scope above.

## Deliverables
- `app/{alerts,settings}/*`

## Steps
1. Implement per-kind forms from OpenAPI
2. Implement Telegram polling UX with cold-start tolerance
3. Add E2E for threshold-already-met and link flow

## Acceptance criteria (all must be true)
- [ ] ALR-01 and ALR-16 UX verified
- [ ] Broker callback result messages handled

## Required tests (from `docs/07-edge-cases-tests.md`)
- `ALR-01` (see `docs/07-edge-cases-tests.md`)
- `ALR-05` (see `docs/07-edge-cases-tests.md`)
- `ALR-16` (see `docs/07-edge-cases-tests.md`)
- `BRK-03` (see `docs/07-edge-cases-tests.md`)

## Definition of done
- [ ] Behavior matches the cited spec sections exactly (note section numbers in the PR description).
- [ ] Tests above exist, run in CI and pass; new edge cases discovered are added to `docs/07-edge-cases-tests.md`.
- [ ] Loading/empty/partial/stale/error states implemented for any UI work.
- [ ] No secrets or personal data in code, logs or fixtures; deny-list check passes.
- [ ] `docs/RUNBOOK.md` updated for any new variable, job or failure mode.
- [ ] Questions or spec conflicts recorded in `docs/OPEN_QUESTIONS.md` instead of guessed.
