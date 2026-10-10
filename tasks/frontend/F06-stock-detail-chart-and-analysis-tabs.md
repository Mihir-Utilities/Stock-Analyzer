# F06 - Stock detail: Chart and Analysis tabs

| Field | Value |
|---|---|
| Track | frontend |
| Depends on | F05 |
| Size | L (S < 0.5 day, M 0.5-1.5 days, L 1.5-4 days of focused work) |

## Read first
- docs/06-frontend-spec.md section 6.4 (Chart, Analysis)
- docs/06a-design-system.md section 5
- `CLAUDE.md` (rules), `docs/00-legal-and-safety.md` (Safe Edition guards)

## Goal
Build the professional charting experience and analysis visualizations.

## In scope
- Candlestick/line/area with volume; overlays; RSI/MACD/Stochastic/ADX panes; compare overlay; log scale; adjusted/raw toggle; corporate-action markers; support/resistance; crosshair; pinch/zoom
- Indicator summary table with plain-language reads
- Analysis sub-tab: drawdown, rolling volatility, return histogram, month x year heatmap, calendar heatmap, rolling beta
- Show data for every chart; weekly-candle notice

## Out of scope (do not do in this task)
- Nothing else; stay within the scope above.

## Deliverables
- `components/stock/chart/*`, tests

## Steps
1. Implement chart options builders per visual (pure functions, unit-tested)
2. Implement downsampling awareness and indicator alignment with null warm-ups
3. Test touch gestures in Playwright mobile emulation

## Acceptance criteria (all must be true)
- [ ] Renders 2,000 points smoothly on mobile emulation
- [ ] All indicator panes align with price panel
- [ ] Data-table view matches plotted values

## Required tests (from `docs/07-edge-cases-tests.md`)
- `UI-07` (see `docs/07-edge-cases-tests.md`)
- `UI-10` (see `docs/07-edge-cases-tests.md`)
- `BRK-17` (see `docs/07-edge-cases-tests.md`)

## Definition of done
- [ ] Behavior matches the cited spec sections exactly (note section numbers in the PR description).
- [ ] Tests above exist, run in CI and pass; new edge cases discovered are added to `docs/07-edge-cases-tests.md`.
- [ ] Loading/empty/partial/stale/error states implemented for any UI work.
- [ ] No secrets or personal data in code, logs or fixtures; deny-list check passes.
- [ ] `docs/RUNBOOK.md` updated for any new variable, job or failure mode.
- [ ] Questions or spec conflicts recorded in `docs/OPEN_QUESTIONS.md` instead of guessed.
