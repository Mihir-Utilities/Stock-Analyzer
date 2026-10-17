# B03 - Instruments, search index, stock profile

| Field | Value |
|---|---|
| Track | backend |
| Depends on | B02 |
| Size | M (S < 0.5 day, M 0.5-1.5 days, L 1.5-4 days of focused work) |

## Amendment: manual price mode (decisions D-1, D-2 and follow-ups, 2026-10-10)
Source of truth: `docs/OPEN_QUESTIONS.md` Decisions; updated specs: `docs/01` 7.0/7.1, `docs/03` 3, 4, 14, `docs/04` 3.9-3.13. Where this block conflicts with the sections below, **this block wins**.
- Depends on B02 (unchanged). Instruments are written by the **importer/form in B06a**, not by a worker (D02 is removed).
- Opening a stock sets `last_opened_at` and, if untracked, `is_tracked=true, tracked_reason='opened'` (API owns the tracked set). **No `stock_backfill` enqueue** in manual mode; return `price_mode:"manual"`, `freshness.prices_as_of`, and a hint to import prices when `no_prices`.
- Empty state: with zero instruments, `GET /stocks` and `/stocks/index` return empty and the UI text is "No stocks yet. Import instruments.csv or add a stock." (acceptance criterion added; test it).
- Flags: the `broker_ok` bit is always 0.
- `freshness.prices_stale` and `freshness.holidays_missing` per `docs/03` section 3 (4-calendar-day rule when the year's holiday list is missing). Test: **SYS-13**. Also **BRK-07** (instrument with no imported prices: `no_prices`, hint to import).

## Read first
- docs/03-api-spec.md section 3
- docs/02-database.sql instrument tables
- docs/07-edge-cases-tests.md API-01, API-02
- `CLAUDE.md` (rules), `docs/00-legal-and-safety.md` (Safe Edition guards)

## Goal
Serve the compact search index and the stock profile endpoint, including alias redirects and flags.

## In scope
- GET `/stocks/index` (ETag, flags bitmask), GET `/stocks` (server search with trigram ranking), GET `/stocks/{symbol}` (profile, quote, freshness, flags, backfill block)
- Alias resolution and `redirect_symbol`
- Side effect `last_opened_at` and enqueue of `stock_backfill` when no prices and an active broker session exists
- Correct URL-encoding handling for symbols like `M&M`, `BAJAJ-AUTO`

## Out of scope (do not do in this task)
- Price data endpoints (B04)
- Writing instruments (done by worker D02)

## Deliverables
- handlers, queries, tests, OpenAPI updates

## Steps
1. Write sqlc queries for index/search/profile
2. Implement ranking: exact > prefix > name prefix > trigram >= 0.3
3. Implement freshness block from latest rows
4. Implement backfill enqueue with the unique-active-job index (no duplicates)

## Acceptance criteria (all must be true)
- [x] Index payload for 2,300 instruments < 150 kB gz and returns ETag (`TestIndexPayloadUnder150kBGzipFor2300`: 136,606 B raw, 18,175 B gz; ETag + 304 in `TestIndexFlagsETagAndSize`)
- [x] `M&M` and `BAJAJ-AUTO` resolve (`TestSymbolsWithSpecialCharactersResolve`, API-20)
- [x] Alias returns `redirect_symbol` (`TestAliasReturnsRedirectSymbol`, API-02)
- [x] Profile of a never-opened stock enqueues exactly one backfill job (superseded by the manual-mode amendment: enqueues **zero** jobs, tracks the stock; `TestOpenStockManualModeTracksAndEnqueuesNothing`, `TestConcurrentOpensAreIdempotent`, BRK-12/API-06)

## Required tests (from `docs/07-edge-cases-tests.md`)
- `API-01` (see `docs/07-edge-cases-tests.md`)
- `API-02` (see `docs/07-edge-cases-tests.md`)
- `API-06` (see `docs/07-edge-cases-tests.md`)
- `BRK-12` (see `docs/07-edge-cases-tests.md`)
- `API-03` (see `docs/07-edge-cases-tests.md`)

## Definition of done
- [x] Behavior matches the cited spec sections exactly (note section numbers in the PR description).
- [x] Tests above exist, run in CI and pass; new edge cases discovered are added to `docs/07-edge-cases-tests.md`.
- [x] Loading/empty/partial/stale/error states implemented for any UI work.
- [x] No secrets or personal data in code, logs or fixtures; deny-list check passes.
- [x] `docs/RUNBOOK.md` updated for any new variable, job or failure mode.
- [x] Questions or spec conflicts recorded in `docs/OPEN_QUESTIONS.md` instead of guessed.
- [x] Amendment: empty state returns empty lists (`TestEmptyDatabaseListsAreEmpty`, API-05); SYS-13 (`TestPricesStaleness`, `TestProfileFreshnessRule`); BRK-07 (`no_prices` + hint); API-01, API-03 (`TestSearchKeysetPaginationStable`, `TestSearchTrigramPaginationFloatCursor`). UI work is out of scope here (F03/F04); the UI string is in docs/RUNBOOK section 11.
