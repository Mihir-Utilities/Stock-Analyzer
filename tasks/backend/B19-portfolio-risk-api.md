# B19 - Portfolio-level risk API: concentration, position stress, value history and drawdown

| Field | Value |
|---|---|
| Track | backend (Go API `apps/api`) |
| Depends on | B11 (portfolio summary), B15 (MF sleeve and views), T02 |
| Size | M |
| Status | PROPOSED -> BUILT by the item-C agent (defaults PRK-1..PRK-8 in `docs/OPEN_QUESTIONS.md`) |

## Read first
- docs/05-analytics-spec.md sections 8.1, 8.2, 8.5.3 and **8.6** (formulas and golden vectors C1, C2, S1, TW1..TW6)
- docs/03-api-spec.md sections 1, 12, 12a and **12b**; docs/07-edge-cases-tests.md rows `PRK-C*`, `PRK-S*`, `PRK-H*`, `PRK-A*`
- `apps/api/internal/portfolio` (`service.go`, `summary.go`, `view.go`, `engine.go`), `apps/api/internal/mfhold` (`sleeve.go`), `apps/api/internal/httpx/portfolio_handlers.go`, `routes.go`
- `CLAUDE.md`, `docs/00-legal-and-safety.md`, `docs/PLAN-investor-additions.md` Item C

## Goal
One read endpoint `GET /portfolio/risk?view=all|equity|mf&as_of=` serving concentration (weights per holding and group, top-1/3/5, HHI, effective holdings), position stress (10 percent and 20 percent fall of one holding, rupees and percent of the portfolio) and the reconstructed daily value series with a time-weighted return index, the current and maximum drawdown and days under water. Facts and arithmetic only: no verdict, no forecast.

## In scope
- Pure functions in `apps/api/internal/portfolio` (`risk_*.go`): concentration and stress from the view summary's open holdings; the series builder from transactions, adjustments and bars (decimal money, time-weighted index, gaps, skipped steps, drawdown stats).
- Loader: held instruments' bars (non-suspect, from the first transaction to `as_of`) and MF NAVs read once; no per-date queries.
- Handler `GET /portfolio/risk` (new file; the service surface is a small interface asserted at the route, so `PortfolioService` is unchanged), `view` default `all`, `as_of` validation, envelope meta and warnings.
- Contract: docs/03 12b, `openapi.yaml`, regenerated `packages/api-types`, `docs/field-map.json`, `routes.go`; RUNBOOK section 151.
- Measure the response time on the owner-sized shape (about 200 transactions, about 40 stocks, about 10 years of daily prices) and record it in `docs/OPEN_QUESTIONS.md` PRK-8.

## Out of scope
UI (F20); a stored table or cache; look-through of mutual funds; benchmark comparison; XIRR changes; any new data source, host or dependency; any recommendation text.

## Acceptance criteria
- [ ] Every `PRK-C*`, `PRK-S*`, `PRK-H*`, `PRK-A*` row passes; golden vectors exact (index tolerance 1e-4).
- [ ] No partial totals: an unpriced holding nulls weights and shares with the reason; a missing price date is a gap, never a partial sum.
- [ ] Deposits do not hide a fall (TW1) and withdrawals do not fake one.
- [ ] Response under 500 ms on the owner-sized data; the measured value is recorded.
- [ ] `go vet`, `golangci-lint run ./...`, `go test ./... -count=1` (throwaway Postgres), TestRoutesMatchOpenAPI, contract tests, `check:generated`, deny-list and licence scan pass.

## Required tests
`PRK-C01..C08`, `PRK-S01..S03`, `PRK-H01..H17`, `PRK-A01..A04`.

## Definition of done
- [ ] Matches docs/05 8.6 and docs/03 12b exactly; structured logs, no secrets; RUNBOOK 151 updated; open questions recorded instead of guessed.
