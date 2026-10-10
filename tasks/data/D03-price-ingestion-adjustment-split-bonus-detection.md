# D03 - Price ingestion, adjustment, split/bonus detection

| Field | Value |
|---|---|
| Track | data |
| Depends on | D01 |
| Size | L (S < 0.5 day, M 0.5-1.5 days, L 1.5-4 days of focused work) |

## Amendment: manual price mode (decisions D-1, D-2 and follow-ups, 2026-10-10)
Source of truth: `docs/OPEN_QUESTIONS.md` Decisions; updated specs: `docs/01` 7.0/7.1, `docs/03` 3, 4, 14, `docs/04` 3.9-3.13. Where this block conflicts with the sections below, **this block wins**.
- Depends on **D01** (D02 removed).
- **Not built:** `ingest_prices_eod`, `price_completeness_retry`, holiday auto-detection (removed everywhere, `docs/04`), partial-bar rule, broker candle handling.
- **Adjustment (D-K):** use `PRICES_ALREADY_ADJUSTED` and the per-bar `price_daily.src_adjusted` (`docs/01` 3.7): `adj_close = close x factor` only for `src_adjusted=false` bars; `src_adjusted=true` bars keep `adj_close = close`; `detect_actions` sets `ADJUSTMENT_CONFLICT` when a detected ex-date falls inside `src_adjusted=true` bars. Tests: **ACT-11, ACT-12**.
- **Built:** `detect_actions`; re-adjustment job; **`post_import`** (`docs/04` 3.12: ordered symbols; per symbol detect_actions -> compute_analysis (D05 hook) -> alert evaluation (D06 hook); stop starting symbols at 3.5 min, write progress to `refresh_job.result`, status `partial`, enqueue the remainder); **`process_queued_jobs`** (3.13, daily 19:00 IST).
- Tests: SYS-12, ACT-* rows assigned here, SYS-09. BRK rows listed below: BRK-09, BRK-10, BRK-11, BRK-13, BRK-20 are N/A in manual mode (BRK-09 weekend handling and BRK-08 sanity rules moved to B06a); BRK-18 (timezone boundaries) and BRK-19 (duplicate bars: upsert, stable counts) still apply.

## Read first
- docs/04-worker-jobs.md 3.2, 3.4
- docs/01-data-sources.md 3.5, 3.7
- docs/05-analytics-spec.md section 8.2
- docs/07-edge-cases-tests.md BRK-08..BRK-20, ACT-*
- `CLAUDE.md` (rules), `docs/00-legal-and-safety.md` (Safe Edition guards)

## Goal
Ingest daily candles with sanity rules, compute `adj_close` from confirmed actions, detect candidate splits/bonuses.

## In scope
- `ingest_prices_eod`, `price_completeness_retry`, `detect_actions`, re-adjustment job, process-queued-jobs step
- Sanity rules and `suspect` flags; (holiday detection: removed); partial-bar rule
- Detector with fraction list, thresholds and volume rule from the spec (configurable)
- Prices import interplay (source labeling, upsert)
- `PRICES_ALREADY_ADJUSTED` / `src_adjusted` handling

## Out of scope (do not do in this task)
- Alerts, analysis

## Deliverables
- jobs, detector module, tests with real-event fixtures from S4/S8

## Steps
1. Implement ingestion loop with expected-date logic
2. Implement adjustments as a single set-based UPDATE per stock
3. Implement detector and tune with S8 results
4. Telegram note for new detections (once per action)

## Acceptance criteria (all must be true)
- [ ] BRK-08..BRK-11, BRK-13, BRK-19, BRK-20 and ACT-01, ACT-02, ACT-07 pass
- [ ] Re-adjust job leaves portfolio and indicators consistent after confirmation
- [ ] Detector false-positive rate meets S8 criteria

## Required tests (from `docs/07-edge-cases-tests.md`)
- `BRK-08` (see `docs/07-edge-cases-tests.md`)
- `BRK-09` (see `docs/07-edge-cases-tests.md`)
- `BRK-10` (see `docs/07-edge-cases-tests.md`)
- `BRK-11` (see `docs/07-edge-cases-tests.md`)
- `BRK-13` (see `docs/07-edge-cases-tests.md`)
- `BRK-18` (see `docs/07-edge-cases-tests.md`)
- `BRK-19` (see `docs/07-edge-cases-tests.md`)
- `BRK-20` (see `docs/07-edge-cases-tests.md`)
- `ACT-01` (see `docs/07-edge-cases-tests.md`)
- `ACT-02` (see `docs/07-edge-cases-tests.md`)
- `ACT-07` (see `docs/07-edge-cases-tests.md`)

## Definition of done
- [ ] Behavior matches the cited spec sections exactly (note section numbers in the PR description).
- [ ] Tests above exist, run in CI and pass; new edge cases discovered are added to `docs/07-edge-cases-tests.md`.
- [ ] Loading/empty/partial/stale/error states implemented for any UI work.
- [ ] No secrets or personal data in code, logs or fixtures; deny-list check passes.
- [ ] `docs/RUNBOOK.md` updated for any new variable, job or failure mode.
- [ ] Questions or spec conflicts recorded in `docs/OPEN_QUESTIONS.md` instead of guessed.
