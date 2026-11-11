# B15 - Mutual fund holdings: ledger, API, statement importer

| Field | Value |
|---|---|
| Track | backend |
| Depends on | B11 (portfolio engine, idempotency), B06a (upload store and import pattern), B10 (mf_scheme/mf_nav reads), D04 (NAV data), T02; spike S18 for the `.xlsx` reader only |
| Size | L (S < 0.5 day, M 0.5-1.5 days, L 1.5-4 days of focused work) |
| Status | BUILT (2026-11-11; spec amended by D-MF3: real statement header, stamp duty separate, fund-name mapping, multiset duplicates; stdlib `.xlsx` reader, B15-1) |

## Read first
- docs/03-api-spec.md sections 1, 12, 12a, 14
- docs/05-analytics-spec.md sections 1, 8.3, 8.5, 9.1, 9.5
- docs/01-data-sources.md section 7.9
- docs/02-database.sql (proposed migration 0014 block at the end)
- docs/07-edge-cases-tests.md rows MFH-V, MFH-I, MFH-F, PF-*
- `CLAUDE.md` (rules), `docs/00-legal-and-safety.md` (Safe Edition guards), `docs/OPEN_QUESTIONS.md` decision D-MF and questions MFH-1..MFH-22

## Goal
Add mutual fund holdings to the portfolio: a `mf_txn` ledger, `GET/POST/PATCH/DELETE /portfolio/mf/txns`, `GET /portfolio/mf/holdings`, `GET /portfolio/summary?view=all|equity|mf`, and the `mf_statement` importer, exactly as specified (D-MF). Money invested, current value, profit/loss and XIRR per view.

## In scope
- Migration `0014_mf_txn` (forward-only, from the proposed block in `docs/02`; move the final DDL into `docs/02-database.sql` in the same change): `mf_txn`, indexes, ISIN indexes on `mf_scheme`, `import_batch.kind` gains `mf_statement`.
- Logical ledger with `asset_class`; MF lot engine (FIFO per scheme+folio), value, invested, unrealised/realised/IDCW buckets, pooled XIRR per view, the one-year rule (`docs/05` 8.5, decimals only, `shopspring/decimal`), amend PF-07 and the equity `xirr_reason` per MFH-3 once the owner confirms.
- Transactions API with idempotency, CSRF, validation, sequence re-validation, tracking side effect; holdings API; summary `view` parameter (default `equity`, MFH-14).
- Importer `mf_statement` (validate, commit, undo, template): CSV template first; `.xlsx` reader only after S18 GO and MFH-15; size/type limits, read-only parsing, personal columns discarded, CSV-injection safety, dedupe key.
- `openapi.yaml`, `docs/field-map.json` and `packages/api-types` regenerated together (`npm run check:generated` clean); D08 backup list gains `mf_txn`; RUNBOOK section 130 finalised.

## Out of scope
- Any UI (F16); switch, merger and bonus types (MFH-4, MFH-22); benchmark for All/MF (MFH-9); capital-gains tax; fetching anything from the internet (NAV stays AMFI via mfapi.in); broker APIs; order code.

## Steps
1. Migration and sqlc/pgx queries; 2. lot engine and XIRR with the golden vectors of `docs/05` 8.5.5; 3. transactions and holdings handlers; 4. summary views; 5. importer (CSV, then xlsx if allowed); 6. contract regeneration; 7. tests and RUNBOOK.

## Acceptance criteria (all must be true)
- [x] Every row MFH-V01..V16, MFH-I20..I36, MFH-F40..F63 passes (MFH-F61 in the worker backup tests, MFH-F62 by `check:generated` and the router/OpenAPI test); MFH-F60 stays N/A.
- [x] Golden vectors of `docs/05` 8.5.5 pass within 1e-4; the pooled XIRR is never the average of the two.
- [x] `view=equity` (and a missing `view`) returns exactly the pre-D-MF stocks-only response (existing PF tests still pass, PF-07 amended per MFH-3).
- [x] No new egress host; deny-list, SAF-13 and licence scan pass; no secrets or personal data in logs or fixtures (MFH-I30).
- [x] Contract-first: docs/03, openapi.yaml, field-map.json and generated types agree.

## Required tests
`MFH-V01..V15`, `MFH-I20..I32`, `MFH-F40..F62`, `PF-01..PF-15` (regression), `SAF-01`, `SAF-13`.

## Definition of done
- [x] Behaviour matches the cited spec sections exactly; tests pass in CI; new edge cases added to `docs/07`.
- [x] `docs/RUNBOOK.md` updated; questions recorded in `docs/OPEN_QUESTIONS.md` instead of guessed.
