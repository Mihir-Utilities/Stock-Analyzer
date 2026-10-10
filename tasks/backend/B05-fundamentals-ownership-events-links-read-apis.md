# B05 - Fundamentals, ownership, events, links read APIs

| Field | Value |
|---|---|
| Track | backend |
| Depends on | B03 |
| Size | M (S < 0.5 day, M 0.5-1.5 days, L 1.5-4 days of focused work) |

## Read first
- docs/03-api-spec.md section 5
- docs/05-analytics-spec.md sections 2, 5
- docs/01-data-sources.md section 9
- `CLAUDE.md` (rules), `docs/00-legal-and-safety.md` (Safe Edition guards)

## Goal
Serve owner-supplied fundamentals/shareholding/events with derived metrics from snapshots and research links.

## In scope
- GET fundamentals (basis auto/consolidated/standalone, period Q/A) with periods, labels, metrics, `derived`, `ratios`, `valuation`, depth and source info, `entry_hint`
- GET shareholding (series, qoq change, `mf_available`)
- GET events (actions incl. detected/rejected, calendar)
- GET links from `config/research_links.json` (URL-encoded)
- Fiscal label generator shared with tests

## Out of scope (do not do in this task)
- Writing data (B06)
- Computing derived metrics (worker D05)

## Deliverables
- handlers, label generator, tests

## Steps
1. Implement source priority rule `manual > csv_import > screener_import`
2. Implement basis auto-selection and per-series consistency
3. Implement label generator (FY/quarter) with boundary tests
4. Implement links with placeholder substitution and encoding

## Acceptance criteria (all must be true)
- [ ] FND-01, FND-02, FND-11, FND-12, SHP-01, SHP-04 pass
- [ ] Missing data returns nulls with reasons, never zeros
- [ ] Links contain properly encoded `M%26M`

## Required tests (from `docs/07-edge-cases-tests.md`)
- `FND-01` (see `docs/07-edge-cases-tests.md`)
- `FND-02` (see `docs/07-edge-cases-tests.md`)
- `FND-03` (see `docs/07-edge-cases-tests.md`)
- `FND-11` (see `docs/07-edge-cases-tests.md`)
- `FND-12` (see `docs/07-edge-cases-tests.md`)
- `SHP-01` (see `docs/07-edge-cases-tests.md`)
- `SHP-04` (see `docs/07-edge-cases-tests.md`)
- `SAF-06` (see `docs/07-edge-cases-tests.md`)

## Definition of done
- [ ] Behavior matches the cited spec sections exactly (note section numbers in the PR description).
- [ ] Tests above exist, run in CI and pass; new edge cases discovered are added to `docs/07-edge-cases-tests.md`.
- [ ] Loading/empty/partial/stale/error states implemented for any UI work.
- [ ] No secrets or personal data in code, logs or fixtures; deny-list check passes.
- [ ] `docs/RUNBOOK.md` updated for any new variable, job or failure mode.
- [ ] Questions or spec conflicts recorded in `docs/OPEN_QUESTIONS.md` instead of guessed.
