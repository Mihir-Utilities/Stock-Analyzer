# T01 - Phase 0 feasibility spikes

| Field | Value |
|---|---|
| Track | foundation |
| Depends on | T00 |
| Size | L (S < 0.5 day, M 0.5-1.5 days, L 1.5-4 days of focused work) |

## Amendment: manual price mode (decisions D-1, D-2 and follow-ups, 2026-10-10)
Source of truth: `docs/OPEN_QUESTIONS.md` Decisions; updated specs: `docs/01` 7.0/7.1, `docs/03` 3, 4, 14, `docs/04` 3.9-3.13. Where this block conflicts with the sections below, **this block wins**.
- S1 is recorded as "manual price mode" (fill `docs/BROKER_DECISION.md` Decision accordingly; no comparison needed). **S2-S5 skipped** (`N/A (manual mode)`). S8 uses owner-imported price files. **S9 adds a 25 MB / 300,000-row upload through the Vercel `/api` rewrite**; record the largest size that passes and amend B06a/F13a (browser-split fallback) as specified in `docs/08`. S5 is replaced by loading reserved `NIFTY50`/`INDIAVIX` rows into `market_series`.
- No broker login is ever needed.

## Read first
- docs/08-phase0-spikes.md (all)
- docs/01-data-sources.md section 3
- docs/00-legal-and-safety.md
- `CLAUDE.md` (rules), `docs/00-legal-and-safety.md` (Safe Edition guards)

## Goal
Measure every unverified assumption and decide the broker (or manual price mode) before building on it.

## In scope
- Run spikes S1-S17 as written; owner performs any login steps
- Write `docs/BROKER_DECISION.md` (S1) and `docs/SPIKE_RESULTS.md`
- Save redacted fixtures under `/fixtures/`
- Amend spec files wherever a spike changes a decision (note each amendment in the spike entry)

## Out of scope (do not do in this task)
- Building product features
- Automating any broker login

## Deliverables
- `docs/BROKER_DECISION.md`
- `docs/SPIKE_RESULTS.md`
- `/fixtures/*`
- `docs/TERMS_NOTES.md`

## Steps
1. Ask the owner whether they have a broker account and which; if none, mark manual price mode
2. Run S1 first (decides the rest); then S2-S5 for the chosen broker
3. Run S6-S12 and S14-S17
4. For each NO-GO, amend specs and report to the owner before proceeding

## Acceptance criteria (all must be true)
- [ ] Every spike has a verdict and evidence
- [ ] `BROKER_DECISION.md` states the chosen broker or manual price mode with reasons
- [ ] Specs amended and consistent after changes
- [ ] Owner has reviewed `TERMS_NOTES.md`

## Required tests (from `docs/07-edge-cases-tests.md`)
- n/a (the spikes are the tests)
- `BRK-14` (see `docs/07-edge-cases-tests.md`)

## Definition of done
- [ ] Behavior matches the cited spec sections exactly (note section numbers in the PR description).
- [ ] Tests above exist, run in CI and pass; new edge cases discovered are added to `docs/07-edge-cases-tests.md`.
- [ ] Loading/empty/partial/stale/error states implemented for any UI work.
- [ ] No secrets or personal data in code, logs or fixtures; deny-list check passes.
- [ ] `docs/RUNBOOK.md` updated for any new variable, job or failure mode.
- [ ] Questions or spec conflicts recorded in `docs/OPEN_QUESTIONS.md` instead of guessed.
