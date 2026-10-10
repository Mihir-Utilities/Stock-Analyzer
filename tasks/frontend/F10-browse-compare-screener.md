# F10 - Browse, Compare, Screener

| Field | Value |
|---|---|
| Track | frontend |
| Depends on | F03, F02, B13 |
| Size | L (S < 0.5 day, M 0.5-1.5 days, L 1.5-4 days of focused work) |

## Read first
- docs/06-frontend-spec.md sections 6.3, 6.5, 6.6
- `CLAUDE.md` (rules), `docs/00-legal-and-safety.md` (Safe Edition guards)

## Goal
Build stock browse, comparison and the screener with scatter/histogram insights.

## In scope
- Browse table with filters and sparklines; Compare with rebased chart, metrics table, radar, correlation heatmap
- Screener builder, presets, results table with data bars, scatter of any two metrics, histogram with thresholds, saved screens, watchlist multi-select, CSV export
- Notices about owner-data coverage

## Out of scope (do not do in this task)
- Nothing else; stay within the scope above.

## Deliverables
- `app/{stocks,compare,screener}/*`

## Steps
1. Implement whitelisted metric pickers from OpenAPI enums
2. Implement virtualized tables
3. Add tests for validation and empty results

## Acceptance criteria (all must be true)
- [ ] Screener handles 12 filters and shows `excluded_for_missing`
- [ ] Compare handles short-history badges

## Required tests (from `docs/07-edge-cases-tests.md`)
- `SEC-04` (see `docs/07-edge-cases-tests.md`)
- `MF-14` (see `docs/07-edge-cases-tests.md`)
- `UI-09` (see `docs/07-edge-cases-tests.md`)

## Definition of done
- [ ] Behavior matches the cited spec sections exactly (note section numbers in the PR description).
- [ ] Tests above exist, run in CI and pass; new edge cases discovered are added to `docs/07-edge-cases-tests.md`.
- [ ] Loading/empty/partial/stale/error states implemented for any UI work.
- [ ] No secrets or personal data in code, logs or fixtures; deny-list check passes.
- [ ] `docs/RUNBOOK.md` updated for any new variable, job or failure mode.
- [ ] Questions or spec conflicts recorded in `docs/OPEN_QUESTIONS.md` instead of guessed.
