# B16 - Investment-context analytics: worker blocks, seasonality, watchlist field

| Field | Value |
|---|---|
| Track | backend (worker `apps/worker`, Go API `apps/api`) |
| Depends on | D05 (analysis snapshot and `analysis_series.py`, done), B04 (`/indicators` and `prices/expand.go`, done), B11 (watchlist service, done), T02 |
| Size | L (S < 0.5 day, M 0.5-1.5 days, L 1.5-4 days of focused work) |
| Status | PROPOSED (decision INV, 2026-11-11); do not start before the owner answers or accepts the defaults of `docs/OPEN_QUESTIONS.md` INV-1..INV-28 |

## Read first
- docs/05-analytics-spec.md sections 1, 3, 4, 8.3 and **12** (every formula and golden vector)
- docs/03-api-spec.md sections 4, **4a**, 11
- docs/07-edge-cases-tests.md rows `INV-M`, `INV-S`, `INV-P`, `INV-D`, `INV-H`, `INV-E`, `INV-V`, `INV-L`, `INV-R`, `INV-A`, `INV-W`, `INV-Z`, plus RET-89 and RET-90
- `apps/worker/worker/analytics/analysis_series.py`, `snapshot.py`, `returns.py`; `apps/api/internal/prices/expand.go`; `apps/api/internal/portfolio/watchlist.go`
- `CLAUDE.md` (rules), `docs/00-legal-and-safety.md` (Safe Edition guards), `docs/OPEN_QUESTIONS.md` INV-1..INV-28

## Goal
Compute the investment-context blocks from the stock's own imported prices and serve them: month and year returns with the seasonality statistics, price position, drawdown profile, holding periods, entry-point study, volatility regime, SIP versus lump sum and risk-adjusted return, plus the per-stock `seasonality` field on `GET /watchlist`. Descriptions of past prices only: no verdict, no target, no prediction.

## In scope
- Worker (`apps/worker/worker/analytics/`): a new module (for example `investing.py`, pure numpy, `mypy --strict`) with one function per block of docs/05 12.1-12.9, called from `snapshot._analysis` so the blocks land in `analysis_snapshot.indicators.analysis` (`year_returns`, `seasonality`, `position`, `drawdown_profile`, `holding_periods`, `entry_study`, `vol_regime`, `sip_backtest`, `risk_adjusted`). Windows and thresholds are function arguments (the golden vectors use small windows); the `INV_*` defaults of docs/05 12.0 are read from `app_setting` with the documented fallbacks.
- Fix `analysis_series.month_year` so a month whose previous calendar month has no bar is `null` (INV-4) and keep its shape; the running month stays in it (month to date) and is identified by `seasonality.running`.
- The SIP backtest reuses the XIRR solver of section 8.3 (the worker's existing implementation); 29 variants (`day` null and 1..28).
- Null discipline: every null scalar has its sibling `*_reason`; no NaN or Infinity; every block carries `as_of`, `bars` and its sample counts and `small_sample`.
- API: `GET /stocks/{symbol}/indicators` passes the new blocks through (`prices/expand.go` leaves them unchanged); `GET /watchlist` adds `stocks[].seasonality` (docs/03 section 11): read `indicators #> '{analysis,seasonality}'` of the newest snapshot, pick the month entry of today's IST month, add `month_name`, `data_since`, `mtd_*` (null with `no_bar_this_month` when the snapshot's `as_of` month is not the current month), and `seasonality: null` with `seasonality_reason` when there is no snapshot. Measure the cost (INV-W08); only if it breaks the budget, add the small `analysis_snapshot.seasonality` column by a forward-only goose migration and write it from the worker.
- Snapshot lifecycle: the newest snapshot keeps `analysis.seasonality` after pruning (RET-90); recompute after import, trim and delete as today.
- Contract-first, in one change: `docs/03` (done in the spec), `openapi.yaml`, `packages/api-types` (`npm run check:generated` clean) and `docs/field-map.json` agree; no new route (so `routes.go` and `TestRoutesMatchOpenAPI` are untouched).
- RUNBOOK section 140 finalised; new edge cases found while building are added to `docs/07`.

## Out of scope (do not do in this task)
- Any UI (F17); a new route; relative strength versus Nifty (INV-22); Sharpe; a chosen SIP amount; the tracked-stocks tile (INV-9); any prediction or verdict; any network access or new data source; changing existing blocks other than the `month_year` gap fix.

## Steps
1. Pure functions and the golden vectors VM1, VM2, VS1-VS3, VP1, VD1, VH1, VE1, VV1, VL1, VR1 as failing tests first; 2. wire into `snapshot._analysis`; size and strict-JSON checks; 3. `month_year` gap fix with regression test; 4. API pass-through test and the watchlist field with a fake clock; 5. performance measurement; 6. OpenAPI, generated types, field map; 7. RUNBOOK.

## Acceptance criteria (all must be true)
- [ ] Every row `INV-M01..M09`, `INV-S01..S08`, `INV-P01..P04`, `INV-D01..D07`, `INV-H01..H02`, `INV-E01..E06`, `INV-V01..V03`, `INV-L01..L05`, `INV-R01..R04`, `INV-A01..A06`, `INV-W01..W08`, `INV-Z01` passes.
- [ ] All golden vectors of docs/05 section 12 pass (tolerance 1e-4 on rates, 1e-3 on the downside deviation, exact on counts and dates).
- [ ] Missing history gives `null` with a reason (never 0, NaN, Infinity); a 14-month history shows no share anywhere; nothing is computed from fewer rows than its window.
- [ ] The snapshot grows by less than 20 KB and stays under 200 KB; `compute_analysis` for a 25-year stock stays within its existing time budget.
- [ ] `GET /watchlist` is unchanged apart from the new optional field (INV-W07); no new route; no new egress host; deny-list, SAF-13 and licence scan pass.
- [ ] `docs/03`, `openapi.yaml`, `docs/field-map.json` and `packages/api-types` agree.

## Required tests
`INV-M*`, `INV-S*`, `INV-P*`, `INV-D*`, `INV-H*`, `INV-E*`, `INV-V*`, `INV-L*`, `INV-R*`, `INV-A*`, `INV-W*`, `INV-Z01`, `RET-89`, `RET-90` (regression), `SAF-13`.

## Definition of done
- [ ] Behaviour matches `docs/05` section 12 and `docs/03` 4a and 11 exactly; tests pass in CI; structured logs, no secrets; performance budget not regressed; `docs/RUNBOOK.md` section 140 updated; open questions recorded instead of guessed.
