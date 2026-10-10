# D03 - Price ingestion, adjustment, split/bonus detection

| Field | Value |
|---|---|
| Track | data |
| Depends on | D02 |
| Size | L (S < 0.5 day, M 0.5-1.5 days, L 1.5-4 days of focused work) |

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
- Sanity rules and `suspect` flags; holiday detection; partial-bar rule
- Detector with fraction list, thresholds and volume rule from the spec (configurable)
- Prices import interplay (source labeling, upsert)
- `BROKER_PRICES_ADJUSTED` handling

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
