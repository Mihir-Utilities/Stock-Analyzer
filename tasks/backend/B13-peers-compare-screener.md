# B13 - Peers, compare, screener

| Field | Value |
|---|---|
| Track | backend |
| Depends on | B05, D05 |
| Size | M (S < 0.5 day, M 0.5-1.5 days, L 1.5-4 days of focused work) |

## Read first
- docs/03-api-spec.md sections 5 (peers), 8, 9
- docs/05-analytics-spec.md section 7
- docs/07-edge-cases-tests.md SEC-04
- `CLAUDE.md` (rules), `docs/00-legal-and-safety.md` (Safe Edition guards)

## Goal
Serve peer tables, stock comparison and the whitelisted screener over precomputed rows.

## In scope
- Peers per the algorithm (requires owner sector/industry; otherwise `DATA_UNAVAILABLE reason=no_sector_data`)
- Compare endpoint (2-5 symbols, rebase, metrics, best)
- Screener query with metric whitelist, parameterised SQL over `screener_row.metrics`, coverage and `excluded_for_missing`, saved screens in `app_setting`, presets

## Out of scope (do not do in this task)
- Computing `screener_row` (worker D05)

## Deliverables
- handlers, query builder, fuzz tests

## Steps
1. Implement whitelist map and SQL builder (no string interpolation of user values)
2. Add fuzz tests for injection
3. Implement preset definitions in code

## Acceptance criteria (all must be true)
- [ ] SEC-04 fuzz passes
- [ ] Peers fall back sector -> relaxed market-cap range per spec
- [ ] Compare handles short histories

## Required tests (from `docs/07-edge-cases-tests.md`)
- `SEC-04` (see `docs/07-edge-cases-tests.md`)
- `MF-14` (see `docs/07-edge-cases-tests.md`)
- `FND-14` (see `docs/07-edge-cases-tests.md`)

## Definition of done
- [ ] Behavior matches the cited spec sections exactly (note section numbers in the PR description).
- [ ] Tests above exist, run in CI and pass; new edge cases discovered are added to `docs/07-edge-cases-tests.md`.
- [ ] Loading/empty/partial/stale/error states implemented for any UI work.
- [ ] No secrets or personal data in code, logs or fixtures; deny-list check passes.
- [ ] `docs/RUNBOOK.md` updated for any new variable, job or failure mode.
- [ ] Questions or spec conflicts recorded in `docs/OPEN_QUESTIONS.md` instead of guessed.
