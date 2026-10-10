# D04 - Mutual fund adapters and ingestion

| Field | Value |
|---|---|
| Track | data |
| Depends on | D01 |
| Size | M (S < 0.5 day, M 0.5-1.5 days, L 1.5-4 days of focused work) |

## Read first
- docs/01-data-sources.md sections 4-5
- docs/04-worker-jobs.md 3.5, 3.6
- docs/07-edge-cases-tests.md MF-*
- `CLAUDE.md` (rules), `docs/00-legal-and-safety.md` (Safe Edition guards)

## Goal
Implement mfapi and AMFI adapters, scheme sync and NAV ingestion with return caches.

## In scope
- mfapi client (list pagination, search, history with start/end, latest) with sorting, validation, plan/option parsing
- AMFI NAVAll state-machine parser and weekly enrichment/fallback
- `sync_mf_schemes`, `ingest_mf_navs`, `mf_return_cache` computation (`05` 9.2-9.3)
- Attribution constants

## Out of scope (do not do in this task)
- MF API endpoints (B10)

## Deliverables
- adapters, jobs, tests with S6/S7 fixtures

## Steps
1. Implement incremental NAV fetch by `startDate`
2. Implement jump flags and inactive marking
3. Implement return/rolling/volatility math with golden tests

## Acceptance criteria (all must be true)
- [ ] MF-02, MF-03, MF-04, MF-06, MF-07, MF-08, MF-09, MF-15 pass
- [ ] AMFI parser yields > 10,000 rows on the fixture

## Required tests (from `docs/07-edge-cases-tests.md`)
- `MF-02` (see `docs/07-edge-cases-tests.md`)
- `MF-03` (see `docs/07-edge-cases-tests.md`)
- `MF-04` (see `docs/07-edge-cases-tests.md`)
- `MF-06` (see `docs/07-edge-cases-tests.md`)
- `MF-07` (see `docs/07-edge-cases-tests.md`)
- `MF-08` (see `docs/07-edge-cases-tests.md`)
- `MF-09` (see `docs/07-edge-cases-tests.md`)
- `MF-15` (see `docs/07-edge-cases-tests.md`)

## Definition of done
- [ ] Behavior matches the cited spec sections exactly (note section numbers in the PR description).
- [ ] Tests above exist, run in CI and pass; new edge cases discovered are added to `docs/07-edge-cases-tests.md`.
- [ ] Loading/empty/partial/stale/error states implemented for any UI work.
- [ ] No secrets or personal data in code, logs or fixtures; deny-list check passes.
- [ ] `docs/RUNBOOK.md` updated for any new variable, job or failure mode.
- [ ] Questions or spec conflicts recorded in `docs/OPEN_QUESTIONS.md` instead of guessed.
