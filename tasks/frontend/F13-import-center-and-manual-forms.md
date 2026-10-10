# F13 - Import center and manual forms

| Field | Value |
|---|---|
| Track | frontend |
| Depends on | F13a: F02, B06a; F13b: F02, B06b |
| Size | L (S < 0.5 day, M 0.5-1.5 days, L 1.5-4 days of focused work) |

## Amendment: manual price mode (decisions D-1, D-2 and follow-ups, 2026-10-10)
Source of truth: `docs/OPEN_QUESTIONS.md` Decisions; updated specs: `docs/01` 7.0/7.1, `docs/03` 3, 4, 14, `docs/04` 3.9-3.13. Where this block conflicts with the sections below, **this block wins**.
**This task is split:**
- **F13a** (depends on F02, B06a): wizard for `instruments` and `prices` with estimated DB growth and the size-guard message, template download, **Add stock** form (symbol, name, optional ISIN), **Storage tab** (DB meter vs 380 MB, 70/85/95% warnings, **Trim history**: pick stocks + cutoff date, preview, ConfirmDialog), "Delete prices between {from} and {to}" action on the stock Data tab, and browser-side splitting of large price CSVs if S9 shows the proxy limit is below 25 MB (one `upload_group`, one transaction at commit). UI paths for IMP-20..24 and PRC-21.
- **F13b** (depends on F02, B06b): remaining wizards/forms (results, annual, shareholding, corporate action, calendar event), batches list with undo (price and instruments batches not undoable).
- **Not built:** the optional Screener tab (D-5).

## Read first
- docs/06-frontend-spec.md section 6.10
- docs/01-data-sources.md section 7
- docs/07-edge-cases-tests.md IMP-*
- `CLAUDE.md` (rules), `docs/00-legal-and-safety.md` (Safe Edition guards)

## Goal
Build the wizard for every import kind, templates, manual forms and batch management.

## In scope
- Wizard: upload -> validate -> preview (20 rows, error list, warnings) -> commit with note
- Templates download; manual forms (results, annual, shareholding, action, calendar event); batches list with undo and overwrite warning
- Persistent rights notice; optional Screener tab only when enabled

## Out of scope (do not do in this task)
- Nothing else; stay within the scope above.

## Deliverables
- `app/imports/*`

## Steps
1. Render server row/column errors inline
2. Block commit while errors exist
3. E2E with fixture files for every error type

## Acceptance criteria (all must be true)
- [ ] IMP-01..IMP-14 UX paths verified
- [ ] Undo of price batches is not offered

## Required tests (from `docs/07-edge-cases-tests.md`)
- `IMP-01` (see `docs/07-edge-cases-tests.md`)
- `IMP-11` (see `docs/07-edge-cases-tests.md`)
- `IMP-12` (see `docs/07-edge-cases-tests.md`)
- `IMP-14` (see `docs/07-edge-cases-tests.md`)
- `SAF-05` (see `docs/07-edge-cases-tests.md`)

## Definition of done
- [ ] Behavior matches the cited spec sections exactly (note section numbers in the PR description).
- [ ] Tests above exist, run in CI and pass; new edge cases discovered are added to `docs/07-edge-cases-tests.md`.
- [ ] Loading/empty/partial/stale/error states implemented for any UI work.
- [ ] No secrets or personal data in code, logs or fixtures; deny-list check passes.
- [ ] `docs/RUNBOOK.md` updated for any new variable, job or failure mode.
- [ ] Questions or spec conflicts recorded in `docs/OPEN_QUESTIONS.md` instead of guessed.
