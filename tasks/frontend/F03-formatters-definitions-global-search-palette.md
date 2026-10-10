# F03 - Formatters, definitions, global search palette

| Field | Value |
|---|---|
| Track | frontend |
| Depends on | F01 |
| Size | M (S < 0.5 day, M 0.5-1.5 days, L 1.5-4 days of focused work) |

## Amendment: manual price mode (decisions D-1, D-2 and follow-ups, 2026-10-10)
Source of truth: `docs/OPEN_QUESTIONS.md` Decisions; updated specs: `docs/01` 7.0/7.1, `docs/03` 3, 4, 14, `docs/04` 3.9-3.13. Where this block conflicts with the sections below, **this block wins**.
- Empty state when no instruments: "No stocks yet. Import instruments.csv or add a stock." (links to Import center / Add stock). The `No broker data` badge is not shown in manual mode.

## Read first
- docs/06-frontend-spec.md sections 3, 4.1
- docs/07-edge-cases-tests.md UI-02, UI-05, INS-like symbol cases
- `CLAUDE.md` (rules), `docs/00-legal-and-safety.md` (Safe Edition guards)

## Goal
Implement `format.ts`, generated definitions and the instant client-side search.

## In scope
- All formatters (INR Indian grouping, crore/lakh crore, percent, multiples, dates, relative times, fiscal labels, null-with-reason)
- `definitions.ts` generated from the analytics spec (formula tooltips)
- Search palette with IndexedDB cache, ranking and keyboard navigation; funds via debounced server search
- Recent searches

## Out of scope (do not do in this task)
- Nothing else; stay within the scope above.

## Deliverables
- `lib/format`, `lib/definitions`, `components/search`, tests

## Steps
1. Write formatter tests first (null, zero, negative, huge, tiny)
2. Implement ranking with fuzzy matching and tests for `M&M`, `BAJAJ-AUTO`
3. Benchmark search at 2,300 items

## Acceptance criteria (all must be true)
- [ ] Search opens < 100 ms with cached index
- [ ] `M&M` and `BAJAJ-AUTO` found by typing `M&M`/`MM`
- [ ] Fiscal label tests pass for boundary months

## Required tests (from `docs/07-edge-cases-tests.md`)
- `UI-02` (see `docs/07-edge-cases-tests.md`)
- `UI-05` (see `docs/07-edge-cases-tests.md`)
- `FND-01` (see `docs/07-edge-cases-tests.md`)

## Definition of done
- [ ] Behavior matches the cited spec sections exactly (note section numbers in the PR description).
- [ ] Tests above exist, run in CI and pass; new edge cases discovered are added to `docs/07-edge-cases-tests.md`.
- [ ] Loading/empty/partial/stale/error states implemented for any UI work.
- [ ] No secrets or personal data in code, logs or fixtures; deny-list check passes.
- [ ] `docs/RUNBOOK.md` updated for any new variable, job or failure mode.
- [ ] Questions or spec conflicts recorded in `docs/OPEN_QUESTIONS.md` instead of guessed.
