# F08 - Stock detail: Ownership, Peers, Events, Data tabs

| Field | Value |
|---|---|
| Track | frontend |
| Depends on | F05, B05, B07 |
| Size | L (S < 0.5 day, M 0.5-1.5 days, L 1.5-4 days of focused work) |

## Read first
- docs/06-frontend-spec.md section 6.4 (Ownership, Peers, Events, Data)
- `CLAUDE.md` (rules), `docs/00-legal-and-safety.md` (Safe Edition guards)

## Goal
Complete the remaining stock tabs including detected-action handling.

## In scope
- Ownership: stacked/area charts, pledge line, QoQ diverging bars, small multiples, trend badges, MF-missing note, add-quarter form
- Peers: table, percentile bars, bubble scatter, radar vs median, ranked bars, add/remove peers; empty state when sector data missing
- Events: timeline, add/edit forms, detected-action Confirm/Reject with implied multiplier
- Data tab: counts, sources, suspect rows, import batches

## Out of scope (do not do in this task)
- Nothing else; stay within the scope above.

## Deliverables
- `components/stock/{ownership,peers,events,data}/*`

## Steps
1. Implement charts with ChartFrame
2. Implement confirm/reject flow wired to B07
3. Add field-map entries

## Acceptance criteria (all must be true)
- [ ] Detected-action flow works end-to-end (E2E)
- [ ] Peers empty state links to import
- [ ] Field coverage passes for these endpoints

## Required tests (from `docs/07-edge-cases-tests.md`)
- `ACT-03` (see `docs/07-edge-cases-tests.md`)
- `ACT-04` (see `docs/07-edge-cases-tests.md`)
- `SHP-01` (see `docs/07-edge-cases-tests.md`)
- `UI-09` (see `docs/07-edge-cases-tests.md`)

## Definition of done
- [ ] Behavior matches the cited spec sections exactly (note section numbers in the PR description).
- [ ] Tests above exist, run in CI and pass; new edge cases discovered are added to `docs/07-edge-cases-tests.md`.
- [ ] Loading/empty/partial/stale/error states implemented for any UI work.
- [ ] No secrets or personal data in code, logs or fixtures; deny-list check passes.
- [ ] `docs/RUNBOOK.md` updated for any new variable, job or failure mode.
- [ ] Questions or spec conflicts recorded in `docs/OPEN_QUESTIONS.md` instead of guessed.
