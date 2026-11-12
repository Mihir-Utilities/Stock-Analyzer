# Plan: investor additions to the Analysis tab, the portfolio and the stock page

Status: PLAN (written 2026-11-12). Owner request: keep the current Drawdown profile as it is, add swing dips next to it,
and add fundamentals-next-to-price context, valuation against own history and peers, relative strength against the Nifty,
portfolio-level risk, and process tools (alerts at chosen levels and a short note of why a stock was bought).

This plan is the source for the tasks below. Every task follows CLAUDE.md: contract-first (docs/03 -> openapi.yaml ->
generated types -> docs/field-map.json together), a test for every docs/07 row and every docs/05 formula, honesty rules,
no guessing (record INVx-n questions in docs/OPEN_QUESTIONS.md with a proposed default; the owner has accepted proposed
defaults before). Safe Edition: no new egress, no new data source.

## 0. Ground rules for every item

- **No verdict, no score that says buy or sell, no target price.** Facts are shown side by side. Every historical statistic
  shows its sample size, a small-sample flag and "Past behaviour is not a forecast". Fundamentals next to a price fact are
  a juxtaposition, never a combined signal.
- Every number has unit, source and as-of, or a reason when null (`*_reason`). Never 0/NaN/Infinity for unknown. Percent
  API fields are percent numbers; fractions only where the spec says.
- Price return only (dividends excluded) for stocks. Owner-entered fundamentals are labelled as entered by the owner.
- The current Drawdown profile (episodes measured from the highest close so far) stays exactly as it is. New blocks are
  additive and optional in the API, so nothing already shipped changes shape.
- Quality gates for every build task (CI runs all of them, so run them before reporting): web unit suite, eslint,
  prettier, tsc, build, `npm run check:bundle` (250 kB gzip per route), strict field-coverage guard (never edit
  tests/unit/f15-polish.test.tsx; map real data-testids), generated-types check, Go `go vet`, `golangci-lint run ./...`
  (v2.14.0), `go test ./... -count=1` against a throwaway Postgres, httpx contract tests (a new route must also be in
  openapi.yaml and in apps/api/internal/httpx/routes.go), worker `ruff check`, `ruff format --check`, `mypy --strict`,
  full worker pytest, `scripts/deny_list_check.py`, `scripts/license_scan.py`. definitions.ts is generated from docs/05
  owner-text markers (`npm run gen:definitions`), never hand-edited.
- After each build: review (Prompt 3, read-only agent), fix (Prompt 4, approved findings), merge, push, watch CI.

## 1. Data facts that shape the plan (checked 2026-11-12 on the owner's database)

| Fact | Consequence |
|---|---|
| `market_series` already holds NIFTY50 (2,465 rows, 2016-11-15 to 2026-11-12) and INDIAVIX, imported through the reserved symbols of the normal prices.csv import | Relative strength against the Nifty can be built now. No new source. |
| 68 of 70 tracked stocks have a sector | Peer comparison works; a sector INDEX series does not exist and cannot be fetched (Safe Edition), so "against the sector" means against the median of tracked peers in the same sector. |
| 208 portfolio transactions, prices for about 10 years | Portfolio concentration and a reconstructed daily value series (hence drawdown) are computable. |
| Price alerts (`price_above`, `price_below`, B12/F12) and `note` columns on watchlist and transactions already exist | Process tools reuse the alerts engine; only a thesis journal is new storage. |
| No portfolio value-history endpoint exists (F11-2 recorded the gap) | Portfolio drawdown needs one new read endpoint. |
| Existing Fundamentals tab already shows debt/equity, interest coverage, ROE, profit trend and the PE percentile strip (D05b, F07); Peers tab exists (B13, F08/F10) | The business-context strip is mostly presentation plus small read-only composition. |

## 2. Work items

Task ids continue the repository numbering (B17 and F18 were used by the all-stocks Home tile). Each item is one agent that
does step 1 (spec and contract, own commit), step 2 (build, own commits) in its own worktree.

### Item A: swing dips (keeps the current Drawdown profile) - B18 (worker + API) and F19 (web)
- **Rule (proposed default, record as SWD-n):** a *dip* starts when the close is at least X percent below the highest close
  of the preceding 252 trading rows (the same 52-week high the entry-point study uses; X = 10 and 20); its *low* is the
  deepest close before recovery; it is *recovered* at the first later close at or above the reference high of the dip start
  (recovery to the pre-dip peak). Overlap rule: one dip per peak until recovery (no double counting). Also report the
  *local-peak* variant if the agent judges it sound (zig-zag with an X percent reversal); if not, defer it with the reason.
- **Per dip:** start date, peak date and value, low date and value, depth percent, days from peak to low, days from low to
  recovery (null while open), status `recovered | open`. **Open dips are counted and labelled, never dropped.**
- **Summary per X:** dips, recovered, open, median and worst depth, median days peak-to-low, median days to recover
  (completed only, labelled as such), the longest open dip so far, and the share of recovered dips (so a stock like IDEA
  shows many completed swings inside a long decline). Sample size and small-sample flag travel with every figure; the
  minimum-count rule hides medians below it with a reason.
- **UI:** a new card "Swing dips" beside the existing "Drawdown profile" (which stays), with a short "how this differs
  from the all-time-high view" line, the last N dips in a table, and the open dip flagged.
- Golden vectors computed by hand (one with two dips under one peak, one open dip, one stock that never recovers).

### Item C: portfolio-level risk - B19 (API) and F20 (web)
- **Concentration:** weight per holding and per sector (owner-imported sector), top-1, top-3, top-5 share, a
  Herfindahl index, the count of holdings, and an effective-number-of-holdings figure; separately for the All, Equity and
  Mutual funds views already built (MF scheme weights from MF holdings).
- **Position stress:** for each holding, the portfolio impact of a 10 percent and a 20 percent fall in that holding alone,
  in rupees and as a percent of portfolio value (pure arithmetic, labelled a what-if, not a forecast).
- **Portfolio value history and drawdown:** a daily value series reconstructed from transactions and stored prices (and MF
  NAVs for the MF view), served by one new read endpoint with the series, the current drawdown from the portfolio's own peak,
  the maximum drawdown with dates, and days under water. Cash flows (buys and sells) must not be mistaken for gains or
  losses: drawdown is measured on value after neutralising contributions, or on a time-weighted index (decide and record as
  PRK-n; default: a time-weighted return index, so deposits do not hide a fall).
- **Honesty:** gaps in prices (a holding with no price on a date) make that date null with a reason rather than a partial sum.
- Stays in manual price mode; no broker data.

### Item D: process tools: alert shortcuts and a decision journal - B20 (API + migration) and F21 (web)
- **Alert shortcuts from the Analysis tab:** buttons that prefill the existing "create alert" flow (price_below /
  price_above) at levels derived from facts already on screen (for example "10 percent below the 52-week high",
  "20 percent below", "200-day average", "last swing-dip low"). They create ordinary alerts through the existing API; the
  existing THRESHOLD_ALREADY_MET rule applies. No new alert kind unless the agent proves one is needed (then record it).
- **Decision journal:** a per-stock list of dated notes with: the reason or thesis (text, max 1,000 characters), the price
  at the time (taken from the latest imported close, labelled with its date), an optional "review on" date and a status
  (open, reviewed). A forward-only migration (next number is 0015) adds the table; CRUD endpoints with the existing
  idempotency, CSRF and validation conventions; the journal appears in a stock page tab or side panel, and a note can be
  linked to a transaction. Notes are plain text, HTML-escaped on render, included in the D08 backup list (owner data), never
  exported to third parties. A "review due" marker uses the owner's IST date.
- **Out of scope:** reminders by Telegram for review dates (record as a question; default off).

### Item E: relative strength against the Nifty and against sector peers - B21 (worker + API) and F22 (web)
- **Against the Nifty:** rolling and calendar-period relative return (stock return minus index return, and the ratio
  line rebased to 100), the share of rolling 1-year windows in which the stock beat the index, up/down capture is out of
  scope (record as deferred). Uses `market_series` NIFTY50 aligned by date; dates present in only one series are dropped
  and the dropped count is shown; the index must have at least the stock's window of data or the figure is null with a reason.
- **Against sector peers:** the stock's return rank among tracked stocks of the same sector over 3, 6, 12 months
  (percentile and rank of N), using the owner-imported sector. Hidden below 3 peers with a reason. A sector INDEX is not
  available and is not simulated.
- **UI:** a "Relative strength" card in the Analysis tab (rebased line chart through ChartFrame, rolling-year win share, peer
  rank strip), clearly worded: "Beating the index in the past is not a forecast."
- Index data missing: card shows an owner-facing hint "Import NIFTY50 history in prices.csv" (the existing reserved-symbol
  import) instead of numbers.

### Item B: business context next to the price context - F23 (web, with a small read-only API composition if needed)
- Wave 2 (after A and E, because it extends the same tab). An "Entry context" companion panel "Business context" that puts,
  side by side with the price facts, the owner-entered or derived facts already in the system: debt to equity, interest
  coverage, ROE and ROCE trend, profit trend (latest annual and quarterly), and the valuation context: PE percentile
  against the stock's own history (existing) and the PE rank among its sector peers (existing peers data), each with source
  and as-of. Missing owner data shows "no data entered" with the link to add results, never a number.
- **Juxtaposition rules:** no combined score and no verdict. A plain, factual flag line is allowed only when both sides are
  true and each is stated: for example "Price is 70 percent below its high and debt to equity is above 2 (entered
  2026-06)", with the line "Context, not advice or a signal."
- Fundamentals are the owner's entries: label them "entered by you; verify against company filings".

## 3. Dependencies, parallelism and conflict handling

```
Wave 1 (parallel, separate worktrees): A (swing dips), C (portfolio risk), D (journal + alert shortcuts), E (relative strength)
Wave 2 (after A and E are merged):     B (business context strip)
Then per item: review (read-only) -> fixes -> merge -> push -> CI -> recompute analysis and restart worker/API locally
```

- A, C, D and E touch different areas, but A and E both add blocks to the analysis snapshot and the Analysis tab. They keep
  their own new files (`swing_dips.py`, `relative_strength.py`, their own card components) and touch the shared wiring lines
  (`snapshot._analysis`, `AnalysisTab.tsx`, field-map, docs/03, openapi, docs/07, OPEN_QUESTIONS, RUNBOOK) minimally. The
  coordinator merges them one at a time; docs conflicts are resolved by keeping both sides, generated files are regenerated
  (never hand-merged), and doc IDs are renumbered on collision.
- Migration numbers: D uses 0015. Nobody else adds a migration without recording an owner question.
- Test and doc ID prefixes: A `SWD-`, C `PRK-`, D `JRN-` and `ALS-`, E `RST-`, B `CTX-`. RUNBOOK sections 150-159 are
  reserved: A 150, C 151, D 152, E 153, B 154.
- Each agent works only in its own worktree, never in the owner's running checkout.

## 4. Owner decisions and the proposed defaults (record in OPEN_QUESTIONS; none blocks the build)

| # | Question | Proposed default |
|---|---|---|
| SWD-1 | Reference peak for a dip: 252-row high versus local zig-zag peak | 252-row high (agrees with the entry-point study); zig-zag variant only if sound, else deferred |
| SWD-2 | Recovery means regaining the pre-dip peak or a smaller bounce | Regaining the pre-dip peak; also show days to a +10 percent bounce from the low as a second figure if cheap |
| PRK-1 | Drawdown of a portfolio with deposits | Time-weighted return index, not raw value |
| PRK-2 | Sector weights when a stock has no sector | A visible "Unclassified" slice |
| JRN-1 | Journal note length and fields | 1,000 characters, price at time, review-on date, status |
| JRN-2 | Telegram reminder for review dates | Off in v1 |
| RST-1 | Relative strength against a sector index | Not available; peer median only |
| RST-2 | Minimum overlap with the index | 252 aligned rows for any 1-year figure |
| CTX-1 | Show a combined flag at all | Only the factual juxtaposition line, no combined score |

## 5. Verification (definition of done for the whole plan)

1. All items merged to `origin/main` with CI green on every job, then merged into the owner's `feat/groww-ui` checkout.
2. Locally: `compute_analysis` recompute for all tracked stocks so the new blocks appear; worker and API restarted with
   the new code; migration 0015 applied to the dev database.
3. The owner reviews each new card on a stock they know (RELIANCE and IDEA) and confirms the numbers against their own
   expectation; unexplained blanks are investigated with the stored `*_reason` values (as was done for the empty heatmap
   months).
4. PROGRESS.md updated with every task, review finding, fix and open owner question.
