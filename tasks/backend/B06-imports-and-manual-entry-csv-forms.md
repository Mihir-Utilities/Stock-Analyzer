# B06 - Imports and manual entry (CSV/forms)

| Field | Value |
|---|---|
| Track | backend |
| Depends on | B06a: B03, B09; B06b: B05, B06a |
| Size | L (S < 0.5 day, M 0.5-1.5 days, L 1.5-4 days of focused work) |

## Amendment: manual price mode (decisions D-1, D-2 and follow-ups, 2026-10-10)
Source of truth: `docs/OPEN_QUESTIONS.md` Decisions; updated specs: `docs/01` 7.0/7.1, `docs/03` 3, 4, 14, `docs/04` 3.9-3.13. Where this block conflicts with the sections below, **this block wins**.
**This task is split (splitting rule):**
- **B06a** (depends on B03, B09): upload store in table `import_upload` (UNLOGGED, 1 h TTL, deleted on commit and by housekeeping; survives API restart); **streamed parsing**; `instruments` importer (`docs/01` 7.0 incl. `previous_symbol` rename + alias and `status`) and `POST /instruments`; `prices` importer (7.1: reserved `NIFTY50`/`INDIAVIX` -> `market_series`; limits 25 MB / 300,000 rows **only enabled after spike S9 passes, otherwise 5 MB**; chunks of 5,000 rows in one transaction; projected-size guard -> `422 DB_SIZE_LIMIT`; warn above 400 tracked stocks; set `is_tracked/imported`; enqueue `post_import`); the **required adjustment choice** (`PRICES_ALREADY_ADJUSTED`, `GET/PUT /settings/prices-adjustment`, commit blocked with `PRICES_ADJUSTMENT_UNSET`, per-bar `src_adjusted`) and `POST /imports/prices/adjustment-check` (`docs/01` 3.7); `upload_group` support for browser-split files (S9 fallback); templates for these kinds; `DELETE /stocks/{symbol}/prices` + delete-preview; `POST /prices/trim` + preview; undo refuses `prices` and `instruments` (409).
  Required tests: IMP-20, IMP-21, IMP-22, IMP-23, IMP-24, IMP-25, IMP-26, INS-14, PRC-21, BRK-08 (price sanity rules at import, `suspect` flag), BRK-09 (weekend rows dropped with warning), plus the shared-infrastructure rows IMP-01..04, 08..13, 15..17 exercised on the `instruments` and `prices` kinds, SEC-05, SAF-05.
- **B06b** (depends on B05, B06a): every other importer (results, balance/cashflow, fundamentals long, shareholding, corporate actions, instrument_meta, **holidays** per `docs/01` 7.8: replace-per-year, no example dates in the template, seed loader leaves the 2026 list empty), manual-entry endpoints, undo, parity test. Required tests: IMP-05..07, 09, 14, 17, 18, IMP-27, FND-15, SHP-05 and the shared rows re-run for these kinds.
- **Not built:** Screener import (D-5): ignore every Screener item below.

## Read first
- docs/01-data-sources.md section 7
- docs/03-api-spec.md section 14
- docs/07-edge-cases-tests.md IMP-01..IMP-19
- `CLAUDE.md` (rules), `docs/00-legal-and-safety.md` (Safe Edition guards)

## Goal
Implement validate -> preview -> commit import pipeline for every owner-data kind and the manual-entry endpoints.

## In scope
- Parsers/validators in `internal/importers` for prices, results (quarterly/annual), balance/cashflow, fundamentals long, shareholding, corporate actions, instrument_meta (+ optional Screener behind the flag)
- Upload store (1 h), preview with first 20 rows, row/column errors and warnings
- Commit in one transaction with `import_batch`; undo within 30 days (non-price)
- CSV templates endpoint; manual-entry endpoints; CSV-injection-safe exports
- Shared validation code between file and form paths (parity test)

## Out of scope (do not do in this task)
- UI wizard (F13)
- Excel parsing unless Screener flag is enabled

## Deliverables
- importers, handlers, templates, tests with fixtures

## Steps
1. Implement date/number/encoding rules exactly as specified
2. Implement per-kind validators and warnings
3. Implement upload + commit + undo + audit
4. Create fixture files for every error case in IMP-*

## Acceptance criteria (all must be true)
- [ ] All IMP-01..IMP-18 tests pass
- [ ] Commit is rejected when errors exist
- [ ] Undo works within window and refuses price batches
- [ ] No partial writes on failure (transaction test)

## Required tests (from `docs/07-edge-cases-tests.md`)
- `IMP-01` (see `docs/07-edge-cases-tests.md`)
- `IMP-02` (see `docs/07-edge-cases-tests.md`)
- `IMP-03` (see `docs/07-edge-cases-tests.md`)
- `IMP-04` (see `docs/07-edge-cases-tests.md`)
- `IMP-05` (see `docs/07-edge-cases-tests.md`)
- `IMP-06` (see `docs/07-edge-cases-tests.md`)
- `IMP-07` (see `docs/07-edge-cases-tests.md`)
- `IMP-08` (see `docs/07-edge-cases-tests.md`)
- `IMP-09` (see `docs/07-edge-cases-tests.md`)
- `IMP-10` (see `docs/07-edge-cases-tests.md`)
- `IMP-11` (see `docs/07-edge-cases-tests.md`)
- `IMP-12` (see `docs/07-edge-cases-tests.md`)
- `IMP-13` (see `docs/07-edge-cases-tests.md`)
- `IMP-14` (see `docs/07-edge-cases-tests.md`)
- `IMP-15` (see `docs/07-edge-cases-tests.md`)
- `IMP-16` (see `docs/07-edge-cases-tests.md`)
- `IMP-17` (see `docs/07-edge-cases-tests.md`)
- `IMP-18` (see `docs/07-edge-cases-tests.md`)
- `SEC-05` (see `docs/07-edge-cases-tests.md`)
- `SAF-05` (see `docs/07-edge-cases-tests.md`)
- `FND-15` (see `docs/07-edge-cases-tests.md`)
- `SHP-05` (see `docs/07-edge-cases-tests.md`)

## Definition of done
- [ ] Behavior matches the cited spec sections exactly (note section numbers in the PR description).
- [ ] Tests above exist, run in CI and pass; new edge cases discovered are added to `docs/07-edge-cases-tests.md`.
- [ ] Loading/empty/partial/stale/error states implemented for any UI work.
- [ ] No secrets or personal data in code, logs or fixtures; deny-list check passes.
- [ ] `docs/RUNBOOK.md` updated for any new variable, job or failure mode.
- [ ] Questions or spec conflicts recorded in `docs/OPEN_QUESTIONS.md` instead of guessed.
