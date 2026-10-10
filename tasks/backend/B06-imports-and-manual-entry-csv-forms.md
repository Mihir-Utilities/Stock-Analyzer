# B06 - Imports and manual entry (CSV/forms)

| Field | Value |
|---|---|
| Track | backend |
| Depends on | B05 |
| Size | L (S < 0.5 day, M 0.5-1.5 days, L 1.5-4 days of focused work) |

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
