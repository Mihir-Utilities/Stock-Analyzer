# B11 - Watchlist and portfolio

| Field | Value |
|---|---|
| Track | backend |
| Depends on | B03, B04 |
| Size | L (S < 0.5 day, M 0.5-1.5 days, L 1.5-4 days of focused work) |

## Amendment: manual price mode (decisions D-1, D-2 and follow-ups, 2026-10-10)
Source of truth: `docs/OPEN_QUESTIONS.md` Decisions; updated specs: `docs/01` 7.0/7.1, `docs/03` 3, 4, 14, `docs/04` 3.9-3.13. Where this block conflicts with the sections below, **this block wins**.
- Watchlist add and portfolio txns set `is_tracked` (`watchlist`/`portfolio`) but do **not** enqueue backfills in manual mode.

## Read first
- docs/03-api-spec.md sections 11-12
- docs/05-analytics-spec.md section 8
- docs/07-edge-cases-tests.md PF-*
- `CLAUDE.md` (rules), `docs/00-legal-and-safety.md` (Safe Edition guards)

## Goal
Implement watchlist and the stocks-only portfolio with FIFO realized, average-cost unrealized, adjustments and XIRR.

## In scope
- Watchlist CRUD with tracking side effects
- Transactions CRUD with validation (no oversell at any date, listing date, future dates), Idempotency-Key
- Summary: holdings, totals, day change, allocation, realized (FIFO), unrealized (avg cost), XIRR, benchmark vs NIFTY50 if available, adjustments applied/override, estimated dividends
- Decimal arithmetic (`shopspring/decimal`), money as strings

## Out of scope (do not do in this task)
- UI

## Deliverables
- handlers, `internal/portfolio`, tests

## Steps
1. Implement lot engine with confirmed corporate actions
2. Implement revalidation of the full sequence on edit/delete
3. Implement summary with stale-price handling
4. Create golden scenario tests (splits, same-day trades, full exit)

## Acceptance criteria (all must be true)
- [ ] PF-01..PF-15 pass
- [ ] Sum precision test (0.1+0.2) exact
- [ ] Portfolio value invariant under a confirmed split

## Required tests (from `docs/07-edge-cases-tests.md`)
- `PF-01` (see `docs/07-edge-cases-tests.md`)
- `PF-02` (see `docs/07-edge-cases-tests.md`)
- `PF-03` (see `docs/07-edge-cases-tests.md`)
- `PF-04` (see `docs/07-edge-cases-tests.md`)
- `PF-05` (see `docs/07-edge-cases-tests.md`)
- `PF-06` (see `docs/07-edge-cases-tests.md`)
- `PF-07` (see `docs/07-edge-cases-tests.md`)
- `PF-08` (see `docs/07-edge-cases-tests.md`)
- `PF-09` (see `docs/07-edge-cases-tests.md`)
- `PF-10` (see `docs/07-edge-cases-tests.md`)
- `PF-11` (see `docs/07-edge-cases-tests.md`)
- `PF-12` (see `docs/07-edge-cases-tests.md`)
- `PF-13` (see `docs/07-edge-cases-tests.md`)
- `PF-14` (see `docs/07-edge-cases-tests.md`)
- `PF-15` (see `docs/07-edge-cases-tests.md`)
- `ACT-05` (see `docs/07-edge-cases-tests.md`)
- `ACT-08` (see `docs/07-edge-cases-tests.md`)

## Definition of done
- [ ] Behavior matches the cited spec sections exactly (note section numbers in the PR description).
- [ ] Tests above exist, run in CI and pass; new edge cases discovered are added to `docs/07-edge-cases-tests.md`.
- [ ] Loading/empty/partial/stale/error states implemented for any UI work.
- [ ] No secrets or personal data in code, logs or fixtures; deny-list check passes.
- [ ] `docs/RUNBOOK.md` updated for any new variable, job or failure mode.
- [ ] Questions or spec conflicts recorded in `docs/OPEN_QUESTIONS.md` instead of guessed.
