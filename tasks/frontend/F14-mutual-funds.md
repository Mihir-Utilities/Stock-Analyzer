# F14 - Mutual funds

| Field | Value |
|---|---|
| Track | frontend |
| Depends on | F02, F03, B10 |
| Size | L (S < 0.5 day, M 0.5-1.5 days, L 1.5-4 days of focused work) |

## Read first
- docs/06-frontend-spec.md section 6.9
- docs/05-analytics-spec.md section 9
- `CLAUDE.md` (rules), `docs/00-legal-and-safety.md` (Safe Edition guards)

## Goal
Build fund search, detail with rich visuals, SIP/lumpsum calculators and compare.

## In scope
- Search with filters/defaults/grouping; detail with NAV chart + rolling-return band, returns table + heatmap, calendar-year bars, rolling-return histogram, risk panel, SIP growth area with installment markers, lumpsum calculator
- Compare with rebased chart, risk-return scatter, returns heatmap table
- Warnings and attribution text

## Out of scope (do not do in this task)
- Nothing else; stay within the scope above.

## Deliverables
- `app/mf/*`

## Steps
1. Implement SIP form with day 1-28 validation
2. Add Show data for every chart

## Acceptance criteria (all must be true)
- [ ] MF-05, MF-11, MF-13 UX verified
- [ ] Attribution visible on all MF screens (SAF-03)

## Required tests (from `docs/07-edge-cases-tests.md`)
- `MF-05` (see `docs/07-edge-cases-tests.md`)
- `MF-11` (see `docs/07-edge-cases-tests.md`)
- `MF-13` (see `docs/07-edge-cases-tests.md`)
- `SAF-03` (see `docs/07-edge-cases-tests.md`)

## Definition of done
- [ ] Behavior matches the cited spec sections exactly (note section numbers in the PR description).
- [ ] Tests above exist, run in CI and pass; new edge cases discovered are added to `docs/07-edge-cases-tests.md`.
- [ ] Loading/empty/partial/stale/error states implemented for any UI work.
- [ ] No secrets or personal data in code, logs or fixtures; deny-list check passes.
- [ ] `docs/RUNBOOK.md` updated for any new variable, job or failure mode.
- [ ] Questions or spec conflicts recorded in `docs/OPEN_QUESTIONS.md` instead of guessed.
