# D05 - Analysis engine: indicators, scores, derived fundamentals, screener rows

| Field | Value |
|---|---|
| Track | data |
| Depends on | D03 |
| Size | L (S < 0.5 day, M 0.5-1.5 days, L 1.5-4 days of focused work) |

## Read first
- docs/05-analytics-spec.md sections 1-7
- docs/04-worker-jobs.md 3.7
- docs/07-edge-cases-tests.md FND-*, SHP-*
- `CLAUDE.md` (rules), `docs/00-legal-and-safety.md` (Safe Edition guards)

## Goal
Compute everything analytical: indicators, returns/risk, scores, owner-data-derived fundamentals and valuation, peers inputs, screener rows.

## In scope
- Indicator library (SMA, EMA, RSI, MACD, Bollinger, ATR, ADX, Stochastic, OBV, volume z, 52w, support/resistance, crosses)
- Returns/risk metrics (calendar and trading windows, CAGR, vol, drawdown, beta, Sharpe-like, liquidity)
- Analysis tab series (drawdown, rolling vol/beta, histograms, month x year and calendar heatmaps data)
- Derived fundamentals (growth, margins, ROE, ROCE, D/E, coverage, CFO/PAT, TTM EPS, P/E, P/B, EV/EBITDA, PEG, dividend yield, PE percentile) with null reasons
- Scores (trend, risk, quality) with components/coverage; shareholding analytics
- `screener_row` builder; `analysis_snapshot` writer; definitions export for the UI

## Out of scope (do not do in this task)
- ML

## Deliverables
- `apps/worker/analytics/*`, job `compute_analysis`, `docs/definitions.json` generator

## Steps
1. Implement each formula exactly as written; add golden tests with pinned reference library values
2. Implement null-reason propagation
3. Write the fixture-driven ratio tests (S16 data)

## Acceptance criteria (all must be true)
- [ ] All FND-* and SHP-* analytics tests pass
- [ ] Indicators within stated tolerance of reference after warm-up
- [ ] Stocks without owner data produce null fundamentals with `no_data_entered`

## Required tests (from `docs/07-edge-cases-tests.md`)
- `FND-01` (see `docs/07-edge-cases-tests.md`)
- `FND-04` (see `docs/07-edge-cases-tests.md`)
- `FND-05` (see `docs/07-edge-cases-tests.md`)
- `FND-06` (see `docs/07-edge-cases-tests.md`)
- `FND-07` (see `docs/07-edge-cases-tests.md`)
- `FND-08` (see `docs/07-edge-cases-tests.md`)
- `FND-09` (see `docs/07-edge-cases-tests.md`)
- `FND-10` (see `docs/07-edge-cases-tests.md`)
- `FND-13` (see `docs/07-edge-cases-tests.md`)
- `FND-14` (see `docs/07-edge-cases-tests.md`)
- `FND-16` (see `docs/07-edge-cases-tests.md`)
- `SHP-02` (see `docs/07-edge-cases-tests.md`)
- `SHP-04` (see `docs/07-edge-cases-tests.md`)
- `SHP-03` (see `docs/07-edge-cases-tests.md`)

## Definition of done
- [ ] Behavior matches the cited spec sections exactly (note section numbers in the PR description).
- [ ] Tests above exist, run in CI and pass; new edge cases discovered are added to `docs/07-edge-cases-tests.md`.
- [ ] Loading/empty/partial/stale/error states implemented for any UI work.
- [ ] No secrets or personal data in code, logs or fixtures; deny-list check passes.
- [ ] `docs/RUNBOOK.md` updated for any new variable, job or failure mode.
- [ ] Questions or spec conflicts recorded in `docs/OPEN_QUESTIONS.md` instead of guessed.
