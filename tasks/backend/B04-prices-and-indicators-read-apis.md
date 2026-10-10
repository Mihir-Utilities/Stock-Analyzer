# B04 - Prices and indicators read APIs

| Field | Value |
|---|---|
| Track | backend |
| Depends on | B03 |
| Size | M (S < 0.5 day, M 0.5-1.5 days, L 1.5-4 days of focused work) |

## Amendment: manual price mode (decisions D-1, D-2 and follow-ups, 2026-10-10)
Source of truth: `docs/OPEN_QUESTIONS.md` Decisions; updated specs: `docs/01` 7.0/7.1, `docs/03` 3, 4, 14, `docs/04` 3.9-3.13. Where this block conflicts with the sections below, **this block wins**.
- Empty price series returns `DATA_UNAVAILABLE` with reason `no_prices_imported` (manual mode) instead of `backfill_pending`/`broker_*`.
- Test **BRK-06** (imported history shorter than expected: `limited_history`, depth stated).
- `freshness.prices_as_of` = last imported bar date; no quote/`quote_ts` in manual mode (ltp = last close, source `import`).

## Read first
- docs/03-api-spec.md section 4
- docs/05-analytics-spec.md sections 3-4
- docs/07-edge-cases-tests.md API-04
- `CLAUDE.md` (rules), `docs/00-legal-and-safety.md` (Safe Edition guards)

## Goal
Serve adjusted/raw bars with downsampling and the precomputed indicator snapshot.

## In scope
- GET `/stocks/{symbol}/prices` with ranges, adjusted flag, actions markers, weekly aggregation when > 2,000 points, suspect rows excluded
- GET `/stocks/{symbol}/indicators` returning the latest `analysis_snapshot` incl. series arrays (<= 750 rows)
- `DATA_UNAVAILABLE` reasons (`backfill_pending`, `broker_unavailable`, `broker_session_missing`, `no_history`)
- Warnings (`UNCONFIRMED_ACTION`)

## Out of scope (do not do in this task)
- Computing indicators (worker D05)

## Deliverables
- handlers, aggregation helper (weekly OHLCV), tests

## Steps
1. Implement weekly aggregation (open of first, high max, low min, close of last, volume sum)
2. Implement adjusted scaling by `adj_close/close`
3. Add detected-action warning lookup
4. Add golden tests with fixture bars

## Acceptance criteria (all must be true)
- [ ] MAX range returns <= 2,000 points and < 150 kB gz
- [ ] Weekly aggregation matches hand-computed example
- [ ] Suspect rows never returned
- [ ] Empty DB returns `DATA_UNAVAILABLE` not 500

## Required tests (from `docs/07-edge-cases-tests.md`)
- `API-04` (see `docs/07-edge-cases-tests.md`)
- `API-05` (see `docs/07-edge-cases-tests.md`)
- `BRK-08` (see `docs/07-edge-cases-tests.md`)

## Definition of done
- [ ] Behavior matches the cited spec sections exactly (note section numbers in the PR description).
- [ ] Tests above exist, run in CI and pass; new edge cases discovered are added to `docs/07-edge-cases-tests.md`.
- [ ] Loading/empty/partial/stale/error states implemented for any UI work.
- [ ] No secrets or personal data in code, logs or fixtures; deny-list check passes.
- [ ] `docs/RUNBOOK.md` updated for any new variable, job or failure mode.
- [ ] Questions or spec conflicts recorded in `docs/OPEN_QUESTIONS.md` instead of guessed.
