# B10 - Mutual fund APIs

| Field | Value |
|---|---|
| Track | backend |
| Depends on | B02, D04 |
| Size | M (S < 0.5 day, M 0.5-1.5 days, L 1.5-4 days of focused work) |

## Read first
- docs/03-api-spec.md section 10
- docs/05-analytics-spec.md section 9
- docs/07-edge-cases-tests.md MF-*
- `CLAUDE.md` (rules), `docs/00-legal-and-safety.md` (Safe Edition guards)

## Goal
Serve scheme search, detail, NAV series, returns, SIP simulation and compare.

## In scope
- Scheme search (trigram) with Direct/Growth defaults, grouping, categories
- Scheme detail with return table from `mf_return_cache`, warnings, backfill block
- NAV series downsampling, SIP simulation (`05` 9.4), compare with common-date rebasing
- Attribution field in responses (`attribution`: 'AMFI via mfapi.in')

## Out of scope (do not do in this task)
- Ingestion (D04)

## Deliverables
- handlers, SIP/XIRR code (shared with portfolio), tests

## Steps
1. Implement XIRR (Brent) once in `internal/finmath` and reuse
2. Implement SIP schedule/units logic
3. Add golden test for the XIRR vector in the spec

## Acceptance criteria (all must be true)
- [ ] MF-01, MF-04, MF-10, MF-11, MF-12, MF-13, MF-14 pass
- [ ] XIRR test vector within 1e-4

## Required tests (from `docs/07-edge-cases-tests.md`)
- `MF-01` (see `docs/07-edge-cases-tests.md`)
- `MF-04` (see `docs/07-edge-cases-tests.md`)
- `MF-10` (see `docs/07-edge-cases-tests.md`)
- `MF-11` (see `docs/07-edge-cases-tests.md`)
- `MF-12` (see `docs/07-edge-cases-tests.md`)
- `MF-13` (see `docs/07-edge-cases-tests.md`)
- `MF-14` (see `docs/07-edge-cases-tests.md`)

## Definition of done
- [ ] Behavior matches the cited spec sections exactly (note section numbers in the PR description).
- [ ] Tests above exist, run in CI and pass; new edge cases discovered are added to `docs/07-edge-cases-tests.md`.
- [ ] Loading/empty/partial/stale/error states implemented for any UI work.
- [ ] No secrets or personal data in code, logs or fixtures; deny-list check passes.
- [ ] `docs/RUNBOOK.md` updated for any new variable, job or failure mode.
- [ ] Questions or spec conflicts recorded in `docs/OPEN_QUESTIONS.md` instead of guessed.
