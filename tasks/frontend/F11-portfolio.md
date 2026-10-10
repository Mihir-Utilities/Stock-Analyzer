# F11 - Portfolio

| Field | Value |
|---|---|
| Track | frontend |
| Depends on | F02, B11 |
| Size | L (S < 0.5 day, M 0.5-1.5 days, L 1.5-4 days of focused work) |

## Read first
- docs/06-frontend-spec.md section 6.7
- `CLAUDE.md` (rules), `docs/00-legal-and-safety.md` (Safe Edition guards)

## Goal
Build the portfolio experience with rich visuals and safe transaction entry.

## In scope
- Summary cards; holdings table; allocation sunburst/treemap; contribution bars; P&L waterfall; growth vs benchmark; drawdown; transactions with filters
- Add/edit/delete transaction forms with server validation messages; adjustments panel with override and review badges; estimated dividends card

## Out of scope (do not do in this task)
- Nothing else; stay within the scope above.

## Deliverables
- `app/portfolio/*`

## Steps
1. Use `decimal.js` for client-side sums
2. Implement weekend/holiday warning from the holidays endpoint
3. E2E: oversell, split adjustment display

## Acceptance criteria (all must be true)
- [ ] PF-01, PF-06, PF-09 E2E pass
- [ ] Money precision test passes (PF-12)

## Required tests (from `docs/07-edge-cases-tests.md`)
- `PF-01` (see `docs/07-edge-cases-tests.md`)
- `PF-06` (see `docs/07-edge-cases-tests.md`)
- `PF-08` (see `docs/07-edge-cases-tests.md`)
- `PF-09` (see `docs/07-edge-cases-tests.md`)
- `PF-12` (see `docs/07-edge-cases-tests.md`)

## Definition of done
- [ ] Behavior matches the cited spec sections exactly (note section numbers in the PR description).
- [ ] Tests above exist, run in CI and pass; new edge cases discovered are added to `docs/07-edge-cases-tests.md`.
- [ ] Loading/empty/partial/stale/error states implemented for any UI work.
- [ ] No secrets or personal data in code, logs or fixtures; deny-list check passes.
- [ ] `docs/RUNBOOK.md` updated for any new variable, job or failure mode.
- [ ] Questions or spec conflicts recorded in `docs/OPEN_QUESTIONS.md` instead of guessed.
