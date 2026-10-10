# F04 - Login and Dashboard

| Field | Value |
|---|---|
| Track | frontend |
| Depends on | F02, F03, B02 |
| Size | M (S < 0.5 day, M 0.5-1.5 days, L 1.5-4 days of focused work) |

## Read first
- docs/06-frontend-spec.md sections 6.1, 6.2
- docs/06a-design-system.md section 5 (Dashboard)
- `CLAUDE.md` (rules), `docs/00-legal-and-safety.md` (Safe Edition guards)

## Goal
Build the login screen and the data-rich dashboard.

## In scope
- Login with lockout messaging and no recovery links
- Dashboard: index sparkline tiles, market status, watchlist heatmap/treemap and movers, upcoming events timeline, portfolio snapshot with allocation sunburst, alerts strip, data-health strip with broker countdown/Reconnect

## Out of scope (do not do in this task)
- Nothing else; stay within the scope above.

## Deliverables
- `app/login`, `app/page.tsx`, dashboard widgets, tests

## Steps
1. Wire endpoints with all states
2. Implement widgets with ChartFrame and data tables
3. Mobile layout review at 375 px

## Acceptance criteria (all must be true)
- [ ] All widgets show loading/empty/error states
- [ ] Index tiles show reasons when the broker serves no index data
- [ ] Playwright login/lockout test passes

## Required tests (from `docs/07-edge-cases-tests.md`)
- `SEC-01` (see `docs/07-edge-cases-tests.md`)
- `BRK-16` (see `docs/07-edge-cases-tests.md`)
- `UI-01` (see `docs/07-edge-cases-tests.md`)

## Definition of done
- [ ] Behavior matches the cited spec sections exactly (note section numbers in the PR description).
- [ ] Tests above exist, run in CI and pass; new edge cases discovered are added to `docs/07-edge-cases-tests.md`.
- [ ] Loading/empty/partial/stale/error states implemented for any UI work.
- [ ] No secrets or personal data in code, logs or fixtures; deny-list check passes.
- [ ] `docs/RUNBOOK.md` updated for any new variable, job or failure mode.
- [ ] Questions or spec conflicts recorded in `docs/OPEN_QUESTIONS.md` instead of guessed.
