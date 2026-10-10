# B14 - Prediction read API, market overview, admin status

| Field | Value |
|---|---|
| Track | backend |
| Depends on | B04, D07 |
| Size | M (S < 0.5 day, M 0.5-1.5 days, L 1.5-4 days of focused work) |

## Read first
- docs/03-api-spec.md sections 6, 8, 15
- docs/05-analytics-spec.md section 10.6
- docs/07-edge-cases-tests.md ML-*
- `CLAUDE.md` (rules), `docs/00-legal-and-safety.md` (Safe Edition guards)

## Goal
Expose forecasts with guardrail reasons, the market overview and the admin/data-health endpoints.

## In scope
- GET prediction with buckets, hidden reasons, model card, live track record (no single price target)
- GET market overview from stored index series; market status from holidays file
- GET admin status: source health, last runs, coverage, DB size per table with warn levels

## Out of scope (do not do in this task)
- ML training (D07)

## Deliverables
- handlers, tests

## Steps
1. Implement bucket mapping and hidden-reason enum
2. Implement DB size queries and thresholds (70/85%)

## Acceptance criteria (all must be true)
- [ ] ML-04, ML-05, ML-06, ML-12-related API behavior pass
- [ ] Admin shows broker session state and holiday-file status

## Required tests (from `docs/07-edge-cases-tests.md`)
- `ML-04` (see `docs/07-edge-cases-tests.md`)
- `ML-05` (see `docs/07-edge-cases-tests.md`)
- `ML-06` (see `docs/07-edge-cases-tests.md`)
- `SYS-10` (see `docs/07-edge-cases-tests.md`)

## Definition of done
- [ ] Behavior matches the cited spec sections exactly (note section numbers in the PR description).
- [ ] Tests above exist, run in CI and pass; new edge cases discovered are added to `docs/07-edge-cases-tests.md`.
- [ ] Loading/empty/partial/stale/error states implemented for any UI work.
- [ ] No secrets or personal data in code, logs or fixtures; deny-list check passes.
- [ ] `docs/RUNBOOK.md` updated for any new variable, job or failure mode.
- [ ] Questions or spec conflicts recorded in `docs/OPEN_QUESTIONS.md` instead of guessed.
