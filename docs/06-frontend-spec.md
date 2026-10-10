# 06. Frontend Screen Specification (Safe Edition; Next.js, TypeScript)

Design language, tokens and components: `06a-design-system.md`. Every screen implements all states in section 5 and the formatting rules in section 3. Mobile first (design at 375 px). Every interactive element has a `data-testid`.

## 1. Technical setup
- Next.js App Router, TypeScript strict, Tailwind, shadcn/ui, TanStack Query (retry 2, backoff), ECharts (core build, lazy), zod types generated from OpenAPI, `Intl` for formatting, `decimal.js` for portfolio money.
- `next.config.js` rewrites `/api/:path*` to the Go API so cookies are first-party; no CORS.
- Auth gate in `middleware.ts`: no `session` cookie -> `/login`; any API 401 clears caches and redirects.
- CSP: `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'`. No third-party scripts, fonts or iframes.
- Cold API: every request timeout 70 s; after 3 s show "Waking up the server. This can take up to a minute on the free plan." with elapsed seconds.
- `staleTime`: stock profile 60 s; prices 5 min; analysis 10 min; fundamentals/shareholding 6 h; MF 30 min; stock index 1 h.
- PWA: manifest + icons; service worker caches only the app shell.

## 2. Routes and navigation
Desktop sidebar / mobile bottom tabs: Home, Stocks, Funds, Portfolio, More (Compare, Screener, Alerts, Watchlist, Imports, Settings, Admin).

| Route | Screen |
|---|---|
| `/login` | Login |
| `/` | Dashboard |
| `/stocks` | Browse/search |
| `/stocks/[symbol]` | Stock detail (`?tab=overview|chart|analysis|fundamentals|ownership|peers|prediction|events|data`) |
| `/compare` | Compare stocks (`?symbols=`) |
| `/screener` | Screener |
| `/portfolio` | Portfolio |
| `/alerts` | Alerts and Telegram |
| `/watchlist` | Watchlist |
| `/mf`, `/mf/[code]`, `/mf/compare` | Funds |
| `/imports` | Import center (wizard, templates, batches, manual forms) |
| `/settings` | Settings (password, display, Telegram, broker, sessions, export) |
| `/admin/status` | Data health |
Unknown symbol -> not-found with search. Alias symbol -> `router.replace` to the new symbol + toast.

## 3. Formatting rules (`format.ts`, unit-tested)
- Currency `₹`, Indian grouping (`₹12,34,567.89`); crore amounts `₹1,23,456 Cr`, >= 1,00,000 Cr as `₹1.23 L Cr`; column headers state units (`Rs Cr`). Setting for western grouping.
- Percent 2 dp with explicit sign for changes; multiples `23.45x`.
- Up/down: green/red **plus** arrow and sign; zero neutral. India convention.
- Null/unknown: em dash with tooltip reason (`n/m: base is negative`, `loss making`, `no data entered`, `insufficient history`, `awaiting entry`). Never `0`, `NaN`, `Infinity`.
- Dates `10 Oct 2026`; with time `10 Oct 2026, 15:30 IST`; relative `2h ago`. All market times labeled IST.
- Fiscal labels: FY = year of March end. Quarter from period end: Jun = Q1, Sep = Q2, Dec = Q3, Mar = Q4. `Q2 FY27 (Sep 2026)`, `FY26 (Mar 2026)`.
- Tabular numerals, right-aligned numbers. Negative zero shows `0.00`.
- Probabilities: bucket text first; numeric in tooltip and model card only.

## 4. Global components (see design system for visuals)
1. **Search palette** (`/` or Ctrl/Cmd+K): loads `/stocks/index` once (IndexedDB cache by `generated_at`; refresh if > 24 h or ETag changed). Normalize query (uppercase, remove spaces/punctuation except `&` and `-`); rank: exact symbol > symbol prefix > name word-prefix > substring > fuzzy (Jaro-Winkler >= 0.85). Max 12 results, grouped Stocks / Funds (funds via debounced 250 ms server search). Row: symbol, name, sector chip (if known), badges `Suspended`, `Delisted`, `ETF/REIT`, `No broker data`. Keyboard navigation; recent searches (8). Empty: "No match. Try the company name or exchange symbol."
2. **Price header:** symbol, name, LTP, change, quote time + age badge, market status pill, RangeBar, Watchlist star, Alert bell, Refresh, "Add transaction", "Compare".
3. **Refresh button:** `POST .../refresh`; spinner "Refreshing (can take up to a minute)"; poll `/jobs/{id}` every 3 s up to 3 min; `ok` -> invalidate queries + toast; 429 -> "You refreshed this recently. Try again in {n} min."; `failed` with `broker_session_missing` -> banner with Reconnect broker; timeout -> "Still working; data will update at the next scheduled run."
4. **Freshness chips** on every card (source + as-of; amber when stale). **DepthChip** on fundamentals.
5. **Banners:** broker disconnected (with Reconnect), manual price mode notice, `UNCONFIRMED_ACTION` banner (Confirm/Reject), experimental banner, API `warnings[]` rendered always.
6. **Toasts, ConfirmDialog, Skeletons, ErrorBoundary per card** (one card failing never blanks the page).

## 5. States every data view implements
Loading (skeleton; "waking server" after 3 s) | Empty (explanation + action) | Partial (render available parts; missing parts `—` with reason; info banner) | Stale (amber chip) | Error (message + Retry + request id) | Backfill pending (progress card; polls job) | Offline (banner; cached) | Unauthorized (redirect with validated `next`).

## 6. Screens

### 6.1 Login
Password field (`autocomplete="current-password"`), show/hide, Enter submits, generic error "Invalid credentials or temporarily locked." No registration or forgot-password (CLI reset in RUNBOOK).

### 6.2 Dashboard
Tiles: Index sparklines (Nifty 50, India VIX; only if served, else reason), Market status/next open, Watchlist heatmap/treemap and movers, Upcoming events timeline (owner-entered), Portfolio snapshot (value, day change, XIRR) with allocation sunburst, Alerts activity, Data-health strip (broker session countdown with Reconnect, MF freshness, last job status).

### 6.3 Stocks browse
Search input, filters (Tracked only toggle, Sector, Index tag, Kind, Status), sortable virtualized table (Symbol, Name, Price, 1D, 1Y with sparkline, P/E if entered, Quality if available). Untracked rows show "Open to fetch history".

### 6.4 Stock detail
Header (4.2). Tabs:

**Overview:** KPI grid (Market cap, P/E, P/B, ROE, ROCE, D/E, Div yield, 52w range) each with SourceChip (owner data) or "no data entered"; Gauges (Trend, Risk "relative to stocks tracked here", Quality with component popover, hidden for financial companies); mini candlestick 1Y; performance bars; upcoming events; corporate actions (confirmed and detected); research links card.

**Chart:** ECharts candlestick/line/area; ranges 1M-MAX; volume pane; overlays SMA 20/50/200, EMA 20/50, Bollinger; panes RSI, MACD, Stochastic, ADX; compare overlay (Nifty 50 if available or typed symbol, rebased); log scale; adjusted/raw toggle (adjusted = confirmed splits/bonus only, "price return, excludes dividends"); corporate-action markers; support/resistance bands; crosshair readout; touch pinch/zoom; weekly-candle note for long ranges. Indicator summary table with plain-language reads.

**Analysis (sub-tab of Chart):** drawdown chart, rolling volatility, return histogram, month x year heatmap, calendar heatmap, rolling beta, with definitions tooltips.

**Fundamentals:** toggles Quarterly/Annual and basis; groups P&L, Balance sheet, Cash flow, Ratios, Valuation; table with periods as columns (latest right), YoY/QoQ rows, sparkline column, selectable rows -> chart pane; P&L waterfall for the latest period; stacked balance composition; cash-flow chart; ROE decomposition; PE percentile strip; DepthChip; **owner-data CTA**: "Add results: manual form or import CSV" (opens Import wizard prefilled with the symbol); source chips show `manual`/`csv_import`; footnote "Figures are entered by you; verify against company filings."

**Ownership:** stacked chart by quarter, pledge line, QoQ diverging bars, small multiples, badges for sustained trends; note when MF figure missing; "Add quarter" form/CSV CTA.

**Peers:** requires owner-imported sector/industry; else EmptyState "Import sector data to see peers" with link. Peer table, percentile bars, bubble scatter, radar vs median, ranked bar chart; add/remove peers (session).

**Prediction (Experimental):** banner; per horizon bucket text + fan chart or plain-language hidden reason (including "Not enough tracked stocks to train a model" and "Confirm the possible split first"); trend/risk gauges; model card (version, date, OOS AUC/Brier vs baseline, folds, calibration plot, AUC-by-fold bars); live track record chart; "How to read this". Never a single price target.

**Events:** owner-entered calendar and corporate actions timeline (confirmed, detected-pending, rejected), add/edit forms, detected-action Confirm/Reject with the implied multiplier.

**Data (tab `data`):** transparency view: price history rows count, first/last date, sources used, suspect rows count, import batches affecting this stock, and links to undo/edit.

### 6.5 Compare
Picker (2-5), range chips, rebased chart, metrics table with best/worst highlights (direction-aware, heuristic noted), radar overlay, correlation matrix heatmap, shareable URL; short-history badges.

### 6.6 Screener
Filter builder (whitelisted metrics with units), presets, universe selector, results table with data bars/sparklines and coverage %, "excluded for missing data" counts, scatter plot of any two metrics, histogram of a metric with thresholds, Save screen, multi-select to watchlist, CSV export. Notice: fundamental filters only see stocks with owner-entered data.

### 6.7 Portfolio
Summary cards (Invested, Value, Unrealized, Realized, Day change, XIRR, vs Nifty 50 if available); holdings table; allocation sunburst/treemap; contribution bars; P&L waterfall; growth vs benchmark line; drawdown; transactions list with filters. Add transaction form (symbol search, side, qty, price, fees, date with weekend/holiday warning, note) with server messages (`INSUFFICIENT_HOLDINGS`). Adjustments panel (confirmed actions applied, override, "review needed" for rights/mergers/unconfirmed detected). Estimated dividends card (from owner-entered dividend actions; excluded from XIRR).

### 6.8 Alerts
List with status chips; create dialog (target, kind, dynamic params with units, one-shot, cooldown, expiry); Telegram card (not linked/linked; code + deep link + 15:00 countdown; polls `/auth/me` every 3 s up to 2 min; Send test; Unlink); history with delivery status; quiet hours editor; threshold-already-met error shown inline.

### 6.9 Mutual funds
`/mf`: debounced search, filters (category, fund house, plan Direct default, option Growth default, show all, group variants), rows with latest NAV and 1Y when tracked. `/mf/[code]`: header (name, house, category, plan/option chips, NAV + date, star); NAV chart with rolling-return band; returns table + heatmap; calendar-year bars; rolling-return histogram; risk (volatility, drawdown, Sharpe-like); SIP calculator with growth area chart and installment markers; lumpsum calculator; warnings (IDCW, inactive); notice "AUM, expense ratio and manager are not available from this data source"; attribution "NAV data: AMFI via mfapi.in". `/mf/compare`: rebased chart, risk-return scatter, returns heatmap table.

### 6.10 Import center (`/imports`)
Tabs: **Upload** (choose type -> Wizard: upload -> validate -> preview first 20 rows with row/column errors and warnings -> commit with note "as per filing dated ..."), **Templates** (download per kind), **Manual forms** (quarterly results, annual, shareholding, corporate action, calendar event), **Batches** (list, undo with overwrite warning; price batches not undoable). Persistent notice: "Enter or import only data you have the right to use. Prefer company filings and your own records." Screener tab appears only if enabled, with its terms notice.

### 6.11 Settings
Password change; display (theme, number format, show experimental); Telegram; **Broker** (status, minutes left, Connect/Reconnect/Disconnect, "never stores your password; read-only data access"); sessions (list, revoke, logout all); export (watchlist/portfolio/alerts/owner data as JSON/CSV); About (versions, data sources, safe-use policy link, THIRD_PARTY_NOTICES).

### 6.12 Admin status
Per-source cards (broker, mfapi, amfi, telegram), last runs with counts/durations, coverage numbers (tracked, with prices, with owner fundamentals), DB size bars (warn at 70/85%), recent errors (50), holiday file status, no "run job" buttons in v1.

## 7. Accessibility
WCAG 2.1 AA; contrast >= 4.5:1 (text) and 3:1 (graphics) in both themes; visible focus; keyboard-operable search/dialogs/charts' data tables; `aria-live="polite"` for refresh/import results; touch targets >= 44 px; no color-only meaning; reduced motion respected; labeled forms; charts have "Show data".

## 8. Field coverage matrix (every API field has a home; a test enforces this)
| API response | Fields -> UI element |
|---|---|
| `/stocks/{symbol}` | name, symbol, isin, series, sector, industry, listing_date -> Header + Overview "Company" card; company_type -> hides debt metrics/quality; status/flags -> badges; broker_ok/price_mode -> notices; quote.* -> Header/RangeBar; freshness.* -> chips; backfill -> progress card |
| `/prices` | bars -> Chart; adjusted/actions -> toggle + markers; warnings -> banner |
| `/indicators` | returns -> performance bars/table; technicals -> indicator table + panes; scores.trend/risk/quality (+components, coverage) -> Gauges + popover; series -> overlays/panes; analysis arrays -> Analysis tab |
| `/fundamentals` | basis_used/available -> toggle label; periods/labels/metrics -> tables; derived -> YoY rows/margins; ratios -> Ratios group + KPI; valuation -> Valuation group; periods_available/source_by_metric -> DepthChip/source chips; status/entry_hint -> CTA |
| `/shareholding` | all series, qoq_change, latest_filed_on, mf_available, note -> Ownership tab |
| `/events` | actions (confirmed/detected/rejected), calendar -> Events tab + Overview |
| `/peers` | all metrics, percentile_rank, self, sector/industry, note -> Peers tab |
| `/links` | links -> Research links card |
| `/prediction` | disclaimer, as_of, ref_close, horizons[*], trend, risk, model.*, track_record.* -> Prediction tab |
| `/market/overview` | indices, vix, movers, market_status -> Dashboard/top bar |
| `/compare` | rebased, metrics, best -> Compare |
| `/screener/query` | items, coverage, excluded_for_missing -> Screener |
| `/portfolio/summary` | holdings, totals, xirr, realized/unrealized, day change, allocation, benchmark, adjustments_applied -> Portfolio |
| `/watchlist` | stocks, funds -> Watchlist/Dashboard |
| `/alerts*` | all alert and event fields -> Alerts |
| `/mf/*` | meta, returns, risk, warnings, points, sip outputs, compare -> Funds |
| `/imports*`, `/broker/status`, `/admin/status` | all fields -> Import center, Settings, Admin |
A Playwright test iterates the OpenAPI schema and asserts each field name appears in `docs/field-map.json` mapped to a `data-testid`; unmapped fields fail CI.

## 9. Error copy (exact strings)
- Server waking: "Waking up the server. This can take up to a minute on the free plan."
- Broker: "Broker session expired. Reconnect to update prices."
- No owner data: "No results entered for {symbol}. Add them manually or import a CSV."
- Unconfirmed action: "Possible split or bonus on {date}: price changed {x}%. Confirm to adjust history."
- Rate limited refresh: "You refreshed this recently. Try again in {n} min."
- Forecast hidden: "Forecast hidden: {plain reason}."
- Footer: "Personal research tool. Data may be delayed, incomplete or wrong. Not investment advice."
- MF attribution: "NAV data: AMFI via mfapi.in."

## 10. Frontend test plan
Unit: formatters, search ranking, fiscal labels, definitions, decimal sums. Component: each card in each state (Storybook/Vitest). E2E (Playwright, mocked API fixtures): login/lockout; search `M&M` and `BAJAJ-AUTO`; every stock tab with partial data; refresh flow (queued/ok/429/failed/timeout); broker reconnect banner; detected-split confirm flow; add transaction (valid/invalid/oversell); alert creation incl. threshold-already-met; Telegram link flow; import wizard (valid, errors, undo); MF search and SIP; screener build/save; mobile snapshots; dark/light; axe on every route; field-coverage test.
