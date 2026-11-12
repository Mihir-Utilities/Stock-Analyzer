# 06. Frontend Screen Specification (Safe Edition; Next.js, TypeScript)

Design language, tokens and components: `06a-design-system.md`. Every screen implements all states in section 5 and the formatting rules in section 3. Mobile first (design at 375 px). Every interactive element has a `data-testid`.

## 1. Technical setup
- Next.js App Router, TypeScript strict, Tailwind, shadcn/ui, TanStack Query (retry 2, backoff), ECharts (core build, lazy), zod types generated from OpenAPI, `Intl` for formatting, `decimal.js` for portfolio money.
- `next.config.js` rewrites `/api/:path*` to the Go API so cookies are first-party; no CORS.
- Auth gate in `middleware.ts`: no `session` cookie -> `/login`; any API 401 clears caches and redirects.
- CSP: `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'nonce-<per-request>'; connect-src 'self'` plus `font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`. No third-party scripts, fonts or iframes. (F01 amendment: Next.js emits inline bootstrap scripts, so `script-src 'self'` alone blocks hydration; `middleware.ts` adds a fresh nonce per request, which keeps every external or unnamed inline script blocked. The pre-paint theme script is the same-origin file `/theme-init.js`.)
- Other headers on every response: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, `Strict-Transport-Security`, `Cross-Origin-Opener-Policy: same-origin`. Images are not optimised (`images.unoptimized`, D-OQ8).
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
2. **Price header:** symbol, name, LTP, change, quote time + age badge, market status pill, RangeBar, Watchlist star, Alert bell, Refresh (hidden in manual mode), "Add transaction", "Compare"; a small notice "holiday list missing" when the year's holidays are not loaded.
3. **Refresh button:** **hidden in manual price mode** (current); the header instead shows a "Last price import: {bar date}" chip (amber when older than 1 trading day) and an "Import prices" link. Broker-mode behavior (inactive): `POST .../refresh`; spinner "Refreshing (can take up to a minute)"; poll `/jobs/{id}` every 3 s up to 3 min; `ok` -> invalidate queries + toast; 429 -> "You refreshed this recently. Try again in {n} min."; `failed` with `broker_session_missing` -> banner with Reconnect broker; timeout -> "Still working; data will update at the next scheduled run."
4. **Freshness chips** on every card (source + as-of; amber when stale). **DepthChip** on fundamentals.
5. **Banners:** manual price mode notice (broker banners and Reconnect are not built in manual mode), `UNCONFIRMED_ACTION` banner (Confirm/Reject), experimental banner, API `warnings[]` rendered always.
6. **Toasts, ConfirmDialog, Skeletons, ErrorBoundary per card** (one card failing never blanks the page).

## 5. States every data view implements
Loading (skeleton; "waking server" after 3 s) | Empty (explanation + action) | Partial (render available parts; missing parts `—` with reason; info banner) | Stale (amber chip) | Error (message + Retry + request id) | Backfill pending (progress card; polls job) | Offline (banner; cached) | Unauthorized (redirect with validated `next`).

## 6. Screens

### 6.1 Login
Password field (`autocomplete="current-password"`), show/hide, Enter submits, generic error "Invalid credentials or temporarily locked." No registration or forgot-password (CLI reset in RUNBOOK).

### 6.2 Dashboard
Tiles: Index sparklines (Nifty 50, India VIX; only if served, else reason), Market status/next open, Watchlist heatmap/treemap and movers, Upcoming events timeline (owner-entered), Portfolio snapshot (value, day change, XIRR) with the same All / Equity / Mutual funds switcher as 6.7 (default All, `data-testid` `dash-portfolio-view-all|equity|mf`, component state only) and allocation sunburst, Alerts activity, Data-health strip (broker session countdown with Reconnect, MF freshness, last job status), **This month, across the years** (6.2a; INV, PROPOSED, built by F17).

### 6.2a Dashboard tile: This month, across the years (decision INV, PROPOSED; built by F17 after B16; formulas `05` 12.2, field `stocks[].seasonality` of `GET /stocks/seasonality`, section 4b; D-INV2 widened the tile from the watchlist to all tracked stocks)
**Purpose.** For the calendar month that is running now, show how often each tracked stock's month ended higher than the month before in past years. It is a description of past prices, never a prediction or a buy signal.

**Placement.** After the watchlist heatmap and movers. It has its own query `GET /stocks/seasonality?scope=` (the React Query key includes the scope) and the Home page still works if it fails. Card `data-testid` `dash-seasonality`; title "This month, across the years", subtitle the month name, for example "November" (`dash-seasonality-month`).

**Row** (`dash-seasonality-row-{symbol}`, a link to `/stocks/{symbol}?tab=analysis`): symbol and name; the main line **"{n_green} of {n_years} years green ({green_pct}%)"** (percent with no decimals, `format.ts`); a small neutral bar filled to the share (colour never carries a judgement); the sub-line **"{n_years} years of this month, history starts {Mon YYYY}"** (`data_since`; the text never says "since listing", and the card footnote says "History starts at your first imported price, which may be later than the listing date"); a **"Small sample"** chip when `small_sample` (fewer than 5 years: "Only {n} years: a rough guide"); and the **month to date** shown separately as context: "{Month} so far: +1.23% (as of {date})" with arrow and sign (`dash-seasonality-mtd-{symbol}`), or an em dash with the reason ("no price bar yet this month"). The running month is never in the share (the card says so).
- A row whose `green_pct` is null (fewer than 3 years) is not ranked: it appears in a collapsed group "Not enough years yet ({k})" (`dash-seasonality-short`) with the reason "{n} years of this month so far; at least 3 are needed". A stock with no snapshot (`seasonality` null) appears there with its reason ("No prices imported" or "Not enough price history").

**Scope** (D-INV2, `dash-seasonality-scope`, radio-group semantics: a labelled group of two radios `dash-seasonality-scope-all|watchlist`, arrow keys move and select, Tab enters and leaves the group): **All stocks** (default, every tracked stock) and **Watchlist** (only watchlisted stocks); component state, sent as `scope`. In All mode a watchlisted stock carries a small chip **"Watchlist"** with a star icon (`dash-seasonality-watch-{symbol}`; text and icon, never colour only). The list caption names the scope.

**Controls** (keyboard operable, visible focus, 44 px targets): a sort control (`dash-seasonality-sort`, native select: "Best share first" (default: `green_pct` descending, then more years, then symbol), "Most years first", "Symbol A to Z", "Month so far, high to low"); a minimum-years select (`dash-seasonality-min-years`: 3 default, 5, 8; stocks below it move to the "Not enough years" group; component state, not stored). The ranked list is a table or list with `aria-sort` on the active sort and a polite live region announcing "{n} stocks shown" after a change.

**States.** *Loading*: skeleton rows; "waking server" after 3 s (shared). *Empty*: no tracked stocks (All): "No stocks are tracked yet. Import prices for a stock to see how this month has behaved in past years."; Watchlist scope with none: "Add stocks to your watchlist to see how this month has behaved in past years."; both with the Browse stocks button (`dash-seasonality-browse`). *Nothing ranked*: "No {scope} stock has {min} years of this month yet. Import more price history." ({scope} is "tracked" or "watchlist") with the short group still listed. *Partial*: stocks with null seasonality are listed with reasons; ranked ones render normally. *Stale*: an as-of chip on the card ("Analysis as of {date}"), amber when the snapshot is older than the expected trading date (same helper as the watchlist tiles); the share is still shown. *Error*: message + Retry + request id; this card failing never blanks the Dashboard.
**Mobile 375 px.** One column; each row is a stacked card (name and main line on top, bar and sub-line below, month to date at the end); the sort and minimum-years controls sit in a wrapped row above the list; no horizontal scroll; targets at least 44 px.
**Honesty.** Footnote (always shown, `dash-seasonality-note`): "Past behaviour is not a forecast. Counts only closed past months from your imported prices (price change, dividends excluded)." Every number carries the source "Your imported prices" and the as-of; a null shows an em dash with its reason; never 0 for an unknown.
**Data.** `stocks[].seasonality` of `GET /stocks/seasonality` (docs/03 section 4b); the tile computes nothing except sorting and filtering. With about 48 tracked stocks the ranked list is long: it stays one list and the short group stays collapsed.

### 6.3 Stocks browse
Search input, filters (Tracked only toggle, Sector, Index tag, Kind, Status), sortable virtualized table (Symbol, Name, Price, 1D, 1Y with sparkline, P/E if entered, Quality if available). Untracked rows show "Import prices to see history" (manual mode). With no instruments at all: "No stocks yet. Import instruments.csv or add a stock." with buttons to the Import center and the Add stock form.

### 6.4 Stock detail
Header (4.2). Tabs:

**Overview:** KPI grid (Market cap, P/E, P/B, ROE, ROCE, D/E, Div yield, 52w range) each with SourceChip (owner data) or "no data entered"; Gauges (Trend, Risk "relative to stocks tracked here", Quality with component popover, hidden for financial companies); mini candlestick 1Y; performance bars; upcoming events; corporate actions (confirmed and detected); research links card.

**Chart:** ECharts candlestick/line/area; ranges 1M-MAX; volume pane; overlays SMA 20/50/200, EMA 20/50, Bollinger; panes RSI, MACD, Stochastic, ADX; compare overlay (Nifty 50 if available or typed symbol, rebased); log scale; adjusted/raw toggle (adjusted = confirmed splits/bonus only, "price return, excludes dividends"); corporate-action markers; support/resistance bands; crosshair readout; touch pinch/zoom; weekly-candle note for long ranges. Indicator summary table with plain-language reads.

**Analysis (sub-tab of Chart):** drawdown chart, rolling volatility, return histogram, month x year heatmap, calendar heatmap, rolling beta, with definitions tooltips. **INV additions (6.4a, PROPOSED, F17):** Entry context strip, Price position, Drawdown profile, Holding periods, Entry-point study, Volatility regime, SIP versus lump sum, Risk-adjusted return, and the monthly heatmap's Year column and summary rows.

**Fundamentals:** toggles Quarterly/Annual and basis; groups P&L, Balance sheet, Cash flow, Ratios, Valuation; table with periods as columns (latest right), YoY/QoQ rows, sparkline column, selectable rows -> chart pane; P&L waterfall for the latest period; stacked balance composition; cash-flow chart; ROE decomposition; PE percentile strip; DepthChip; **owner-data CTA**: "Add results: manual form or import CSV" (opens Import wizard prefilled with the symbol); source chips show `manual`/`csv_import`; footnote "Figures are entered by you; verify against company filings."

**Ownership:** stacked chart by quarter, pledge line, QoQ diverging bars, small multiples, badges for sustained trends; note when MF figure missing; "Add quarter" form/CSV CTA.

**Peers:** requires owner-imported sector/industry; else EmptyState "Import sector data to see peers" with link. Peer table, percentile bars, bubble scatter, radar vs median, ranked bar chart; add/remove peers (session).

**Prediction (Experimental):** banner; per horizon bucket text + fan chart or plain-language hidden reason (including "Not enough tracked stocks to train a model" and "Confirm the possible split first"); trend/risk gauges; model card (version, date, OOS AUC/Brier vs baseline, folds, calibration plot, AUC-by-fold bars); live track record chart; "How to read this". Never a single price target.

**Events:** owner-entered calendar and corporate actions timeline (confirmed, detected-pending, rejected), add/edit forms, detected-action Confirm/Reject with the implied multiplier.

**Data (tab `data`):** transparency view (shows the `ADJUSTMENT_CONFLICT` warning text from `01` 3.7 when present): price history rows count, first/last date, sources used, suspect rows count, import batches affecting this stock, and links to undo/edit. **Manual mode:** a "Delete prices between {from} and {to}" action (date pickers, row-count preview, ConfirmDialog; `DELETE /stocks/{symbol}/prices`).

### 6.4a Analysis tab: investment-context cards (decision INV, PROPOSED; built by F17 after B16; formulas `05` section 12; data `GET /stocks/{symbol}/indicators` `data.analysis`, docs/03 4a)
**Principles.** Every card describes **past prices only**. There is no buy or sell verdict, no score, no ranking of attractiveness and no target price. Colour is never used to say good or bad (the heatmap's diverging return colours are the only exception and always carry a sign and a number). Each card shows: a title with a definition tooltip (the owner text lines of `05` 12.12, which F17 adds to the generator and regenerates into `definitions.ts`), a source and as-of chip ("Your imported prices, as of {date}, price return, excludes dividends"), its **sample size** ("based on {n} ..."), a **Small sample** chip when `small_sample`, a collapsed **How to read** disclosure (native `details`, `data-testid` `inv-{card}-howto`), and the fixed line **"Past behaviour is not a forecast."** (`inv-{card}-note`). Unknown values are an em dash with the reason as a tooltip and as visible text on mobile; never 0, NaN or Infinity. A missing block (older snapshot) shows "Not computed yet. It will appear after the next price import."

**Layout (top to bottom; the existing six views stay):** (1) basis note (existing); (2) **Entry context** strip; (3) **Price position** and **Volatility regime** side by side on desktop (stacked on mobile); (4) existing Drawdown chart, then **Drawdown profile** and **Swing dips** side by side on desktop (`xl:` two columns, stacked on mobile; the Drawdown profile is unchanged); (5) existing rolling volatility and histogram; (6) **Holding periods**; (7) **Entry-point study**; (8) **SIP versus lump sum**; (9) **Risk-adjusted return**; (10) **Monthly returns by year** (heatmap with the Year column and summary rows); (11) calendar heatmap and rolling beta (existing).

1. **Entry context** (`inv-context`, `05` 12.10): four fact tiles in a fixed order (price position band, current drawdown, volatility band, this calendar month), each with its own as-of and its own null reason; header line "Context, not advice or a signal." (`inv-context-note`). No icon, colour or order implies good or bad; no combined figure. Wording: "Trading in the lower third of its 52-week range" (the band); "{x}% below its highest close ({date})" or "At its highest close"; "Recent price swings are quieter than usual / typical / bigger than usual for this stock (percentile {p})"; "{Month} closed green in {k} of {n} years" (small-sample chip under 5 years). The running month's "{Month} so far: +x%" is separate context.
2. **Price position** (`inv-position`, 12.3): a range bar from the 52-week lowest close to the highest close with a marker for the last close (also printed as text, "{pos}% of the way up the 52-week range"), the band text, the distance from the 52-week highest close and from the highest close in your imported history (with its date and "your history starts {date}"), the two percentiles ("closed higher than {p}% of the days of the last 52 weeks / of your imported history ({n} days)"), and "{x}% above/below its 200-day average". How to read: low is not "cheap" and high is not "expensive"; a stock that has risen for years sits high in its own history.
3. **Volatility regime** (`inv-vol`, 12.7): current 21-day volatility (percent, annualised), its percentile among its own history with the sample count, the band wording. How to read: it says how bumpy the ride has been, not which way.
4. **Drawdown profile** (`inv-drawdown`, 12.4): current drawdown and days since the high; the deepest fall with peak, trough and recovery dates (or "not recovered yet"); time below a previous high ({pct}% of days); average depth while below; a two-row table for falls of 10% and 20%: episodes, recovered, still open, median days to recover (an em dash with "only {n} recovered episodes; at least 3 are needed" when hidden). Small-sample chip under 10 recovered episodes.
4a. **Swing dips** (`inv-swing`, `05` 12.13, decision SWD, PROPOSED; built by F19 after B18; an additional card, the Drawdown profile above stays as it is; reads `analysis.swing_dips`, docs/03 4a-swing). Shares the card shell of this section (definition tooltip `swing_dips`, source and as-of chip, sample size `inv-swing-sample`, Small sample chip `inv-swing-small`, How to read `inv-swing-howto`, the fixed line `inv-swing-note`). Content, top to bottom:
   - **How this differs** (`inv-swing-differs`), one sentence: "The drawdown profile measures every fall from the highest close in your history. Swing dips measure falls from the recent 52-week high, so a stock that peaked years ago still shows its repeated falls and recoveries."
   - **Summary table** (`inv-swing-table`, caption, scrollable focusable region at 375 px) with a row per fall size (10% and 20% below the 52-week high, `inv-swing-row-10`, `inv-swing-row-20`) and the columns: dips (count), recovered, **still open** (count; an open dip is never dropped), recovered share, median depth, worst depth, median days from peak to low, **median days to recover (completed dips only)**, longest open so far (days). A hidden figure is an em dash with the reason as visually hidden text and as a tooltip, and the visible list `inv-swing-reasons` below ("only {n} dips; at least 3 are needed", "only {n} recovered dips; at least 3 are needed", "no dip of this size", "none open"). `insufficient_history` replaces the row with "Needs about a year of prices (252 trading days)".
   - **Last dips** (`inv-swing-records`, a table with caption "Last 8 dips of at least 10%" and a segmented choice 10% | 20% as a native radio group `inv-swing-pick`, default 10%): columns peak (date, close), start, low (date, close), depth, days to low, days to recover or the open label. The open dip's row carries the text chip **Open** (`inv-swing-open`, text and a border style, never colour alone) and its recovery cell reads "not recovered yet (open for {n} days since the peak)"; a recovered row shows the recovery date and days. Newest first; "Showing the last {k} of {n} dips" when more exist.
   - **Swing legs** (`inv-swing-legs`, a second small table, heading "Swings inside the moves: a fall of X% followed by a bounce of X%"): per X: legs, bounced, open, median depth, worst depth, median days peak to low, median days low to bounce (completed only). Fixed caption: "A bounce is not a recovery of the old high; the last fall may still be going, so it is shown as open."
   - How to read: "A dip starts when the close is at least 10% (or 20%) below the highest close of the 52 weeks before it; it ends when the price is back at that earlier high. Falls that have not ended are counted as open. Median days to recover use only dips that ended, so they understate the wait for a stock that stays down. Days are calendar days between price dates."
   - Sample line: "Based on {dips} dips of at least {X}% in {bars} daily closes" (per row) and the Small sample chip when any shown row has `small_sample`. No verdict, no ranking, no colour for good or bad; numbers via `format.ts` (percent, count, number); em dash plus reason for any null; never 0, NaN or Infinity.
   - States: loading skeleton; **missing block** "Not computed yet. It will appear after the next price import."; `swing_dips` null with `swing_dips_reason` `compute_error`: empty state "Swing dips could not be computed for this stock (compute_error). The other cards are unaffected."; wrong shape: the card-level error; partial: figures with reasons; stale chip as the other cards. Mobile 375 px: one column, tables scroll inside labelled focusable regions, targets at least 44 px, no horizontal page scroll.
5. **Holding periods** (`inv-holding`, 12.5): a table with rows 1 month, 3 months, 6 months, 1 year, 3 years and columns windows (count), independent periods, share positive, median, worst, best (end dates as tooltips), small-sample chip. Fixed sentence: "Windows overlap, so {n} windows are fewer independent experiences than the count suggests. Returns are totals over the holding period, not per year."
6. **Entry-point study** (`inv-entry`, 12.6): a table with rows "after a close 10% below the 52-week high" and "20% below", column groups "next 3 months" and "next 6 months": episodes, median, worst, best, share positive; each group also prints "all days: median {x}" (`all_windows_median_pct`) for comparison. Below 3 episodes the cell is an em dash with "only {n} past episodes"; below 10 the card shows the sentence "Only {n} past episodes. This is an anecdote about this stock, not a pattern." (not only a tooltip), plus "{k} recent episodes have not completed the window yet" when `pending` is above 0.
7. **SIP versus lump sum** (`inv-sip`, 12.8): a day selector (`inv-sip-day`: "First trading day" default, 1 to 28; keyboard operable, native select) switching between the stored `variants`; outputs for "Monthly amount versus the same total as one lump sum at the start": instalments (and skipped), total invested (per INR 1,000 a month), value now for each, absolute return for each, XIRR for each (or "XIRR is shown once the history is a year long"), the ratio of final values ("the monthly plan ended at {x} times the lump sum"), and the worst unrealised result for each ("lowest point: {x}% below the money put in so far"). Banner: "A replay of the past with hindsight, not an estimate of the future." Hidden with the reason when there are fewer than 12 instalments.
8. **Risk-adjusted return** (`inv-risk`, 12.9): the Calmar-style ratio (3 years), the downside risk and the return per unit of downside; the existing 3-year maximum drawdown is printed beside it. "Sharpe" is not shown. Null reasons as text.
9. **Monthly returns by year** (`heatmap-month-year`, extends the existing card): months as columns, years as rows (the last 10 calendar years), then a visually separated last column **"Year (price return)"** (`heatmap-year-col`) with a definition tooltip ("price return, dividends excluded"; never labelled "total return"). The first year's cell is suffixed "partial" with the tooltip "only {k} months with a base", the running year's "YTD", and the running month's cell is outlined and suffixed "MTD" (tooltip "month still running; not counted below"). The Year column has its own diverging scale (annual values are larger) and prints its value. Below the grid, summary rows (`heatmap-summary`) in this order: **Average**, **Median**, **% of years green**, **Best** (with the year), **Worst** (with the year), **Years** (the count `n_years`); the Year column has its own summary over full years. Summary cells with fewer than 3 years show an em dash for the share and a "small sample" marker on the other statistics. Footnote: "Based on {n} years of data from {Mon YYYY}. The running month and the partial first year are not counted. Past behaviour is not a forecast." and, when more years exist than rows displayed, "Rows show the last 10 years; the summary uses all {n}". One line under the summary names the best and worst calendar month by median ("March: median +2.0% (3 years)"; hidden with its reason when fewer than 2 months are eligible). "Show data" lists every cell and summary value. At 375 px the grid scrolls inside a focusable labelled region with the year column pinned; the summary rows scroll with it. The shared `Heatmap` component gains optional trailing columns and footer rows (`06a` section 5).

**States (each card).** *Loading*: skeleton. *Empty / not computed*: the sentence above. *Partial*: available figures render, the others dashed with reasons. *Stale*: as-of chip amber when older than the expected trading date. *Error*: message + Retry + request id (the card fails alone). **Mobile 375 px:** one column; tables scroll horizontally inside a labelled focusable region or collapse to stacked label/value pairs (no horizontal page scroll); targets at least 44 px.
**Accessibility.** The range bar has a text equivalent, tables have captions and header scopes, the SIP day selector announces its result in a polite live region, "How to read" is a native details element, charts and tables have "Show data", no meaning by colour alone.

### 6.5 Compare
Picker (2-5), range chips, rebased chart, metrics table with best/worst highlights (direction-aware, heuristic noted), radar overlay, correlation matrix heatmap, shareable URL; short-history badges.

### 6.6 Screener
Filter builder (whitelisted metrics with units), presets, universe selector, results table with data bars/sparklines and coverage %, "excluded for missing data" counts, scatter plot of any two metrics, histogram of a metric with thresholds, Save screen, multi-select to watchlist, CSV export. Notice: fundamental filters only see stocks with owner-entered data.

### 6.7 Portfolio
Summary cards (Invested, Value, Unrealized, Realized, Day change, XIRR, vs Nifty 50 if available); holdings table; allocation sunburst/treemap; contribution bars; P&L waterfall; growth vs benchmark line; drawdown; transactions list with filters. Add transaction form (symbol search, side, qty, price, fees, date with weekend/holiday warning, note) with server messages (`INSUFFICIENT_HOLDINGS`). Adjustments panel (confirmed actions applied, override, "review needed" for rights/mergers/unconfirmed detected). Estimated dividends card (from owner-entered dividend actions; excluded from XIRR).

### 6.7a Portfolio views: All, Equity, Mutual funds (decision D-MF; spec only, built by F16 after B15)
**Switcher.** A three-segment control at the top of `/portfolio` (and the Dashboard snapshot): `All` | `Equity` | `Mutual funds`, `data-testid` `pf-view-switcher`, segments `pf-view-all`, `pf-view-equity`, `pf-view-mf`. State lives in the URL (`/portfolio?view=all|equity|mf`, default `all`, an unknown value falls back to `all`); keyboard operable (radio-group semantics, arrow keys), the active segment is announced; switching never reloads the page and keeps the previous view's data on screen while the next loads (no layout jump). The view is a filter: every number comes from `GET /portfolio/summary?view=` (the UI sends `view` explicitly, MFH-14) and the screen never computes totals or XIRR itself.

**What each view shows** (summary cards use the existing card component; every card shows unit, source and as-of, or a reason when null):
| Card / section | All | Equity | Mutual funds |
|---|---|---|---|
| Money invested (cost of units/shares still held) | yes | yes | yes |
| Current value | yes | yes | yes |
| Profit/loss: unrealised, plus separate Realised and IDCW income cards (never merged into one number) | yes | yes (no IDCW card) | yes |
| XIRR, or Absolute return when under one year (`05` 8.5.6) | yes (pooled flows) | yes | yes |
| Day change | yes (each part with its own date) | yes | yes |
| vs Nifty 50 | hidden (reason `not_defined_for_view`) | yes | hidden |
| Breakdown table (Equity row, Mutual funds row: invested, value, P&L, XIRR each) with the footnote "XIRR cannot be added or averaged; each row uses only its own cash flows." | yes | no | no |
| Holdings | two tables, "Stocks" then "Mutual funds" (each with its own totals row) | stocks table (as F11) | MF holdings table |
| Allocation | by asset class, then by stock/sector and by scheme/category (each sleeve sums to 100%) | stock, sector | scheme, category |
| Transactions list and Add form | tabs "Stock transactions" / "MF transactions" | stock | MF |
| Estimated dividends card | yes (equity only, labelled) | yes | hidden |
| Adjustments panel | yes | yes | hidden |
Return-basis labels: stock figures "price return (excludes dividends)"; MF figures "total return (includes IDCW payouts)"; in All both labels appear next to their sleeves and the All cards carry the line "Stocks: price return. Mutual funds: total return." (`05` section 1, D-MF 4).

**MF holdings table** (`data-testid` `pf-mf-holdings-table`, row `pf-mf-row-{scheme_code}`): scheme name (links to `/mf/{code}`), plan chip (Direct/Regular/unknown) and option chip (Growth/IDCW/unknown), folio(s) (expand for per-folio rows, `group=folio`), units, avg cost, invested, NAV with `nav_date`, value, unrealised P&L and %, realised, IDCW income, day change, weight, XIRR or absolute return with an "under 1 year" chip. Sort and column rules as the stock table; exited schemes behind the "Show exited" toggle. IDCW rows show the warning chip "IDCW: returns include payouts you entered".

**MF transactions:** list (`pf-mf-txn-list`) with filters scheme, folio, type, date range, source (manual/import) and Load more; **Add MF transaction** form (`pf-mf-txn-form`): scheme search (reuses the fund search; shows plan/option), folio, type (purchase, SIP, redemption, IDCW payout, IDCW reinvest; the three unsupported types are not offered, and a server `MF_TXN_TYPE_NOT_SUPPORTED` is shown inline), date (weekend/holiday warning), units, NAV, amount, stamp duty, note; server messages `INSUFFICIENT_UNITS`, `AMOUNT_MISMATCH`, `UNITS_ROUNDED`, `DUPLICATE_LOOKING_TXN` inline; edit and delete with the sequence re-validation message. **Import statement** button (`pf-mf-import-open`) opens `/imports?kind=mf_statement` (wizard of F13: choose file, validate, preview the first 20 rows with counts by type, matched schemes and date range, errors by row, commit; Undo in batches). The page never shows file contents beyond the normalised preview.

**States (docs/06 section 5), per view:** *Loading*: skeletons per card, "waking server" after 3 s. *Empty*: for `mf` with no MF transactions: "No mutual fund transactions yet. Import your broker's MF statement or add a transaction." with the two actions; `all` with only one class present shows that class plus a hint card for the other; with nothing at all, the existing empty copy. *Partial*: unpriced holdings or missing NAV render with an em dash and reason ("No NAV for this fund yet"), the card total shows an em dash with the reason "Value unavailable: {names} have no NAV" instead of a partial sum; an info banner lists the unpriced names. *Stale*: amber chip "NAV as of {date}" on each stale MF row and on the card (more than 4 calendar days old; value still shown); stock staleness as F11. *Error*: message + Retry + request id (existing component); one failed card degrades alone. *Under one year*: the XIRR card reads "Absolute return" with the sublabel "XIRR is shown after the first year" (never an annualised figure, never 0). *No XIRR possible* (`no_sign_change`, `insufficient_flows`, `no_nav`): em dash with the reason text.

**Honesty rules (all views).** Every number shows its unit (INR, units, %), its source ("your statement" or "your entries" for units and amounts; "NAV data: AMFI, via mfapi.in" for value) and its as-of date. Unknown values are an em dash with a tooltip reason; never `0`, `NaN`, `Infinity` or a partial total presented as complete. Figures that mix sources (All) say so. Percent signs and up/down arrows follow section 3. Total return and price return are never put in one unlabelled column. "Realised" and "IDCW income" are separate from "Unrealised". No forecast, target or advice text appears on these views (forecasts keep their own banner rules on the stock Prediction tab). Footer disclaimer and MF attribution are present (SAF-03).

### 6.8 Alerts
List with status chips; create dialog (target, kind, dynamic params with units, one-shot, cooldown, expiry); Telegram card (not linked/linked; code + deep link + 15:00 countdown; polls `/auth/me` every 3 s up to 2 min; Send test; Unlink); history with delivery status; quiet hours editor; threshold-already-met error shown inline.

### 6.9 Mutual funds
`/mf`: debounced search, filters (category, fund house, plan Direct default, option Growth default, show all, group variants), rows with latest NAV and 1Y when tracked. `/mf/[code]`: header (name, house, category, plan/option chips, NAV + date, star); NAV chart with rolling-return band; returns table + heatmap; calendar-year bars; rolling-return histogram; risk (volatility, drawdown, Sharpe-like); SIP calculator with growth area chart and installment markers; lumpsum calculator; warnings (IDCW, inactive); notice "AUM, expense ratio and manager are not available from this data source"; attribution "NAV data: AMFI via mfapi.in". `/mf/compare`: rebased chart, risk-return scatter, returns heatmap table.

### 6.10 Import center (`/imports`)
Tabs: **Upload** (choose type -> Wizard: upload -> validate -> preview first 20 rows with row/column errors and warnings -> commit with note "as per filing dated ..."), **Templates** (download per kind), **Manual forms** (**Add stock**, quarterly results, annual, shareholding, corporate action, calendar event), **Batches** (list, undo with overwrite warning; price and instruments batches not undoable), **Storage** (DB size meter vs 380 MB with 70/85/95% warnings; **Trim history**: choose stocks and a cutoff date, preview rows and MB freed, ConfirmDialog). The `instruments` and `prices` wizards show the estimated DB growth and block commit when the size guard fails. The `prices` wizard also shows the **required choice** "These prices are: raw / already adjusted for splits and bonus / I don't know" (blocks commit while the setting is unset; "I don't know" opens the **Adjustment check**: symbol, ex-date, optional ratio -> table of closes around the ex-date, observed ratio, advisory hint) and the wizard text of `01` 3.7. A `holidays` wizard loads a whole year (replace-per-year). Large price CSVs: if spike S9 shows the proxy limit is below 25 MB, the wizard splits the file in the browser into parts under the measured limit and commits them as one logical batch (same upload group id, one transaction at commit). Persistent notice: "Enter or import only data you have the right to use. Prefer company filings and your own records." No Screener tab (not built, D-5).

### 6.11 Settings
Password change; display (theme, number format, show experimental); Telegram; **Broker** (status, minutes left, Connect/Reconnect/Disconnect, "never stores your password; read-only data access"); sessions (list, revoke, logout all); export (watchlist/portfolio/alerts/owner data as JSON/CSV); About (versions, data sources, safe-use policy link, THIRD_PARTY_NOTICES).

### 6.12 Admin status
Per-source cards (mfapi, amfi, telegram), last runs with counts/durations, coverage numbers (tracked, with prices, with owner fundamentals), DB size bars (warn at 70/85/95%, limit at 380 MB), recent errors (50), holiday status with a **persistent warning for each year with no holiday list** ("Holiday list missing for {year}: weekends only; import holidays.csv"), no "run job" buttons in v1.

## 7. Accessibility
WCAG 2.1 AA; contrast >= 4.5:1 (text) and 3:1 (graphics) in both themes; visible focus; keyboard-operable search/dialogs/charts' data tables; `aria-live="polite"` for refresh/import results; touch targets >= 44 px; no color-only meaning; reduced motion respected; labeled forms; charts have "Show data".

## 8. Field coverage matrix (every API field has a home; a test enforces this)
| API response | Fields -> UI element |
|---|---|
| `/stocks/{symbol}` | name, symbol, isin, series, sector, industry, listing_date -> Header + Overview "Company" card; company_type -> hides debt metrics/quality; status/flags -> badges; broker_ok/price_mode -> notices; quote.* -> Header/RangeBar; freshness.* -> chips; backfill -> progress card |
| `/prices` | bars -> Chart; adjusted/actions -> toggle + markers; warnings -> banner |
| `/indicators` | returns -> performance bars/table; technicals -> indicator table + panes; scores.trend/risk/quality (+components, coverage) -> Gauges + popover; series -> overlays/panes; analysis arrays -> Analysis tab; INV additions `analysis.year_returns`, `seasonality`, `position`, `drawdown_profile`, `swing_dips`, `holding_periods`, `entry_study`, `vol_regime`, `sip_backtest`, `risk_adjusted` -> Analysis tab cards (6.4a) |
| `/fundamentals` | basis_used/available -> toggle label; periods/labels/metrics -> tables; derived -> YoY rows/margins; ratios -> Ratios group + KPI; valuation -> Valuation group; periods_available/source_by_metric -> DepthChip/source chips; status/entry_hint -> CTA |
| `/shareholding` | all series, qoq_change, latest_filed_on, mf_available, note -> Ownership tab |
| `/events` | actions (confirmed/detected/rejected), calendar -> Events tab + Overview |
| `/peers` | all metrics, percentile_rank, self, sector/industry, note -> Peers tab |
| `/links` | links -> Research links card |
| `/prediction` | disclaimer, as_of, ref_close, horizons[*], trend, risk, model.*, track_record.* -> Prediction tab |
| `/market/overview` | indices, vix, movers, market_status -> Dashboard/top bar |
| `/compare` | rebased, metrics, best -> Compare |
| `/screener/query` | items, coverage, excluded_for_missing -> Screener |
| `/portfolio/summary` | holdings, totals, xirr, realized/unrealized, day change, allocation, benchmark, adjustments_applied -> Portfolio; D-MF additions `view`, `asset_classes_present`, `totals.idcw_income/total_pnl/purchase_cash`, `returns.span_days/first_flow_date`, `breakdown`, `mf_holdings`, `allocation_by_scheme/category/asset_class` -> Portfolio views (6.7a) |
| `/portfolio/mf/holdings`, `/portfolio/mf/txns*` | every item field -> MF holdings table, MF transactions list and form (6.7a) |
| `/watchlist` | stocks, funds -> Watchlist/Dashboard; `stocks[].seasonality.*` kept for compatibility |
| `/stocks/seasonality` | month, as_of, stocks[].on_watchlist / seasonality.* / seasonality_reason -> This month, across the years tile (6.2a) |
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
- No MF transactions: "No mutual fund transactions yet. Import your broker's MF statement or add a transaction."
- Under one year: "XIRR is shown after the first year. Absolute return is shown instead."
- Missing NAV total: "Value unavailable: {names} have no NAV yet."
- Switch/merger entry: "Switches and merger/bonus entries are not supported yet. Enter a switch as a redemption plus a purchase."

## 10. Frontend test plan
Unit: formatters, search ranking, fiscal labels, definitions, decimal sums. Component: each card in each state (Storybook/Vitest). E2E (Playwright, mocked API fixtures): login/lockout; search `M&M` and `BAJAJ-AUTO`; every stock tab with partial data; refresh flow (queued/ok/429/failed/timeout); broker reconnect banner; detected-split confirm flow; add transaction (valid/invalid/oversell); alert creation incl. threshold-already-met; Telegram link flow; import wizard (valid, errors, undo); MF search and SIP; screener build/save; mobile snapshots; dark/light; axe on every route; field-coverage test.
