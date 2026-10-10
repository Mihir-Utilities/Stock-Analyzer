# F07 - Stock detail: Fundamentals and data-entry forms

| Field | Value |
|---|---|
| Track | frontend |
| Depends on | F05, B05, B06 |
| Size | L (S < 0.5 day, M 0.5-1.5 days, L 1.5-4 days of focused work) |

## Read first
- docs/06-frontend-spec.md section 6.4 (Fundamentals)
- docs/01-data-sources.md 7.2, 7.6
- `CLAUDE.md` (rules), `docs/00-legal-and-safety.md` (Safe Edition guards)

## Goal
Visualize owner-entered fundamentals richly and let the owner add periods without leaving the page.

## In scope
- Quarterly/Annual and basis toggles; groups (P&L, Balance sheet, Cash flow, Ratios, Valuation); periods table with YoY/QoQ rows and sparklines; selectable rows -> chart pane
- P&L waterfall, stacked balance composition, cash-flow chart, ROE decomposition, PE percentile strip; DepthChip; source chips
- Empty-state CTA and manual entry forms (quarterly/annual) with unit hints and validation parity with CSV rules

## Out of scope (do not do in this task)
- Nothing else; stay within the scope above.

## Deliverables
- `components/stock/fundamentals/*`, forms, tests

## Steps
1. Implement table with right-aligned tabular numbers and sticky first column
2. Implement forms using the same validator messages as the API
3. Add warnings display for unit mix-ups

## Acceptance criteria (all must be true)
- [ ] FND-11/12 UI behavior verified
- [ ] Forms reject invalid periods like the API does (IMP-05/06)
- [ ] Waterfall matches the numbers in the table

## Required tests (from `docs/07-edge-cases-tests.md`)
- `FND-11` (see `docs/07-edge-cases-tests.md`)
- `FND-12` (see `docs/07-edge-cases-tests.md`)
- `IMP-05` (see `docs/07-edge-cases-tests.md`)
- `IMP-06` (see `docs/07-edge-cases-tests.md`)
- `IMP-17` (see `docs/07-edge-cases-tests.md`)

## Definition of done
- [ ] Behavior matches the cited spec sections exactly (note section numbers in the PR description).
- [ ] Tests above exist, run in CI and pass; new edge cases discovered are added to `docs/07-edge-cases-tests.md`.
- [ ] Loading/empty/partial/stale/error states implemented for any UI work.
- [ ] No secrets or personal data in code, logs or fixtures; deny-list check passes.
- [ ] `docs/RUNBOOK.md` updated for any new variable, job or failure mode.
- [ ] Questions or spec conflicts recorded in `docs/OPEN_QUESTIONS.md` instead of guessed.
