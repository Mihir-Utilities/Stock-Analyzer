# 05. Analytics, Portfolio, Mutual Fund and ML Specification (Safe Edition)

Every formula here must have a unit test with a hand-computed or reference-library expected value (tolerance stated). Where a number is a design choice (weights, thresholds), it lives in `app_setting` so it can change without code changes, and its default is listed here. Design choices are not evidence-based facts; they are documented judgements.

---

## 1. Conventions

- Prices for returns/indicators: `adj_close` (series A). **Price returns only**: dividends are not adjusted in the Safe Edition; the UI says "price return (excludes dividends)". High/low/open scaled by `k = adj_close/close` per row when "adjusted" is needed. Suspect rows excluded before anything else; gaps are never forward-filled.
- **Mutual fund holdings are the one place where dividends/payouts ARE included (decision D-MF 4).** Stocks keep the price-return rule above. For the portfolio's mutual fund sleeve (section 8.5): a **Growth** plan's NAV already reflects reinvested income, so units x NAV is a total-return value and needs no special handling; an **IDCW** plan's NAV drops by every payout, so the owner's return must be **total return**: payouts are cash inflows in XIRR (`idcw_payout`) or extra units (`idcw_reinvest`). The scheme-level returns of section 9 (NAV only) stay price-only for IDCW schemes and keep the "not comparable" warning. The UI labels portfolio MF figures "total return (includes IDCW payouts)" and stock figures "price return (excludes dividends)"; the combined view shows both labels (docs/06 6.7).
- Trading-day windows: 1W=5, 1M=21, 3M=63, 6M=126, 1Y=252 trading rows. **Display returns** (performance table) use calendar offsets (1M, 3M, 6M, 1Y, 3Y, 5Y) with the latest bar on or before `end_date - offset`; used in UI. ML and indicators use trading-row windows.
- Annualization factor 252. `ddof=1` sample std unless stated.
- Null rules: insufficient history for a window -> `null` (never partial-window values). Division by zero or non-positive base for growth -> `null` with reason `n/m`.
- Rounding: compute in float64; round only for display (frontend). API returns up to 6 significant decimals for ratios, 2 for percent values expressed as percent (e.g., `12.34` means 12.34%). **All percent fields in the API are percent numbers (12.34), not fractions**, except ML probabilities and `ret_q*` which are fractions (documented in the API spec).
- All series are aligned on the stock's own trading dates; cross-asset alignment (beta, rebasing, ML market features) uses inner join on dates.

## 2. Canonical metric keys (`fundamental_value.metric_key`)

| Key | Unit | Meaning |
|---|---|---|
| `pnl.revenue` | INR_CR | Total revenue/income |
| `pnl.ebitda` | INR_CR | |
| `pnl.operating_income` | INR_CR | Operating profit (EBIT-like as reported by source) |
| `pnl.other_income` | INR_CR | (screener import) |
| `pnl.interest` | INR_CR | Finance costs, positive magnitude |
| `pnl.depreciation` | INR_CR | |
| `pnl.pbt` | INR_CR | Profit before tax |
| `pnl.tax` | INR_CR | |
| `pnl.net_profit` | INR_CR | Net profit attributable to common shareholders |
| `pnl.eps` | INR | EPS per share (diluted preferred) in the share units valid at period end |
| `pnl.nii`, `pnl.provisions` | INR_CR | Financials only (if available) |
| `bs.total_assets`, `bs.total_liabilities`, `bs.equity`, `bs.borrowings`, `bs.current_liabilities`, `bs.cash` | INR_CR | Period-end balances |
| `bs.equity_capital`, `bs.reserves`, `bs.fixed_assets`, `bs.investments`, `bs.inventory`, `bs.receivables` | INR_CR | (screener import) |
| `bs.shares_outstanding` | SHARES | Period-end shares |
| `bs.deposits`, `bs.advances` | INR_CR | Financials only |
| `cf.cfo`, `cf.cfi`, `cf.cff` | INR_CR | |
| `cf.capex` | INR_CR | Positive magnitude of capital expenditure |

Derived metrics (computed, not stored): `fcf = cfo - capex`, margins, growth, ratios, valuation.

Source priority per (basis, period_type, metric_key): `manual > csv_import > screener_import`; `derived` rows are never stored as primary data. The most recently entered value of the winning source wins. `source_by_metric` reports it. Fundamentals exist only for stocks where the owner entered or imported data; everywhere else metrics are null with reason `no_data_entered`.

## 3. Technical indicators (compute on the stock's valid bars)

Let `C,H,L,V` be adjusted close/high/low and volume. Warm-up positions are null.

- **SMA(n)**: mean of last n closes.
- **EMA(n)**: `EMA_t = alpha*C_t + (1-alpha)*EMA_{t-1}`, `alpha = 2/(n+1)`, seeded with SMA of the first n values. (Test tolerance 1e-6 relative after 3n bars against pandas `ewm(span=n, adjust=False)` seeded the same way.)
- **RSI(14), Wilder**: changes `d_t = C_t - C_{t-1}`; first avg gain/loss = simple mean of the first 14 gains/losses; thereafter `avg = (prev_avg*13 + current)/14`; `RS = avg_gain/avg_loss`; `RSI = 100 - 100/(1+RS)`; if `avg_loss == 0` then RSI = 100 (if also `avg_gain == 0` then 50).
- **MACD(12,26,9)**: `macd = EMA12 - EMA26`; `signal = EMA9(macd)`; `hist = macd - signal`. Valid after 26+9 bars.
- **Bollinger(20,2)**: middle = SMA20; band = `2 * std(C, 20, ddof=0)` (population std, standard convention); `bb_pos = (C - lower)/(upper - lower)`.
- **True range** `TR_t = max(H_t-L_t, |H_t-C_{t-1}|, |L_t-C_{t-1}|)`. **ATR(14), Wilder**: first = mean of first 14 TR; then `(prev*13 + TR)/14`.
- **ADX(14)**: `+DM = H_t - H_{t-1}` if > `L_{t-1} - L_t` and > 0 else 0; `-DM = L_{t-1} - L_t` if > `H_t - H_{t-1}` and > 0 else 0. Wilder-smooth `TR`, `+DM`, `-DM` over 14 (first = sum of first 14, then `prev - prev/14 + current`). `+DI = 100*smooth(+DM)/smooth(TR)`, `-DI` likewise, `DX = 100*|+DI - -DI|/(+DI + -DI)`, `ADX` = Wilder average of DX (first = mean of first 14 DX, then `(prev*13+DX)/14`).
- **Stochastic(14,3)**: `%K = 100*(C - LL14)/(HH14 - LL14)` (if denominator 0 then 50); `%D = SMA3(%K)`.
- **OBV**: `OBV_t = OBV_{t-1} + sign(C_t - C_{t-1}) * V_t`.
- **Volume z-score**: `(V_t - mean(V_{t-20..t-1}))/std(V_{t-20..t-1})` (prior 20 days, excluding today; null if std=0).
- **52-week high/low**: over the last 252 rows of scaled `H`/`L` (`k`-scaled). `dist_52w_high_pct = (C/high52 - 1)*100`. For display of the quote's range use `quote_latest.wk52_*` if present, else the computed values.
- **Support/resistance**: swing high at row t if `H_t == max(H_{t-5..t+5})`; swing low analog; use last 250 rows excluding the last 5 (unconfirmed). Cluster levels within 1.5% by averaging; return up to 3 supports below price and 3 resistances above, ordered by distance.
- **Golden/death cross flags**: SMA50 vs SMA200 crossings in the last 20 bars.

## 4. Returns and risk

- `ret_N` (trading-row) `= C_t / C_{t-N} - 1`.
- Display returns by calendar window: `C_end / C_start - 1`, where `C_start` is the last bar on or before `end_date - offset`; if the first bar is after that date -> null. Windows > 1 year also show CAGR: `(C_end/C_start)^(365.25/days) - 1`.
- `vol_N = std(ln(C_t/C_{t-1}) over last N, ddof=1) * sqrt(252)`.
- Max drawdown over window W: `min_t (C_t / max_{s<=t,s in W} C_s - 1)`.
- Beta (252): OLS slope of the stock's daily simple returns on Nifty 50 (`NIFTY50` series) returns over the last 252 aligned returns; require >= 120 aligned observations, else null. Correlation likewise.
- Sharpe-like: `(CAGR_3y - RISK_FREE_RATE) / vol_3y`, shown as "return per unit of risk (simple)"; null if < 3y.
- Liquidity: `adv_value_60 = mean(close * volume)` over 60 rows in INR crore.

## 5. Fundamental derived metrics and valuation

Fiscal calendar: India FY ends 31 March; Q1 = Apr-Jun (period_end 30 Jun), Q2 = Jul-Sep, Q3 = Oct-Dec, Q4 = Jan-Mar. FY label = year of the March period end (FY27 = Apr 2026 - Mar 2027).

Matching periods: "same quarter last year" = quarter with `period_end` within +/-20 days of `period_end - 1 year`; "previous quarter" within +/-20 days of `period_end - 3 months`.

- `growth_yoy = (x_t / x_{t-1y} - 1) * 100`, `null` (reason `n/m`) if `x_{t-1y} <= 0` or missing. Same for QoQ.
- `cagr_Ny` from annual values exactly N fiscal years apart: `((x_end/x_start)^(1/N) - 1)*100`, requires both > 0.
- `op_margin = operating_income / revenue * 100` (fallback `ebitda/revenue` labeled EBITDA margin); `net_margin = net_profit / revenue * 100`.
- `ebit = pbt + interest`.
- **ROE** = latest annual `net_profit / average(equity_t, equity_{t-1})`, `*100`; if prior equity is missing use ending equity and set `roe_basis='ending'`; equity <= 0 -> null.
- **ROCE** = `ebit / average(capital_employed_t, _{t-1}) * 100`. Primary `capital_employed = equity + borrowings` (Screener's published definition: share capital + reserves + borrowings); fallback `total_assets - current_liabilities` when equity or borrowings is missing in either year. The basis used is stored as `roce_basis` (`equity_plus_debt` | `assets_less_cl`) and the two are never mixed in one ranking. A missing `interest` row counts as 0 (ebit = pbt). Known difference: Screener excludes exceptional items from ROCE; we use `pbt + interest`, so values can differ for companies with large one-offs.
- `debt_equity = borrowings / equity` (latest annual); equity <= 0 -> null. `interest_coverage = ebit / interest` (interest 0 or missing -> null reason `no_interest`, consistent with ROCE treating missing interest as 0).
- `cfo_to_pat = cfo / net_profit` (net_profit <= 0 -> null); `cfo_to_pat_avg = mean over up to 5 annual years` requires >= 3.
- **TTM EPS** = sum of EPS over the latest 4 consecutive quarters (each `period_end` ~3 months apart +/-20 days; same basis and source). If unavailable use latest annual EPS and set `pe_basis='latest_annual'`; else null.
- **Corporate-action adjustment for per-share values:** for EPS and book value per share with `period_end < ex_date <= today`, divide by the product of qty multipliers of those actions (the stored `close` may be raw or adjusted per `PRICES_ALREADY_ADJUSTED` / `src_adjusted`; use `adj_close` consistently and reported EPS is in then-current units, so apply only **confirmed** actions). Dividends unaffected.
- `pe = close / eps_ttm_adj`; eps <= 0 -> null reason `loss_making`.
- `bvps = equity / shares_outstanding` (INR crore -> INR: multiply by 1e7); adjusted as above. `pb = close / bvps`; if inputs missing, fall back to `top_ratio.pb` labeled with its source.
- `div_yield = sum(dividend per share with ex_date in last 365 days) / close * 100`.
- `ev_ebitda = (market_cap + borrowings - cash) / ebitda` (all INR crore; `market_cap = close * shares_outstanding / 1e7`); ebitda <= 0 -> null.
- `peg = pe / eps_cagr_3y` only when `eps_cagr_3y > 0`.
- **PE percentile (5Y)**: for each trading day t in the last 5 years compute `pe_t = C_t_raw / TTM_EPS_available_at_t` where an EPS value is available from `filed_on` (if null: `period_end + 45 days`, conservative); keep `pe_t` where EPS > 0; percentile of today's PE among these (needs >= 750 points); else null.
- Financial companies (`company_type='financial'`): compute only `pe`, `pb`, `roe`, `div_yield`, growth of `net_profit`, and `nii` growth if present; others null by design (UI hides panels).

## 6. Scores (stored in `analysis_snapshot.scores` with components and coverage)

### 6.1 Trend score (0-100; rule-based)
Points: close > SMA50 (20); close > SMA200 (20); SMA50 > SMA200 (20); ret_21 > 0 (10); ret_126 > 0 (10); ADX14 > 20 and +DI > -DI (10); MACD hist > 0 (10). Requires >= 200 bars else null.
Labels: 0-20 `strong_down`, 21-40 `down`, 41-60 `sideways`, 61-80 `up`, 81-100 `strong_up`.

### 6.2 Risk score (0-100, higher = riskier)
Percentile ranks (0-100) across tracked stocks that have >= 252 valid bars, computed nightly (requires at least 20 such stocks, else the risk score is null with reason `universe_too_small`): `vol_252` (weight 0.35), `abs(maxdd_3y)` (0.25), `abs(beta_252 - 1)` direction ignored: use `max(beta,0)` (0.20), illiquidity = `100 - percentile(adv_value_60)` (0.20). Missing components: renormalise weights; require >= 3 components. Labels: < 33 `low`, 33-66 `medium`, > 66 `high`. (Relative to the stocks tracked by this app; state this in the UI.)

### 6.3 Quality score (0-100; general companies only)
Component score = linear interpolation clipped to [0,100]. Weights and anchors (anchor_low -> 0, anchor_high -> 100):

| Component | Weight | Anchors |
|---|---|---|
| ROE | 15 | 5% -> 0, 25% -> 100 |
| ROCE | 10 | 8% -> 0, 30% -> 100 |
| Revenue CAGR 3Y | 12.5 | 0% -> 0, 20% -> 100 |
| Net profit CAGR 3Y | 12.5 | 0% -> 0, 25% -> 100 |
| Debt/Equity (lower better) | 10 | 2.0 -> 0, 0.1 -> 100 |
| Interest coverage | 10 | 1.5 -> 0, 8 -> 100 |
| CFO/PAT 5Y avg | 15 | 0.3 -> 0, 1.0 -> 100 |
| Promoter pledge % (lower better) | 10 | 30 -> 0, 0 -> 100 |
| Promoter holding trend 1Y | 5 | change <= -5 pts -> 0, >= 0 -> 100 |

Score = sum(weight x component)/sum(weights of available components). `coverage = available weight / 100`; if coverage < 0.6 -> score null, reason `insufficient_data`. Display all components. A "no debt" company (borrowings 0) gets D/E = 100 and coverage component skipped.

## 7. Peer selection
1. Candidates: `instrument_kind='equity'`, `status='active'`, same `industry`, `symbol != self`, with `market_cap_cr` available.
2. If fewer than 4 candidates: widen to same `sector`.
3. Keep candidates whose market cap ratio to self is within [0.25, 4]; if < 4 remain, widen to [0.1, 10]; if still < 4, return what exists with `note="few comparable peers"`.
4. Rank by `abs(ln(mcap/mcap_self))`; take top `limit` (default 8).
5. Percentile rank of each metric among peers + self (average rank for ties); the UI decides direction (lower P/E is "cheaper").

## 8. Portfolio math

### 8.1 Lots and holdings
- Each buy creates a lot `(date, qty, unit_cost)` with `unit_cost = (qty*price + fees)/qty` (fees capitalised into cost).
- Each sell consumes lots **FIFO** by `(trade_date, id)`; realized P&L = `sell_qty*sell_price - sell_fees_share - consumed_cost`, with the sell's fees allocated pro rata to quantity.
- Average-cost basis for open holdings = remaining cost / remaining qty (shown as "Avg cost"); unrealized = `qty*LTP - remaining cost`. Both FIFO realized and average-cost unrealized are shown and labeled (a known mix: FIFO governs which lots remain).
- Same-day buy and sell: process buys before sells on the same date unless the user's `id` order says otherwise (order by `trade_date`, then `id`).

### 8.2 Corporate actions and adjustments
Sources: owner-entered/imported actions (status `confirmed`) and app-detected candidates (status `detected`, never applied until the owner confirms; see `01-data-sources.md` 3.7). There is no text parsing of exchange announcements in the Safe Edition.
- Split (face-value change): `ratio_num` = old face value, `ratio_den` = new face value; **qty multiplier = ratio_num/ratio_den** (10 -> 2 gives 5).
- Bonus: `ratio_num` = new shares, `ratio_den` = shares held; **multiplier = (ratio_num + ratio_den)/ratio_den** (1:1 gives 2; 1:2 gives 1.5).
- `split_or_bonus` (detected): the detector's fraction `r` (price multiplier, e.g. 0.5) implies multiplier `1/r`. On confirmation the owner selects `split` or `bonus` and the final numbers; the multiplier must equal `1/r` within 3% or the UI warns.
- Dividend: informational (`amount_per_share`); rights, buyback, merger, demerger: never auto-applied; flagged "review needed" in the portfolio.
Adjustment rule: for every lot with `trade_date < ex_date <= as_of`, `qty *= multiplier` and `unit_cost /= multiplier` (total cost unchanged). Lots bought on/after ex_date are in post-action units already. A sell on date d validates against holdings computed with confirmed actions having `ex_date <= d`. Owner overrides in `portfolio_adjustment` take precedence for the same `(instrument, ex_date)`. History adjustment (`adj_close`): for each trading date t before ex_date, `adj_close_t = close_t * product(1/multiplier for confirmed actions with ex_date > t)` when `PRICES_ALREADY_ADJUSTED=false`.

### 8.3 XIRR
Cash flows: buy `-(qty*price + fees)` at trade_date; sell `+(qty*price - fees)`; plus a terminal inflow of current market value (`sum(qty*LTP)` using latest price as of `as_of`) dated `as_of` (only for open holdings). `t_i = (date_i - date_0)/365`. Solve `sum(cf_i/(1+r)^t_i) = 0`. Method: bracket on `r in [-0.9999, 100]` and use Brent's method (bisection fallback), tolerance 1e-7, max 200 iterations. Return null if no sign change or fewer than one outflow and one inflow. If total span < 30 days (first flow to the terminal value dated `as_of`, or to the last flow when no holding is open), display absolute return only and mark XIRR `n/a (period too short)`. **(Amended by D-MF 2 / MFH-3, pending the owner's answer: once the mutual fund feature lands, a span under 365 days shows absolute return instead of XIRR for every view and holding, section 8.5.6; the 30-day rule then only guards the absolute-return calculation itself.)** Test vector: flows `-1000` on 2020-01-01 and `+1100` on 2021-01-01 -> r = 0.09973 (leap-year day count: 366/365; tolerance 1e-4).

### 8.4 Other portfolio outputs
- Day change = `sum(qty * (LTP - prev_close))` for holdings.
- Allocation by stock and by sector (market value share).
- Estimated dividends received: for each owner-entered dividend action with ex_date inside the holding period: `qty_held_at_record_date * amount_per_share`; shown separately as "estimated, not included in XIRR/P&L".
- Benchmark comparison: invest the same cash flows into Nifty 50 (`NIFTY50` series from the broker, price index, excludes dividends) and report its XIRR; omitted with a note if the index series is unavailable. The benchmark assumes the same cash flows invested in NIFTY; its units may go negative when the owner's sales outperformed the index (hypothetical comparison, B11-10), so it always computes when the series covers the first flow.
- Brokerage, STT, taxes beyond the `fees` the user enters are not modelled.

### 8.5 Asset-class views and mutual fund holdings (decisions D-MF, D-MF3; questions MFH-2..MFH-24)
All amounts are INR, computed with decimals (`shopspring/decimal`), never floats; units and NAV keep 4 decimals; money is returned as 4-decimal strings. Percent fields are percent numbers.

**8.5.1 One ledger, three views.** Every dated movement becomes an entry `(asset_class, instrument_or_scheme, folio, date, type, units/qty, amount)`: stock rows of `portfolio_txn` get `asset_class='equity'`, rows of `mf_txn` get `'mf'` (physical tables stay separate, MFH-2). A **view** is a filter over the ledger: `equity` = equity entries, `mf` = mf entries, `all` = both. Holdings, cost, P&L and XIRR are always computed from the filtered ledger by the same functions; there is no separate "total" calculation. The three views' numbers need **not** add up (XIRR is not additive), and the UI never sums or averages XIRRs.

**8.5.2 MF lots and FIFO.** Per `(scheme_code, folio)`, ordered by `(txn_date, type_rank, id)` where type_rank puts unit-adding rows (`purchase`, `sip`, `idcw_reinvest`) before `redemption` on the same date (same rule as B11-1; `idcw_payout` has no units). A unit-adding row creates a lot `(date, units, unit_cost = cost/units)`: for `purchase`/`sip` the **cost is `amount + stamp_duty`** (`amount` is units x NAV and stamp duty is a separate charge, MFH-6 correction of 2026-11-11 from the owner's statement; example: amount 999.95 + stamp duty 0.05 is a lot of cost 1000.00); for `idcw_reinvest` the cost is the reinvested `amount` (MFH-17; a stamp duty on it is stored for reference only). A `redemption` consumes lots FIFO by `(date, id)`; consumed cost of a partly used lot is `unit_cost x units_taken` (pro rata, no rounding until display); `realized_pnl += amount - consumed_cost`. A redemption larger than the held units: `INSUFFICIENT_UNITS` (accepted with `UNITS_ROUNDED` when it exceeds by <= 0.001, clamped to held units, MFH-8). `idcw_payout` adds `amount` to `idcw_income` and creates no lot. Golden example (stamp duty 0 unless stated; a lot bought for amount 999.95 + stamp duty 0.05 has cost 1000.00): lots 100.0000 u cost 1000 and 100.0000 u cost 1200; redeem 150 u for 2250 -> consumed 1000 + 0.5 x 1200 = 1600, realised 650; remaining 50 u cost 600; at NAV 14 value 700, unrealised 100.

**8.5.3 Value, invested, P&L (per holding row = one scheme, folios summed; per folio optional).**
- `units = sum(remaining lot units)`; zero units = **exited** (hidden unless `include_exited`; its realised P&L and IDCW income stay in the totals).
- `nav` = `nav_on_or_before(as_of)` (9.1) for that scheme; `nav_date` its date. `market_value = units x nav`. **Stale rule:** `nav_stale = (as_of - nav_date) > 4 calendar days` (same limit as docs/03 section 1 and B10-3); a stale value is still shown, with the chip, never hidden or zeroed. **No NAV row on or before `as_of`**: `nav`, `market_value`, `unrealized_*`, `xirr_pct` are `null` with reason `no_nav`.
- `invested = sum(remaining lot cost)` (the owner's definition: **cost of units still held**; reinvested IDCW lots included, MFH-17). `avg_cost = invested / units`.
- `unrealized_pnl = market_value - invested`; `unrealized_pct = unrealized_pnl / invested x 100` (`null`, reason `n/m` when invested is 0).
- `realized_pnl` (sum over redemptions, FIFO) and `idcw_income` (sum of `idcw_payout` and `idcw_reinvest` amounts) are separate buckets, each shown on its own; `total_pnl = unrealized_pnl + realized_pnl + idcw_income` (null when any open holding has no value; the reason names the schemes, `missing_nav: <name>, ...`, the existing B11 wording style).
- `weight_pct` = holding value / the view's total value x 100 (null when the total or the holding is unpriced).
- Day change = `units x (nav - previous_nav)` using the scheme's two latest NAV rows on or before `as_of`; null with reason `no_previous_nav` or `nav_stale` (a stale NAV has no meaningful day change). The view total is null with a reason naming the unavailable schemes if any open holding lacks it; in `all` the equity and MF parts are shown separately in `breakdown` and each uses its own latest close/NAV date (labelled).
- Totals of a view = decimal sums of the holdings (and for `all`: equity totals + MF totals). `market_value` is null (reason `missing_nav: ...` or `missing_price: ...`) if any open holding in the view is unpriced; never a partial sum presented as the total.

**8.5.4 Cash flows for XIRR (exact rules).** Per view, from its ledger entries up to `as_of` (entries dated after `as_of` are ignored):
| Entry | Flow dated at the entry date |
|---|---|
| equity buy | `-(qty x price + fees)` (section 8.3) |
| equity sell | `+(qty x price - fees)` (section 8.3) |
| `purchase`, `sip` | `-(amount + stamp_duty)` (MFH-6 correction) |
| `redemption` | `+amount` |
| `idcw_payout` | `+amount` |
| `idcw_reinvest` | **no flow** (cash never left the owner; the units are valued in the terminal flow) |
| `switch_out`, `switch_in` (v2) | scheme-level view: `+amount` / `-amount`; `mf` and `all` views: the matched pair cancels and contributes no flow (MFH-22); not implemented in v1 |
| terminal | `+market_value` of the open holdings **of that view**, dated `as_of`: equity `sum(qty x LTP)` and/or MF `sum(units x nav)`; none for exited holdings; omitted if any open holding is unpriced (XIRR then `null`, reason `missing_nav` or `missing_price`) |
`all` pools the equity and MF flows into one list sorted by date and solves **one** equation (8.3 method, `t = days/365`). It is **never** the average (or value-weighted average) of the two XIRRs. A holding row's `xirr_pct` uses only that holding's flows plus its own terminal value.

**8.5.5 Golden vectors (tolerance 1e-4 on the rate).**
- MF only (a purchase of amount 999.95 + stamp duty 0.05 gives the same `-1000` flow): `-1000` on 2024-01-01, `-1000` on 2024-07-01, terminal `+2300` on 2025-01-01 -> r = 0.20214.
- Equity only: `-5000` on 2024-01-01, terminal `+5500` on 2025-01-01 -> r = 0.09971.
- All (pooled flows of the two above: `-1000`, `-5000` on 2024-01-01, `-1000` on 2024-07-01, terminal `+7800` on 2025-01-01) -> r = 0.12294; the average of the two (0.15093) is wrong and a test asserts it is not returned.
- SIP: `-1000` on 2024-01-05, 2024-02-05, 2024-03-05, terminal `+3300` on 2025-03-05 -> r = 0.09213.
- IDCW payout: `-1000` on 2023-01-01, `+50` payout on 2024-01-01, terminal `+1100` on 2025-01-01 -> r = 0.07400.
- With a redemption: `-1000` on 2023-01-02, `-1000` on 2024-01-02, `+1200` on 2024-07-01 (redemption), terminal `+1000` on 2025-01-02 -> r = 0.08033.

**8.5.6 Under one year: absolute return instead of XIRR/CAGR (D-MF 2, MFH-3).** For a view or a holding, `span_days` = (the valuation date `as_of` while any holding of it is open, **else the date of its last flow**) - the date of its first flow; a fully exited position has no terminal value, so its span ends at its last flow, the same convention as section 8.3 (B15 review S3, decision B15R-4). A position opened and closed within 60 days therefore shows `under_one_year` and its absolute return even when it is viewed years later. If `span_days < 365`: `xirr_pct = null`, `xirr_reason = "under_one_year"`, and `absolute_return_pct` is shown (MFH-18: `(market_value + redemption_proceeds + idcw_cash - purchase_cash) / purchase_cash x 100`, with MF `purchase_cash` = sum of `amount + stamp_duty` of `purchase` and `sip` rows (MFH-6 correction); for equity `purchase_cash` = buys incl. fees and proceeds are net of fees; `absolute_return_basis` says so). If `span_days >= 365`: XIRR is shown **and** the absolute return is also returned (labelled "simple, not annualised"). A SIP holding whose first instalment is over a year old is annualised even though its latest instalments are recent (the flows carry the dates); the UI footnote says "XIRR weights each instalment by how long it was invested". Return null with the existing reasons when no sign change (`no_sign_change`), fewer than one outflow and one inflow (`insufficient_flows`), or `purchase_cash = 0` (`no_purchases`). `span_days < 30` also keeps the reason `period_too_short` only when the absolute return cannot be computed.

**8.5.6a Owner-facing wording (F16 review S2).** The app shows these three short texts in its tooltips instead of the formulas above; `apps/web/scripts/gen-definitions.mjs` reads the lines that start with `- **Owner text (key):**`. They contain no ids or section numbers and do not change any maths.

- **Owner text (xirr_pooled):** Your yearly rate of return across your stocks and mutual funds together, counting every purchase, sale and payout on the date it happened. It cannot be added up or averaged from the separate stock and fund figures.
- **Owner text (absolute_return):** The simple percentage gain on the money you put in, not turned into a yearly rate. It is shown instead of XIRR until your first purchase is a year old.
- **Owner text (mf_total_return):** For mutual funds the return includes dividend (IDCW) payouts you received, so a fund that pays out is not made to look worse. Growth plans already include reinvested income in their value. Stock figures leave dividends out.

**8.5.7 Edge cases (each has an MFH- row in docs/07).**
- *No NAV for the scheme:* value, unrealised, total P&L and XIRR null with `no_nav`; units and invested still shown; totals follow 8.5.3 (null with reason naming the scheme).
- *NAV missing for a transaction date:* never an error (the row carries its own NAV from the statement); a scheme whose first stored NAV is later than the transaction date raises warning `NAV_FEED_STARTS_AFTER_TXN`; `mf_nav` gaps (weekends, holidays) use `nav_on_or_before` only for valuation.
- *Zero units:* exited, no terminal flow, XIRR from the realised flows only (positive and negative flows both present), realised P&L shown.
- *Same-day multiple transactions:* order per 8.5.2; two identical rows are legitimate (no dedupe on manual entry; the importer keeps every identical row of a file as its own transaction and only warns `DUPLICATE_IN_FILE`, MFH-12, MFH-24; the same folio number may appear under two funds and is never unique per fund); a warning `DUPLICATE_LOOKING_TXN` on manual create.
- *Future-dated transaction:* rejected (`422`, field `txn_date`); import row error.
- *Negative or zero units/NAV/amount:* rejected; reversals are not modelled (MFH-16).
- *Redemption before any purchase or above held units:* `INSUFFICIENT_UNITS`; edits and deletes re-validate the whole `(scheme, folio)` sequence.
- *Fund merger or closed scheme:* `mf_scheme.status='inactive'` or last NAV older than 10 days -> warning `SCHEME_MAY_BE_MERGED` (9.5) and `nav_stale`; value uses the last NAV and says so; `bonus_merger` is unsupported in v1 (MFH-13).
- *IDCW scheme with no `idcw_*` rows recorded:* warning `IDCW_PAYOUTS_NOT_RECORDED` ("returns exclude payouts you have not entered").
- *Stock `PRICES_ALREADY_ADJUSTED`, splits and adjustments:* unchanged and equity-only; MF units never receive corporate-action adjustments (the AMC reports unit changes on the statement).
- *Taxes, exit load beyond `amount`, TDS:* not modelled; P&L is pre-tax.

## 9. Mutual fund math

### 9.1 Point-in-time NAV
`nav_on_or_before(d)` = NAV with the latest date <= d; null if none. End date = the scheme's latest NAV date.

### 9.2 Returns
For window offset N (1M, 3M, 6M, 1Y, 3Y, 5Y): `start = nav_on_or_before(end - N)`; if no NAV exists at or before that date -> null. For N < 1 year: absolute `end/start - 1`. For N >= 1 year: CAGR `(end/start)^(365/days) - 1` with `days = end_date - start_date` (actual dates used). `r_ytd`: start = NAV on or before 31 Dec of the previous year. `r_since`: CAGR since first NAV if >= 1 year else absolute.
Rolling 1Y returns: for each NAV date d with a NAV at or before `d - 1Y`, CAGR over that window; report min, median, max, and share of windows with positive return.

### 9.3 Risk
`vol = std(ln NAV_t/NAV_{t-1}, ddof=1) * sqrt(252)` over 3Y (or full history if shorter but at least 1Y, else null). Max drawdown on NAV. If the median gap between NAV dates exceeds 3 days (some funds publish weekly NAV), vol is null. Sharpe-like as in section 4.

### 9.4 SIP simulation
Inputs: monthly `amount`, `start`, `end`, `day` (1-28, default 1). Installment dates: the `day` of each month from `start` to `end`; each is executed at the NAV on the first date >= installment date (next available NAV date; assumption mirroring next-business-day allotment). `units = amount / NAV` (no load/duty modelling). Final value = `sum(units) * latest NAV on or before end`. Outputs: invested, value, absolute return, XIRR (section 8.3 method), installments count, skipped installments (those before first NAV). IDCW schemes: show a warning that payouts are not modelled.

### 9.5 Warnings
- `option_type='idcw'`: returns computed from NAV exclude payouts: show "not comparable".
- `status='inactive'` or last NAV older than 10 days: "scheme may be merged/closed".
- History shorter than window: null with tooltip.

## 10. Experimental ML specification

### 10.1 Scope
Targets: direction over `h in {5, 21}` trading days and the 80% return band. Universe: tracked stocks with >= 750 valid bars and no unconfirmed actions; training requires **at least 20 such stocks** (there is no separate "training basket" concept: the universe is simply every tracked stock that meets the bar and unconfirmed-action rules; the owner grows it by importing prices), otherwise training is skipped with status `insufficient_universe` and all forecasts are hidden. Survivorship bias exists (delisted stocks absent) and is documented in the UI model card.

### 10.2 Timing and leakage rules (hard requirements)
- A prediction made for date `t` uses only data available after the close of `t` in India. Row features use bars up to and including `t`.
- Label: `y_dir = 1 if C_{t+h}/C_t - 1 > 0 else 0`; `y_ret = ln(C_{t+h}/C_t)`.
- Market features come only from broker-served series available at the Indian close of `t`: `NIFTY50` and `INDIAVIX` (if served; U in S5). No foreign-market, currency or commodity features exist in the Safe Edition.
- Fundamental features are excluded in v1 (avoids filing-date leakage). If added later, use only values with `filed_on <= t` (or `period_end + 45 days`).
- No feature may use cross-sectional statistics computed over future dates; cross-sectional ranks are computed per date `t` over stocks available on `t` only.
- Overlapping horizons are controlled by an embargo of `h` trading days between train and validation windows (purge training rows whose label window overlaps validation).

### 10.3 Features (per stock-date)
Log returns over 1, 5, 10, 21, 63, 126; `vol_20`, `vol_60`, `vol_20/vol_60`; RSI14; `macd_hist/C`; `bb_pos`; `atr14/C`; ADX14; `dist_52w_high`, `dist_52w_low`; volume z-score; `adv_value_60` (log); `beta_252`; relative strength (stock `ret_21` minus Nifty `ret_21`); market: Nifty ret_5, ret_21, vol_20; India VIX level and 5-day change (omitted entirely, for all rows, if the series is unavailable); cross-sectional percentile ranks (per date) of `ret_21`, `vol_20`, `adv_value_60`; day-of-week (categorical). Missing feature values -> row dropped (no imputation) except market series gaps filled forward by at most 1 day.

### 10.4 Models and training
- Direction: LightGBM binary classifier per horizon, fixed seed; parameters (defaults): `num_leaves=15`, `min_data_in_leaf=500`, `feature_fraction=0.8`, `bagging_fraction=0.8`, `bagging_freq=1`, `learning_rate=0.03`, `lambda_l2=10`, up to 300 rounds with early stopping on the inner validation fold.
- Range: volatility-scaled approach. `sigma_t` = EWMA daily vol (lambda 0.94) at `t`; `z = y_ret / (sigma_t*sqrt(h))`. Quantile models (LightGBM `objective=quantile`, alpha 0.1/0.5/0.9) predict quantiles of `z`; band = `sigma_t*sqrt(h) * q_z`. **Conformal calibration:** adjust `q10` and `q90` additively on a held-out calibration window so empirical coverage of the [q10,q90] band equals 80%. Baseline band: empirical z-quantiles of the training window (no model).
- Walk-forward: expanding window; initial train = first 36 months; validation folds of 3 months; embargo `h` days; at least 12 folds; evaluation focuses on the last 8 folds (about 2 years). Final model for inference = trained on all data up to `t_last - h`.
- Probability calibration: isotonic regression fitted on the out-of-fold predictions of the previous folds.
- Baselines: B1 constant base rate from the training window; B2 logistic regression on `ret_21`, `vol_20`; B3 momentum sign (`ret_21 > 0` -> p = 0.55 else 0.45 for scoring).

### 10.5 Metrics and guardrail (defaults; judgement, not evidence)
For each horizon compute per fold: AUC, Brier, log loss, accuracy, ECE (10 bins), and band coverage. Aggregate over the last 8 folds. A horizon `guardrail_pass = true` only if **all**:
1. Mean AUC over folds >= 0.53 and the block-bootstrap (resampling by calendar month, 2,000 resamples) 95% lower bound of mean AUC > 0.50.
2. Brier <= Brier(B1) - 0.0005 in at least 6 of 8 folds.
3. ECE <= 0.03 on the pooled out-of-fold predictions.
4. Band coverage between 0.76 and 0.84 on the last 4 folds.
5. Not worse than B2 in AUC by more than 0.005 (a trivial logistic model should not beat it).
Live gate: after >= 100 resolved live predictions for a horizon, if live AUC < 0.50 or live band coverage outside [0.70, 0.90], set `guardrail_pass = false` for that horizon until a newer model run passes again and live metrics recover. Implementation defaults (owner may change, D07-17/D07-18): the gate also needs >= 20 distinct `as_of` dates; "recover" = the newer run's own >= 100 resolved live predictions on >= 20 dates without a trip. Horizons and outcomes are exactly h trading days (D07-19).

### 10.6 Per-stock display rules
Show a prediction only if: bars >= 504; `adv_value_60 >= 0.5` (INR crore); no corporate action ex-date within the next 5 or last 5 trading days; data fresh (last bar within 3 trading days); guardrail passes for that horizon. Otherwise `shown=false` with `hidden_reason` from the API enum. Probability bucket thresholds are in the API spec.

### 10.7 Track record
`prediction_outcome` rows are created when the horizon completes: `realized_return = C_{t+h}/C_t - 1`, `direction_correct = (realized > 0) == (p_up >= 0.5)`, `in_band = q10 <= realized <= q90`. The model card shows live hit rate, coverage and count, and the date the tracking started. Never rewrite past predictions.

### 10.8 Reproducibility
Store feature list hash, parameters, train/valid ranges, seed, library versions in `model_run.valid_metrics.meta`. Training must be deterministic given identical data. Unit tests: no-leakage test (shuffle future prices after `t` and assert features at `t` unchanged), label alignment test, embargo test.

## 11. Test strategy for formulas
- Golden tests against a pinned reference implementation (e.g., `ta`/`pandas-ta` versions pinned in test requirements) for indicators; differences must be within stated tolerance after warm-up.
- Property tests: XIRR sign and monotonicity; FIFO conservation (sum of sold qty cost equals consumed lots); portfolio value invariant under splits.
- Fixture tests: for 10 companies, computed ratios from owner-entered figures vs published figures within +/-2% relative (S16).
