# F17 - Investment-context UI: Analysis cards, heatmap Year column and summary rows, Home seasonality tile

| Field | Value |
|---|---|
| Track | frontend |
| Depends on | F04 (Dashboard), F06 (Analysis tab and `Heatmap`), F03 (definitions generator), B16 (data; develop against MSW mocks from the OpenAPI examples until it lands) |
| Size | L (S < 0.5 day, M 0.5-1.5 days, L 1.5-4 days of focused work) |
| Status | BUILT (decision D-INV accepted 2026-11-11; notes and questions F17-1..F17-6 in `docs/OPEN_QUESTIONS.md`); awaiting review |

## Read first
- docs/06-frontend-spec.md sections 3, 5, 6.2, **6.2a**, 6.4, **6.4a**, 7, 8, 9; docs/06a-design-system.md sections 3 and 5 (Heatmap)
- docs/03-api-spec.md sections 4a and 11 (fields only; the browser computes nothing but sorting and filtering)
- docs/05-analytics-spec.md section 12 (labels, wording and honesty; the 12.12 owner texts)
- docs/07-edge-cases-tests.md rows `INV-C`, `INV-T`, `INV-U`, `INV-Z01`, UI-09
- `apps/web/src/components/stock/chart/AnalysisTab.tsx`, `components/ui/Heatmap.tsx`, `lib/stock/chart-model.ts`, `components/dashboard/*`, `scripts/gen-definitions.mjs`
- `CLAUDE.md` (rules), `docs/00-legal-and-safety.md` (Safe Edition guards), `docs/OPEN_QUESTIONS.md` INV-1..INV-28

## Goal
Show the investment-context cards on the stock Analysis tab, extend the monthly-return heatmap with the "Year (price return)" column and summary rows, and add the Dashboard tile "This month, across the years", exactly as specified in docs/06 6.2a and 6.4a. Honest by construction: past prices only, sample sizes and "past behaviour is not a forecast" on every card, no verdict, no score, no target.

## In scope
- zod schemas for `analysis.year_returns`, `seasonality`, `position`, `drawdown_profile`, `holding_periods`, `entry_study`, `vol_regime`, `sip_backtest`, `risk_adjusted` and `watchlist.stocks[].seasonality` (optional; a missing block is "Not computed yet", never zero); MSW fixtures built from the docs/05 golden vectors.
- `Heatmap` extension (trailing columns, footer rows, cell markers MTD/YTD/partial, pinned first and trailing columns, focusable scroll region kept); existing callers (MF detail, calendar, portfolio) unchanged and tested.
- Analysis tab: Entry context strip, Price position, Volatility regime, Drawdown profile, Holding periods, Entry-point study, SIP versus lump sum (day selector over the stored variants, no request), Risk-adjusted return, the heatmap's Year column and summary rows with the best and worst month line; each card with definition tooltip, source/as-of chip, sample size, small-sample chip, "How to read" disclosure, the fixed past-behaviour line, and all states (loading, not computed, partial, stale, error).
- Dashboard tile `dash-seasonality`: ranked rows, "Not enough years yet" group, sort and minimum-years controls, month to date as separate context, states, footnote, 375 px layout.
- Definitions: add the ten owner-text keys of docs/05 12.12 to `ENTRIES` in `scripts/gen-definitions.mjs` (anchor `**Owner text (key):**`, same pattern as `xirr_pooled`) and run `npm run gen:definitions`; the staleness test must pass. Do not hand-edit `definitions.ts`.
- `format.ts` for every number and date; tokens only; ECharts only through `ChartFrame` (the cards use tables and one range bar, no new chart type); `data-testid` on every interactive element; replace the `conditional:` entries added to `docs/field-map.json` for these fields with real test ids (UI-09).

## Out of scope
- Any calculation of seasonality, percentiles, XIRR or returns in the browser (sorting and filtering excepted); a tile for tracked stocks beyond the watchlist (INV-9); relative strength versus Nifty (INV-22); Sharpe; a chosen SIP amount; buy/sell wording, scores, rankings of attractiveness, target prices, forecasts; third-party calls; new dependencies.

## Steps
1. Schemas, fixtures and the `Heatmap` extension; 2. Year column, summary rows and markers in the monthly heatmap; 3. the Analysis cards (shared card shell first); 4. Entry context strip; 5. Dashboard tile; 6. definitions generation; 7. states, accessibility, 375 px, field map; 8. RUNBOOK section 141 for the UI.

## Acceptance criteria (all must be true)
- [ ] Rows `INV-C01..C04`, `INV-T01..T08`, `INV-U01..U10` pass; UI-09 passes with no `conditional:` placeholder left for the new fields.
- [ ] The Year column is labelled "Year (price return)" with the tooltip; "total return" never appears for stocks without the qualifier; the running month is marked MTD and is in no summary.
- [ ] No card or tile shows 0, NaN or Infinity for an unknown value; every statistic shows its sample size; every card shows "Past behaviour is not a forecast."; the grep test for verdict words (INV-C02) passes.
- [ ] Axe clean in both themes at 375 and 1440 px; keyboard operation of the tile controls, the SIP day selector and the heatmap region; no horizontal page scroll at 375 px; targets at least 44 px.
- [ ] `npm run gen:definitions -- --check` passes; `docs/field-map.json` has real ids.

## Required tests
`INV-C01..C04`, `INV-T01..T08`, `INV-U01..U10`, `UI-09`, `SAF-03` (footer, regression), existing Analysis tab and Dashboard tests (regression).

## Definition of done
- [ ] Behaviour matches docs/06 6.2a and 6.4a exactly; tests pass in CI; loading/empty/partial/stale/error states implemented; no secrets or personal data in fixtures; RUNBOOK section 140 updated.
