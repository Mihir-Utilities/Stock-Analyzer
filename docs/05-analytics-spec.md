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

### 8.6 Portfolio risk: concentration, position stress, value history and drawdown (decision PRK, PROPOSED 2026-11-12; built by B19, shown by F20; questions PRK-1..PRK-8 in `docs/OPEN_QUESTIONS.md`)
All three blocks read the same ledger as the summary (section 8.5.1): a view (`all`, `equity`, `mf`) is a filter, open holdings only, money is decimal, nothing is fetched. They describe the portfolio **as it is and as it was**. They contain no verdict, no target and no forecast, and no word such as "too concentrated" or "safe".

**8.6.1 Concentration** (per view, at `as_of`, open holdings only; exited holdings are excluded).
- `value_i` = the holding's market value (stock `qty x LTP`, MF `units x NAV`, as in 8.5.3). `total = sum(value_i)`. `w_i = value_i / total` (a fraction inside the maths, returned as a percent number `weight_pct = 100 x w_i`, 2 decimals).
- **Unpriced rule (never a partial total):** if any open holding of the view has no value (no price or no NAV), `total` is `null` with the summary's own reason (`missing_price: A, B`, `missing_nav: ...` or both joined), and **every** `weight_pct`, the top-N shares, `hhi` and `effective_holdings` are `null` with that reason. A priced holding still shows its own `value`. With no open holding the reason is `no_open_holdings` and the lists are empty. A total that is not positive is `zero_value`.
- `holdings_count` = number of open holdings of the view (priced or not). `top1_pct`, `top3_pct`, `top5_pct` = the sum of the largest 1, 3, 5 weights in percent (ties broken by key; **fewer holdings than N: the share of all of them, which is 100**, and the UI prints the count next to the figure so a reader sees "top 5 of 3").
- `hhi = sum(w_i^2)` as a **fraction in (0, 1]** (not the 0-10000 scale; a single holding is 1, ten equal holdings 0.1). `effective_holdings = 1 / hhi` (2 decimals; "as if you held this many equal-sized holdings").
- **Groups** (`by_group`): equity holdings are grouped by the owner-imported `instrument.sector`; a holding with a missing or blank sector goes into a visible slice named **Unclassified** (PRK-2), never dropped and never spread. MF holdings are grouped by `mf_scheme.category` (missing or blank: **Unclassified**) in the `mf` view; in `all` the funds are **one** slice named **Mutual funds** (their category is not an equity sector and the underlying stock sectors of a fund are not known). `group_hhi` is the HHI of the group weights, `group_top1_pct` the largest group's weight; both follow the unpriced rule. A group row: `{key, kind (sector|category|mutual_funds|unclassified), value, weight_pct, holdings}`. The look-through (what a fund owns) is out of scope: a fund is one holding.
- Weights here are computed from the decimal values, not from the rounded percent fields of the summary.
- **Golden vector C1** (INR): A 5000 (sector Banks), B 3000 (Banks), C 1500 (IT), D 500 (no sector); total 10000. Weights 50, 30, 15, 5; `top1_pct` 50, `top3_pct` 95, `top5_pct` 100 (4 holdings); `hhi = 0.25 + 0.09 + 0.0225 + 0.0025 = 0.365`; `effective_holdings = 1/0.365 = 2.74`. Groups: Banks 80, IT 15, Unclassified 5; `group_hhi = 0.64 + 0.0225 + 0.0025 = 0.665`; `group_top1_pct` 80. One holding of 700: weight 100, `hhi` 1, `effective_holdings` 1.
- **Golden vector C2** (unpriced): the same four holdings but D has no price: `total` null, reason `missing_price: D`; every weight, share, hhi and effective number null with that reason; A, B, C keep their `value`; the group list has the same rows with `value` null and every `weight_pct` null.

**8.6.2 Position stress ("what if", arithmetic only).** For each open holding and each fall `f` in {10, 20} percent: `impact_f = -value_i x f / 100` (rupees, negative, 4-decimal string) and `impact_f_pct = 100 x impact_f / total` (percent of the **current** portfolio value, a negative percent number, 2 decimals). It assumes that holding alone falls and nothing else moves; it is not a prediction, a probability or a stress model, and it ignores taxes and fees. A holding without a value has `impact_*` null (reason `no_price` or `no_nav`); with a value but no `total` the rupee impact is shown and the percent is null with the total's reason. **Vector S1** (C1 holdings): A -500.0000 / -5.00 and -1000.0000 / -10.00; B -300 / -3.00 and -600 / -6.00; C -150 / -1.50 and -300 / -3.00; D -50 / -0.50 and -100 / -1.00. Rows are ordered like `by_holding` (largest first).

**8.6.3 Value history and the time-weighted index (PRK-1).** One daily series per view, reconstructed from transactions and stored prices; **nothing is stored**, it is computed on read.
- *Series dates.* The calendar is the union of (a) the dates on which at least one held stock has a valid (non-suspect) bar and (b) the NAV dates of the held schemes, between the first transaction date of the view and `as_of`. A date on which **no** held stock has a bar is treated as a non-trading day for stocks (a holiday): stocks keep their last close and the date is a series date only if a held scheme has a NAV that day. With a single held stock a missing bar is therefore indistinguishable from a holiday (documented limitation).
- *Quantity at a date.* For a stock, the FIFO replay of section 8.1 with the confirmed adjustments and owner overrides of 8.2 up to and including that date (a split multiplies the quantity on its ex-date, so the value is continuous across it); MF units after the transactions up to and including that date. A transaction dated on a non-series day (a weekend entry) takes effect at the end of the next series date. A stored sequence that oversells is excluded and raises the warning `HOLDINGS_INCONSISTENT` (as in the summary).
- *Price at a date.* Stock: its own bar on that date; if none and the date is a stock non-trading day, its last bar before it; otherwise **missing**. A bar flagged `src_adjusted` is in current units, so the quantity is multiplied by every adjustment multiplier dated after the bar and on or before `as_of` (the same conversion the summary applies to a stale LTP, section 8.2). MF: the latest NAV on or before the date (9.1) when it is at most 4 calendar days old (the stale limit of 8.5.3), otherwise **missing**.
- *Value.* `V_d = sum(qty_i(d) x price_i(d))` over the holdings at the end of date `d`. It includes the owner's deposits and withdrawals and is shown only as "value, includes money you added or took out".
- *A valid date* is one where every holding held at the end of `d` or at the end of the previous valid date has a price. A date that is not valid is a **gap** (`missing_price: A, B` or `nav_gap: S`; PRK-3): it has no value, no index and no drawdown, and it is never a sum of the other holdings. Gaps are returned as ranges.
- *Time-weighted return index* (base 100 at the first valid date with a positive value). For a valid date `d` with the previous valid date `p`: `W_d = sum(qty_i(p) x m_i x price_i(d))` (the holdings that were held at the end of `p`, valued at the prices of `d`; `m_i` is the product of the adjustment multipliers dated in `(p, d]`, so a split does not look like a fall) and `r_d = W_d / V_p - 1`; `I_d = I_p x (1 + r_d)`. Buys, sells, fees and the rupees paid never enter `r_d`, so a deposit cannot hide a fall and a withdrawal cannot fake one (flows are treated as happening at the end of the date, after the close; execution prices and fees are not modelled). If `V_p = 0` (the portfolio was empty at `p`: before the first buy, or after a full exit) there is nothing to compound and `I_d = I_p` (flat). Dates on which the portfolio is empty and was already empty are **not** series dates (an exit day itself is, with value 0, and so is the day of re-entry). Time-weighting is exact across a gap when the holdings did not change inside it; if a transaction fell inside the gap (the holdings at the last calendar date before `d` differ from those at `p`) the step is **unknown**: `I_d = I_p`, the step is counted in `skipped_steps` and the warning `HISTORY_STEP_SKIPPED` names the date. An unknown step is never counted as 0 percent silently in any statistic; it is disclosed.
- *Drawdown on the index.* `P_d = max(I over series dates up to d)` (a date with `I_d >= P` becomes the new peak date), `dd_d = (I_d / P_d - 1) x 100` (<= 0, percent number). `current_drawdown_pct = dd_last`, `peak_date` the date of the running maximum, `days_under_water` = calendar days from `peak_date` to the last series date (0 at a peak). `max_drawdown = {depth_pct, peak_date, trough_date, recovery_date, recovered}` for the deepest `dd_d` (ties: the earliest), `recovery_date` the first later date with `I >= peak` or null with `recovered=false` (the same definitions as 12.4 applied to the portfolio's own index). With fewer than 2 points the drawdown figures are null with `too_few_points`.
- *Why not raw value:* a raw value drawdown measures from the highest rupee value, so a large new deposit after a fall makes the value rise and the fall disappear.
- **Golden vector TW1 (mid-period contribution; the raw value hides the fall).** Stock A, closes on 2024-01-01..05: 100, 110, 99, 99, 108.9. Buys: 10 at 100 on 01-01, 10 at 110 on 01-02, 20 at 99 on 01-03 (no fees). End-of-day holdings 10, 20, 40, 40, 40; value 1000, 2200, 3960, 3960, 4356. `W`: 01-02 10x110 = 1100 (r = +10%); 01-03 20x99 = 1980 (r = 1980/2200 - 1 = -10%); 01-04 40x99 = 3960 (r = 0); 01-05 40x108.9 = 4356 (r = +10%). Index 100, 110, 99, 99, 108.9; `dd` 0, 0, -10, -10, -1. Current drawdown -1.00, peak 2024-01-02, `days_under_water` 3; `max_drawdown` -10.00, peak 01-02, trough 01-03, not recovered. The raw value never fell below its running maximum (1000, 2200, 3960, 3960, 4356), which is exactly the fall a raw-value drawdown would miss.
- **TW2 (full exit and re-entry).** Stock B, closes 01-01..05: 50, 55, 56, 60, 54. Buy 10 at 50 on 01-01; sell all 10 at 55 on 01-02; buy 5 at 60 on 01-04. Series dates 01-01 (value 500, index 100), 01-02 (r = +10%, index 110, value 0), 01-03 omitted (empty both days), 01-04 (the portfolio was empty at the previous valid date: index flat 110, value 300), 01-05 (W = 5x54 = 270, V_p = 300, r = -10%, index 99, value 270). Current drawdown -10.00, peak 01-02, `days_under_water` 3; `max_drawdown` -10.00, trough 01-05, not recovered.
- **TW3 (a missing price date).** A: 10 shares bought at 100 on 01-01; C: 10 shares bought at 200 on 01-01. Closes 01-01..04: A 100, 110, 121, 121; C 200, 200, (no bar), 180. 01-03 is a gap (`missing_price: C`; A has a bar so the day is a trading day). 01-01: value 3000, index 100. 01-02: W = 1100 + 2000 = 3100, index 103.3333. 01-04: holdings unchanged inside the gap, `W = 10x121 + 10x180 = 3010`, `r = 3010/3100 - 1 = -2.9032%`, index `103.3333 x 3010/3100 = 100.3333`; `dd = -2.90`; `skipped_steps` 0; `gaps` = one range 01-03 to 01-03 (1 date).
- **TW3b (a trade inside the gap).** As TW3, plus a sale of 5 A at 121 on 01-03. At 01-04 the holdings at the last calendar date before it (A 5, C 10) differ from those at 01-02 (A 10, C 10): the step is unknown, `skipped_steps` 1, index stays 103.3333 on 01-04 (value 5x121 + 10x180 = 2405), warning `HISTORY_STEP_SKIPPED`.
- **TW5 (the MF 4-day rule, view all).** Stock A: 10 shares bought at 100 on 2024-01-01, closes 01-01 100, 01-02 100, 01-08 110, 01-09 110. Scheme S: 100 units bought at NAV 10 on 01-01; NAVs 01-01 10, 01-02 10, 01-09 10.2. 01-08: the latest NAV is 6 days old, so the date is a gap (`nav_gap: S`). 01-09: holdings unchanged, `W = 10x110 + 100x10.2 = 2120`, `V_p = 2000` (01-02), `r = +6%`, index 106.0.
- **TW6 (split).** Stock D: 10 shares bought at 100 on 01-01 (close 100); confirmed 2:1 split with ex-date 01-02; raw closes 01-02 52, 01-03 55. Quantity 10 on 01-01, 20 from 01-02. `W(01-02) = 10 x 2 x 52 = 1040` (the multiplier dated in `(p, d]` applies), `r = +4%`, index 104; 01-03 `W = 20x55 = 1100`, `r = +5.7692%`, index 110.
- *Cost.* The loader reads each held instrument's bars once between its first transaction and `as_of`; the work is linear in (series dates x holdings) and the response size is bounded by the number of series dates (about 2,500 for 10 years). Target: under 500 ms for about 200 transactions and 10 years of daily prices (measured in B19).

**8.6.4 Edge cases (each has a PRK- row in docs/07).** No transaction in the view up to `as_of`: `series_reason = no_transactions`, empty `points`. Transactions but no price/NAV at any series date: `series_reason = no_priced_dates`. `as_of` ignores later transactions and later bars. An open position that has no bar at all: its dates are gaps (`missing_price: SYM`), never carried from "before the first bar". Index base is 100 whatever the portfolio size. A holding with 4 decimal quantity is exact (decimal). Percent fields are percent numbers; `hhi` and the index are plain numbers, not percents.

**8.6.5 Owner-facing wording.** Read by `apps/web/scripts/gen-definitions.mjs` (marker `- **Owner text (key):**`); no ids, no section numbers.

- **Owner text (pf_concentration):** How your money is spread over what you hold. The share of the biggest holding, of the biggest three and of the biggest five, and one number that says how many equal-sized holdings your spread is equivalent to. It describes today's values only. It is not advice about what to hold.
- **Owner text (pf_hhi):** Add up the square of each holding's share of your portfolio, as a fraction. It is 1 for a single holding and gets smaller the more evenly you spread. One divided by it is the effective number of holdings.
- **Owner text (pf_stress):** A what-if, not a forecast. If only this one holding fell by 10% or 20% from today's value and nothing else changed, this is how much your portfolio value would change in rupees and in percent. It is simple arithmetic on today's values.
- **Owner text (pf_twr):** Your portfolio's own return line starting at 100, built from the price moves of what you held each day. Money you add or take out is left out, so adding money cannot hide a fall and taking money out cannot create one. Dividends are not included for stocks.
- **Owner text (pf_drawdown):** How far the return line is below its own highest point so far, the deepest such fall and how many days it has been below that point. It describes the past of your portfolio. It does not say what happens next.

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

## 12. Investment-context analytics (decision INV, PROPOSED 2026-11-11; built by B16 in the worker, shown by F17; questions INV-1..INV-28 in `docs/OPEN_QUESTIONS.md`)

Purpose: help the owner see how a stock has behaved before deciding when to buy. These are **descriptions of past prices**. They are not signals, scores, targets or predictions, and no number here says "buy" or "sell". Every block is computed from the stock's own imported prices only (no new data source, no network). The shared rules below apply to every subsection.

### 12.0 Conventions

- **Series.** `C_0..C_{N-1}` = `adj_close` of the valid bars (suspect and non-finite rows removed first, section 1), `D_i` the IST bar dates, ascending. **Price return only; dividends are excluded** (INV-1): every label says "price return". All extremes (highs, lows, peaks) are **close-based** (INV-12): "highest close", not the intraday high, so they can differ slightly from `technicals.high_52w`.
- **Rows, not calendar.** Windows are trading rows: 1M=21, 3M=63, 6M=126, 1Y=252 (also "52 weeks"), 3Y=756 (section 1). A window needs all its rows; otherwise the value is `null` with reason `insufficient_history`. Gaps in the owner's data are never filled (section 1).
- **Units.** Percent fields are percent numbers (12.34 = 12.34%), including shares of years or windows (`green_pct` 66.67) and percentiles (0-100). Ratios are plain numbers. Hypothetical INR amounts (SIP backtest) are JSON numbers rounded to 2 decimals and labelled hypothetical; they are not portfolio money.
- **Null rule.** A value that cannot be computed is `null` with a sibling `<name>_reason` (`insufficient_history`, `too_few_years`, `too_few_months`, `too_few_windows`, `too_few_episodes`, `n/m`, `no_drawdown`, `no_base`, `gap_before`, `incomplete_month_data`, `under_one_year`, `history_under_12_months`, `no_bar_this_month`, `flat_range`). Never 0, NaN or Infinity.
- **Sample size travels with the number.** Every statistic carries its count (`n_years`, `windows`, `episodes`, `rows`) and a `small_sample` boolean. Defaults in `app_setting` (judgement, not evidence; the owner may change them): `INV_MIN_YEARS=3` (a share of years is shown from 3 years), `INV_SMALL_YEARS=5` (below 5 years the share is flagged small), `INV_MIN_WINDOWS=20`, `INV_MIN_EPISODES=3` (an episode statistic is hidden below 3), `INV_SMALL_EPISODES=10` (flagged small below 10), `INV_SIP_MIN_MONTHS=12`, `INV_VOL_BAND_LOW=20`, `INV_VOL_BAND_HIGH=80`, `INV_DD_TOL=1e-9` (tolerance when comparing a percent to a threshold, so 90/100-1 counts as -10%).
- **Mid-rank percentile.** For a sample `S` of `n` values and a value `x` that is itself one of the values: `pctile(x, S) = 100 * (count(s < x) + 0.5 * count(s == x)) / n` (`count(s == x)` includes `x` itself). Result in [0, 100].
- **Median** of an even count = mean of the two middle values. **Average** = arithmetic mean of the percent returns (simple, not geometric).
- **Every block** also carries `as_of` (date of the last bar used) and `bars` (N) and is stored in `analysis_snapshot.indicators.analysis` (docs/03 section 4a). It is recomputed by `compute_analysis` after a price import; no schedule is needed because the data only changes on import.
- Past behaviour is not a forecast: the UI prints "Past behaviour is not a forecast" on every card of this section (docs/06 6.4a). Selection bias: the owner chose these stocks with hindsight and the history is only what was imported; the UI says so.

### 12.1 Month, year and running-period returns (extends the existing `month_year`)

- **Month** (D-INV, owner clarification 2026-11-11): the calendar month, from the 1st to the last day; how many days it has does not matter. `M(y,m)` = adj close of the last bar of calendar month `(y,m)` (the close of its last trading day). `today` is the IST date of the computation (an argument of the worker functions; no wall clock inside them).
- **Closed month** (INV-5 as amended by D-INV): a month is closed when `today` is after its last calendar day, whether or not a later bar exists. The month of `today` is the **running month**; it is never part of any statistic and is shown as month to date (MTD) only.
- **Complete month** (D-INV): a closed month is *complete* when the imported prices reach its **last expected trading day** `E(y,m)` = the last day of the month that is not a Saturday, a Sunday or a day in the holidays file (`market_holiday`, segment `trading`; the same weekends-plus-holidays rule as the expected-trading-date helper of the API, `instruments.Calendar`; no holiday detection). The month is complete when its last bar is on or after `E(y,m)`. If the month has bars but its last bar is before `E(y,m)`, the month is **incomplete**: its return is `null` with reason `incomplete_month_data`, it is in no statistic and it is no base for the next month. A month with no bar at all is a gap. **Market-closed days derived from the data (D-INV3; replaces the previous sentence of this paragraph, which had no holiday detection):** besides weekends and the holidays file, a weekday is *market-closed* when (1) no tracked instrument (`instrument.is_tracked`, valid non-suspect bars) has a bar on it; (2) at least 3 tracked instruments have bars in the same calendar month, and the period has a day with 3 or more (with fewer than 3 instruments in the period the holidays file alone decides); (3) some later day has bars from tracked instruments (the newest import is never presumed closed: a weekday after the newest market bar is not closed); (4) it is not part of a run of more than 5 consecutive bar-less weekdays (a longer run is a data outage, not exchange closures); and (5) it is on or after the stock's first bar. `E(y,m)` is then the last day of the month that is not a weekend, a holiday-file day or a market-closed day, so a month ending on two consecutive holidays (2018-03) or on a single holiday Monday (2020-11) is complete. If the stock lacks a bar on a weekday on which another tracked instrument has a bar, that day is not closed and the month stays `incomplete_month_data` (a genuine gap, still visible with its reason). The set is computed once per `compute_analysis` run by one aggregate over `price_daily` (one row per trading date since the stock's first bar) and passed to the month logic as a set; the month logic has no clock and no database access. `seasonality.months_excluded_incomplete` and `analysis.months_excluded_incomplete` (additive, optional) count the closed months with bars that are incomplete, over the whole history, so the owner can see how many months are left out of the statistics.
- **Month return** `r(y,m) = (M(y,m)/M(prev month) - 1) * 100` for a closed, complete month whose immediately preceding calendar month has bars and is complete. Otherwise `null` with the first applicable reason: `incomplete_month_data` (this month is closed but incomplete); `no_base` (no bar exists in any earlier month: the first month of the history has no return); `gap_before` (the preceding calendar month has no bar, or has bars but is incomplete, so there is no month-end base; INV-4: the old `month_year` paired non-adjacent months across a gap, B16 fixes this). The running month has no month return, only `mtd`.
- **Month to date** `mtd = (C_last / M(prev month) - 1) * 100`, defined when the last bar lies in the running month and the preceding calendar month is complete with bars; else `null`, reason `no_bar_this_month` (the last bar is in an earlier month), `no_base` or `gap_before`.
- **Green** (INV-7): `r > 0` on the unrounded value. A month of exactly 0 (or a loss) is not green. The cell shows the value to 1 decimal; a value that rounds to 0.0 keeps its true side for counting.
- **Year return** `Y(y)` (the heatmap "Year (price return)" column, INV-1, INV-2): `base = M(y-1, 12)` (the last bar of December of the prior year), `end = M(y, 12)`, `Y = (end/base - 1) * 100`. A year is **closed** when `today.year > y`; the year of `today` is the running year.
  - `kind = "full"` when year `y` is closed and both December closes exist and are complete. If a needed December has no bar (a gap) and `y` is not the first year: `null`, reason `gap_before`; if it has bars but is incomplete: `null`, reason `incomplete_month_data`.
  - `kind = "partial_first"` for the first calendar year of the history only: `base` = the month-end close of the first month with bars (the month that has no return; it must be complete, else `null`, `incomplete_month_data`), `end = M(y,12)`; it covers only the months after the first month. If the first month is December there is no later month in that year: `null`, reason `no_base`. While that first year is the running year it is `ytd` (below) with this base.
  - `kind = "ytd"` only for the running year (`y = today.year`) and only when the last bar is in that year: `end = C_last` (last bar), `base = M(y-1,12)` (or the first-month rule when that year is also the first year), labelled "year to date as of {date}". When the last bar is in an earlier year there is no row for the running year.
  - `months_covered` = number of month steps from the base month to the end month (12 for a full year). Consistency identity (tested): `1 + Y/100 = product over the covered months of (1 + r/100)` (for `ytd` the running month contributes its `mtd`).
- Output rows: `{year, return_pct, return_pct_reason, kind, months_covered, base_date, end_date}` for the displayed years (`HEATMAP_YEARS`, 10 calendar years including the last bar's). The `month_year` cells keep `[year, month, pct|null]`; each null cell has its reason in the sibling `analysis.month_year_reasons` (`[[year, month, reason]]`).

**Golden vector VM1** (hand computed; bars exist on the last trading day of every month shown, `today` = 2024-02-15, weekends only, no holidays). Month-end adjusted closes: 2022-11 = 100.00 (history starts 2022-11-14), 2022-12 = 110.00, 2023-01 = 99.00, 2023-02 = 108.90, 2023-03 = 98.01, 2023-04 = 107.811, 2023-05 to 2023-12 = 107.811 (flat), 2024-01 = 118.5921; last bar 2024-02-15 = 106.73289.
- Month returns: 2022-12: 110/100-1 = +10.00; 2023-01: 99/110-1 = -10.00; 2023-02: 108.9/99-1 = +10.00; 2023-03: 98.01/108.9-1 = -10.00; 2023-04: 107.811/98.01-1 = +10.00; 2023-05..12: 0.00 each; 2024-01: 118.5921/107.811-1 = +10.00; 2022-11: no return (first month, `no_base`); 2024-02 is running: `mtd = 106.73289/118.5921-1 = -10.00`.
- Year rows: 2022 `partial_first`, base 100 (the 2022-11 close), end 110: +10.00, `months_covered` 1. 2023 `full`: 107.811/110-1 = -1.99 (chain check: 0.9 x 1.1 x 0.9 x 1.1 = 0.9801, then eight flat months), `months_covered` 12. 2024 `ytd`: 106.73289/107.811-1 = -1.00 (chain: 1.1 x 0.9 = 0.99), `months_covered` 2, `end_date` 2024-02-15.
- Gap vector VM2: month-end closes 2023-01 = 100, 2023-02 = 110, (no bars in 2023-03), 2023-04 = 121 (bars on each last trading day, `today` 2023-05-10): the 2023-04 return is `null` (`gap_before`), not 121/110-1; 2023-03 has no bar and no cell.
- **Incomplete month vector VM3** (D-INV). Bars on 2022-12-30 (Fri) = 100, 2023-01-27 (Fri) = 105 (the last expected trading day of January 2023 is Tue 2023-01-31; no bar on 01-30 or 01-31), 2023-02-28 (Tue) = 110.25, 2023-03-31 (Fri) = 115; `today` 2023-04-10; no holidays. January is closed but incomplete: `null`, `incomplete_month_data`, in no statistic. February: its base month is incomplete: `null`, `gap_before`. March: 115/110.25-1 = +4.31. December 2022 is the first month: `no_base`. With holidays on both 2023-01-30 and 2023-01-31 in the holidays file the expected last trading day is 01-27 and January is complete (105/100-1 = +5.00); with a holiday on 01-31 only it is 01-30 and January stays incomplete.
- **Calendar closing vector VM4** (D-INV). Bars end on 2024-01-31 (Wed, the last trading day of January 2024) = 110 with the previous month-end (2023-12-29) = 100; `today` 2024-02-01: January is **closed** (today is after 2024-01-31) although no later bar exists: `r = +10.00`, it counts in the statistics of January, and the running month is February with `mtd_reason` `no_bar_this_month`. With `today` 2024-01-31 the same data leaves January running (`mtd` +10.00, in no statistic).

### 12.2 Month-of-year seasonality (the heatmap summary rows, the Home tile, best and worst month)

For each calendar month `m` (1..12) over **all available history** (INV-3), take the returns `r(y,m)` of every **closed, complete** month with a defined return (12.1; incomplete months and the running month are in no statistic):
`n_years` = count; `n_green` = count with `r > 0`; `green_pct = 100 * n_green / n_years`; `avg_pct` = average; `median_pct` = median; `best` = max with its year; `worst` = min with its year (ties: the earlier year). `share_shown = (n_years >= INV_MIN_YEARS)`; below it `green_pct` is `null`, reason `too_few_years` (the other statistics are still returned for the heatmap and the UI marks them as a small sample). `small_sample = (n_years < INV_SMALL_YEARS)`.
- **Best and worst calendar month** (INV-20): among months with `share_shown`, `best_month` = the month with the highest `median_pct`, `worst_month` the lowest (ties: the earlier calendar month). Needs at least 2 such months, else both `null`, reason `too_few_months`.
- **Year column summary** (`years`): the same statistics over the **full** calendar years only (`kind = "full"`; the partial first year and the year to date are excluded) with the same minimum.
- **Running month**: `running = {year, month, mtd_return_pct, mtd_reason, base_date, as_of}` for the calendar month of `today`; `mtd_reason` is `no_bar_this_month`, `no_base` or `gap_before` when no value exists (12.1).
- **Data depth**: `first_bar`, `last_bar` and `years_of_history = (last_bar - first_bar).days / 365.25` (1 decimal). The UI says "history starts at your first imported price", never "since listing" (INV-9).

**Golden vector VS1** (from VM1, as of 2024-02-15). Jan: returns {2023: -10, 2024: +10} -> `n_years` 2, `n_green` 1, `green_pct` null (`too_few_years`; would be 50.0), avg 0.00, median 0.00, best +10.00 (2024), worst -10.00 (2023). Feb: {2023: +10} (2024-02 is running and excluded) -> `n_years` 1. Mar {-10}, Apr {+10}, May to Nov {0.00} each (Nov 2022 has no return: first month) -> `n_years` 1, `n_green` 0. Dec {2022: +10, 2023: 0.00} -> `n_years` 2, `n_green` 1, avg 5.00, median 5.00, best +10.00 (2022), worst 0.00 (2023). `years`: one full year (2023) -> `n` 1, hidden. `running = {2024, 2, -10.00}`.
**Golden vector VS2** (months with enough years). Month A = {2019: +5.0, 2020: -2.0, 2021: +3.0, 2022: 0.0} -> `n_years` 4, `n_green` 2 (5.0 and 3.0; 0.0 is not green), `green_pct` 50.00, avg (5-2+3+0)/4 = 1.50, median (0+3)/2 = 1.50, best +5.0 (2019), worst -2.0 (2020), `small_sample` true. Month B = {+4.0, -1.0, +2.0} -> `n_years` 3, `n_green` 2, `green_pct` 66.67, avg 5/3 = 1.67, median 2.0, best +4.0, worst -1.0, small. Month C = {+2.5, +1.0} -> `n_years` 2, `green_pct` null (`too_few_years`), median 1.75. `best_month` = B (median 2.0), `worst_month` = A (median 1.5); C is not eligible.
**Golden vector VS3** (year column). Full-year returns {2019: +12.0, 2020: -8.0, 2021: +20.0, 2022: +4.0} -> `n` 4, `n_green` 3, `green_pct` 75.00, avg 7.00, median (4+12)/2 = 8.00, best +20.0 (2021), worst -8.0 (2020), small (4 < 5).

### 12.3 Price position

Let `w = 252` (52 weeks). All values are close-based. `high52 = max(C over the last w rows)`, `low52 = min(...)`.
- `range_pos_52w_pct = 100 * (C_last - low52) / (high52 - low52)`; `null`, reason `flat_range`, when `high52 == low52`; needs `N >= w`. `range_band`: `lower` if `< 100/3`, `middle` if `< 200/3`, else `upper` ("lower / middle / upper third of its 52-week range"; where the price sits, not a signal).
- `dist_high_52w_pct = (C_last / high52 - 1) * 100` (<= 0). `dist_high_all_pct = (C_last / max(C, all rows) - 1) * 100`, with `high_all_date` and `history_first_date` (INV-9: "highest close in your imported history", not an all-time high).
- `pctile_52w = pctile(C_last, last w closes)` (needs `N >= w`); `pctile_all = pctile(C_last, all closes)` (needs `N >= 504`, else `insufficient_history`). Reading: the share of days in the window that closed lower; a stock that has trended up for years reads high for structural reasons.
- `ext_sma200_pct = (C_last / SMA200 - 1) * 100` using `technicals.sma200` (needs 200 bars); positive = above its 200-day average.

**Golden vector VP1** (windows are arguments: `w = 5`, SMA window 3, `min_all_rows = 7`; production values 252, 200, 504). Closes `20, 16, 10, 12, 11, 15, 14`. The last 5 are 10, 12, 11, 15, 14: `high52` 15, `low52` 10, `range_pos_52w_pct = (14-10)/(15-10)*100 = 80.0`, band `upper`; `dist_high_52w_pct = (14/15-1)*100 = -6.6667`; `pctile_52w`: below 14 are 10, 12, 11 (3), equal 1 -> `(3 + 0.5)/5*100 = 70.0`; `pctile_all`: 3 below, 1 equal, of 7 -> `3.5/7*100 = 50.0`; `dist_high_all_pct = (14/20-1)*100 = -30.0`; SMA3 = (11+15+14)/3 = 13.3333 -> `ext_sma200_pct = (14/13.3333-1)*100 = 5.0`. Edges: `range_pos` exactly 100/3 -> `middle`; a flat window -> `flat_range`.

### 12.4 Drawdown profile

Over the **full** available history (not only the 750-row chart window). `P_t = max(C_0..C_t)`, `dd_t = (C_t/P_t - 1) * 100` (<= 0). An **episode** starts at the first row with `dd < 0` after a peak and ends at the first later row with `C >= P` (the recovery); the episode peak is that `P`. An episode with no recovery yet is **open**.
- `current_dd_pct = dd_last`; `days_since_high` = calendar days from the date of the current running maximum to `D_last`.
- `max_dd = {depth_pct, peak_date, trough_date, recovery_date, recovered}` for the deepest `dd_t` (ties: the earliest); `recovery_date` is the first later bar with `C >= peak`, or `null` with `recovered=false`.
- `underwater_rows` = rows with `dd < 0`; `time_under_water_pct = 100 * underwater_rows / N`; `avg_underwater_depth_pct` = mean of `dd_t` over underwater rows; `episodes_total` = number of episodes of any depth.
- **Recovery time from a drop of X%** (`X` in {10, 20}; INV-15): among episodes whose depth is `<= -X` (tolerance `INV_DD_TOL`), take the first row where `dd <= -X` (the **crossing**); `recovery_days` = calendar days from the crossing bar to the recovery bar. Report `episodes` (all with depth `<= -X`), `recovered`, `open`, and `median_days` over the recovered ones. `median_days` is `null` (reason `too_few_episodes`) when `recovered < INV_MIN_EPISODES`; `small_sample = recovered < INV_SMALL_EPISODES`. Open episodes are excluded from the median and shown as a count (the median of recovered episodes understates the wait for a stock that never recovers).

**Golden vector VD1** (13 bars on consecutive calendar days 2024-01-01 to 2024-01-13). Closes `100, 90, 80, 85, 100, 95, 100, 110, 99, 88, 99, 110, 105`. Running peak: 100 (rows 0-6), 110 (rows 7-12). `dd`: 0, -10, -20, -15, 0, -5, 0, 0, -10 (99/110), -20 (88/110), -10, 0, -4.5455 (105/110). Underwater rows = 1, 2, 3, 5, 8, 9, 10, 12 = 8 of 13 -> `time_under_water_pct = 61.5385`; `avg_underwater_depth_pct = -(10+20+15+5+10+20+10+4.5455)/8 = -94.5455/8 = -11.8182`; `current_dd_pct = -4.5455`; `days_since_high = 1` (peak 2024-01-12). Episodes: E1 rows 1-3 (peak 100, trough -20 on 01-03, recovered at row 4 = 01-05), E2 row 5 (-5, recovered at row 6), E3 rows 8-10 (peak 110, trough -20 on 01-10, recovered at row 11 = 01-12), E4 row 12 (open) -> `episodes_total` 4. `max_dd`: -20.0 (tie: the earliest), peak 2024-01-01, trough 2024-01-03, recovery 2024-01-05. X = 10: episodes E1 and E3 (E2 and E4 are shallower); E1 crossing at row 1 (01-02) to recovery 01-05 = 3 days; E3 crossing at row 8 (01-09) to 01-12 = 3 days -> `episodes` 2, `recovered` 2, `open` 0, `median_days` 3.0 (with `INV_MIN_EPISODES` lowered to 2 for the vector; at the default 3 the value is `null`, `too_few_episodes`). X = 20: E1 crossing at row 2 (01-03) -> 01-05 = 2 days; E3 crossing at row 9 (01-10) -> 01-12 = 2 days -> `median_days` 2.0. Float edge: `90/100-1` is `-0.0999...98`; it still counts as -10 because of `INV_DD_TOL`.

### 12.5 Holding-period analysis (rolling returns)

For window `w` in {21, 63, 126, 252, 756} (labels 1M, 3M, 6M, 1Y, 3Y): `r_t = (C_t / C_{t-w} - 1) * 100` for every `t >= w`; `windows = N - w`. **Cumulative return over the window, not per year** (the 3Y row is the total over three years). Outputs per window: `windows`, `independent_periods = floor((N-1)/w)`, `share_positive_pct = 100 * count(r > 0)/windows`, `median_pct`, `best_pct` with `best_end_date`, `worst_pct` with `worst_end_date` (ties: the earliest end date). Hidden (`null`, reason `too_few_windows`) when `windows < INV_MIN_WINDOWS`; `insufficient_history` when `N <= w`. **Windows overlap** (consecutive windows share most of their days), so the count overstates the independent evidence; `small_sample = independent_periods < 3` (INV-16). The UI states "windows overlap".

**Golden vector VH1** (`w = 2`, `INV_MIN_WINDOWS` lowered to 4 for the vector). Closes `100, 120, 90, 135, 108, 162` (N = 6). `r`: t=2: 90/100-1 = -10.0; t=3: 135/120-1 = +12.5; t=4: 108/90-1 = +20.0; t=5: 162/135-1 = +20.0. `windows` 4, `share_positive_pct` 75.0, sorted (-10, 12.5, 20, 20) -> `median_pct` (12.5+20)/2 = 16.25, `best_pct` 20.0 at t=4 (the earlier of the two ties), `worst_pct` -10.0 at t=2, `independent_periods = floor(5/2) = 2` -> `small_sample` true.

### 12.6 Entry-point study (conditional history)

Question answered: "in the past, after this stock closed far below its 52-week high, what happened over the next 3 and 6 months?" It describes what happened; it does not say it will happen again.
- `d52_t = (C_t / max(C_{t-251..t}) - 1) * 100`, defined for `t >= 251`.
- **Event** for threshold `X` in {10, 20} and forward horizon `h` in {63, 126} (3M, 6M): a row `t` where `d52_t <= -X` (tolerance `INV_DD_TOL`) **and** `d52_{t-1} > -X` (a fresh crossing; a stock already below the line at its first defined row has no event there), **and** `t >= t_prev + h` where `t_prev` is the previous accepted event of the same `(X, h)` (non-overlapping forward windows; a crossing inside the previous window is skipped, not deferred).
- **Forward return** `f = (C_{t+h}/C_t - 1) * 100`, defined only when `t + h <= N-1`; events without a full window are counted in `pending` and excluded.
- Per `(X, h)`: `episodes` (events with a forward return), `pending`, `median_pct`, `worst_pct`, `best_pct`, `share_positive_pct`, `last_event_date`, plus `all_windows_median_pct` = median of all rolling `h`-row returns of the same stock (12.5), so the reader sees the ordinary outcome next to the conditional one. Hidden (`null`, reason `too_few_episodes`) when `episodes < INV_MIN_EPISODES`; `small_sample = episodes < INV_SMALL_EPISODES` (the UI shows the strong small-sample sentence below 10).
- Production parameters `w52 = 252`, `h` in {63, 126}; the vector uses `w52 = 3`, `h = 2`.

**Golden vector VE1** (`w52 = 3`, `h = 2`, N = 15). Closes `100, 100, 100, 90, 95, 99, 100, 80, 85, 90, 95, 100, 90, 88, 81`. `d52` (rolling 3-close maximum): t2 0, t3 -10 (max 100), t4 -5, t5 0 (max 99), t6 0, t7 -20, t8 -15, t9 0 (max 90), t10 0 (max 95), t11 0, t12 -10, t13 -12, t14 -10 (max 90). X = 10: fresh crossings at t3, t7, t12 (t8 and t13 are already below the line; t14 follows t13 at -12, so it is not fresh); the spacing holds (7 >= 3+2 and 12 >= 7+2). Forward returns: t3 -> 99/90-1 = +10.0; t7 -> 90/80-1 = +12.5; t12 -> 81/90-1 = -10.0. `episodes` 3, `median_pct` 10.0, `best_pct` 12.5, `worst_pct` -10.0, `share_positive_pct` 66.67, `pending` 0, `small_sample` true. `all_windows_median_pct` (13 two-row returns: 0, -10, -5, +10, +5.2632, -19.1919, -15, +12.5, +11.7647, +11.1111, -5.2632, -12, -10; sorted, the 7th) = -5.0. X = 20: one crossing (t7, d52 -20.0) -> `episodes` 1 -> hidden (`too_few_episodes`). Pending: the same series cut after t13 (N = 14): the event at t12 has no t14, so X = 10 gives `episodes` 2, `pending` 1 (hidden, 2 < 3). Suppression: `h = 5` on the full series: the crossing at t7 lies inside the window of the event at t3 (7 < 3+5) and is skipped; events t3 and t12; t3 -> t8: 85/90-1 = -5.5556; t12 + 5 > 14 -> pending: `episodes` 1, `pending` 1.

### 12.7 Volatility regime

`vol21_t` = annualised rolling volatility in percent (the existing definition: sample std of the last 21 daily log returns x sqrt(252) x 100, the same values as `analysis.rolling_vol_21`; INV-13: the owner asked for "30-day"; 21 trading rows is about one calendar month and is the window the app already uses). The sample is **every** `vol21` value of the full history (not only the 750 displayed rows); it needs at least 252 values, else `null`, reason `insufficient_history`. `percentile = pctile(vol21_last, all vol21 values)`. `band`: `lower` if `< INV_VOL_BAND_LOW` (20), `higher` if `>= INV_VOL_BAND_HIGH` (80), else `typical`. Neutral wording on screen: "quieter than usual for this stock / typical / bigger swings than usual for this stock"; "calm" and "stressed" are not used. Consecutive `vol21` values overlap, so the sample size is shown and is not independent evidence.

**Golden vector VV1** (percentile only; the volatility itself is covered by RET-84). Sample `[12, 18, 15, 18, 25, 18]`, current = last = 18: below 18 are 12 and 15 (2), equal 3 (including itself) -> `(2 + 1.5)/6*100 = 58.3333`, band `typical`. Band edges: 19.99 -> `lower`, 20.0 -> `typical`, 79.99 -> `typical`, 80.0 -> `higher`.

### 12.8 SIP versus lump sum (a backtest on the imported history)

A fixed monthly amount invested on a chosen day versus the same total money invested on the first instalment date. **A backtest on past prices of a stock the owner already follows (hindsight and survivorship), not an estimate of the future** (INV-18).
- Fixed amount `A = INR 1,000` per instalment (the percent results do not depend on `A`; the screen says "per INR 1,000 a month"). `day` is `first_trading_day` (default) or a day of month 1-28.
- **Instalments**: for every calendar month from the month of the first bar to the month of the last bar, the execution bar is the first bar on or after the chosen day in that month (`first_trading_day`: the first bar of the month). A month with no such bar (for example the last month when the last bar is before the chosen day) is not executed and counts in `skipped`. `units_k = A / C_exec`. `installments` = executed count; it needs `installments >= INV_SIP_MIN_MONTHS` (12), else all outputs are `null`, reason `history_under_12_months`.
- `invested = A * installments`; `sip_value = (sum of units_k) * C_last`. **Lump**: `lump_units = invested / C_first_exec` at the first execution bar, `lump_value = lump_units * C_last`. `value_ratio = sip_value / lump_value` (above 1 means the instalment plan ended ahead in this history). `sip_absolute_return_pct = (sip_value/invested - 1)*100`, `lump_absolute_return_pct` likewise.
- **XIRR** (section 8.3 method, `t = days/365`): SIP flows `-A` on each execution date and `+sip_value` on `D_last`; lump flows `-invested` on the first execution date and `+lump_value` on `D_last`. Shown only when `span_days = D_last - first execution >= 365` (the MFH-3 rule); else `null`, reason `under_one_year`, and only the absolute returns are shown.
- **Worst unrealised result** (INV-18; replaces "max drawdown of the SIP path", which is not meaningful with ongoing contributions): `sip_worst_unrealised_pct = min over bars t on or after the first execution of (units_held_t * C_t / invested_t - 1) * 100`, where `units_held_t` and `invested_t` count the instalments executed on or before `t`; `lump_worst_unrealised_pct = min_t (C_t / C_first_exec - 1) * 100`.
- The stored block holds the default `first_trading_day` and the 28 fixed days as `variants`, so the day picker needs no new endpoint.

**Golden vector VL1** (`INV_SIP_MIN_MONTHS` lowered to 4; bars only on these dates): 2024-01-01 = 100, 2024-02-01 = 50, 2024-03-01 = 100, 2024-04-01 = 200, 2024-04-30 = 200; `first_trading_day`, `A = 1000`. Units 10, 20, 10, 5 = 45; `invested` 4000; `sip_value = 45 x 200 = 9000`; lump: 40 units x 200 = 8000; `value_ratio = 9000/8000 = 1.125`; `sip_absolute_return_pct = 125.0`; `lump_absolute_return_pct = 100.0`; `span_days` 120 -> XIRR `null` (`under_one_year`). Worst unrealised (SIP): after Jan 1000/1000-1 = 0; Feb 30x50/2000-1 = -25.0; Mar 40x100/3000-1 = +33.33; Apr 45x200/4000-1 = +125 -> `-25.0`; lump: `50/100-1 = -50.0`. XIRR vectors: SIP flows `-1000` on 2024-01-05, 2024-02-05, 2024-03-05 and `+3300` on 2025-03-05 -> 0.09213 (section 8.5.5); lump `-4000` on 2024-01-01 and `+8000` on 2025-01-01 -> `2^(365/366) - 1 = 0.99622` (tolerance 1e-4). Skipped: bars on 2024-01-16, 2024-02-15, 2024-03-15, 2024-04-10 only and `day = 15`: January executes on 01-16, February 02-15, March 03-15; April has no bar on or after the 15th -> `skipped` 1, `installments` 3.

### 12.9 Risk-adjusted return (price history only)

- **Calmar-style** `calmar_3y = cagr_3y_pct / abs(maxdd_3y_window_pct)`, where both use the same calendar 3-year window (base = last bar on or before `end - 3 years`, as in section 4; the maximum drawdown over exactly those rows with their own running maximum). `null` reasons: `insufficient_history` (under 3 years of data), `no_drawdown` (maximum drawdown 0).
- **Downside deviation** over the same window, daily simple returns `r_t` in percent, target 0: `downside_dev_3y_pct = sqrt(mean(min(r_t, 0)^2)) * sqrt(252)` where the mean runs over **all** returns of the window (INV-19). `return_per_downside_3y = cagr_3y_pct / downside_dev_3y_pct` (a Sortino-like ratio with a 0% target; `null` when the deviation is 0).
- **Sharpe is not shown here** (INV-19): it needs a risk-free rate, an owner decision. The existing `returns.risk.sharpe_3y` (which uses `RISK_FREE_RATE`) stays in the data and is not rendered by this feature.

**Golden vector VR1.** Daily returns `+1%, -2%, +3%, -4%`: `min(r,0)^2` = 0, 4, 0, 16; mean 5; `sqrt(5) x sqrt(252) = sqrt(1260) = 35.4965` (tolerance 1e-3). With `cagr_3y_pct = 15.0`: `return_per_downside_3y = 15/35.4965 = 0.4226`. Calmar: CAGR 15.0 and maximum drawdown -30.0 -> 0.5; maximum drawdown 0 -> `null`, `no_drawdown`; 2.5 years of data -> `insufficient_history`.

### 12.10 Entry context (a reading aid, not a score)

A strip on the Analysis tab that places four facts side by side. It has **no data of its own** and **no combined number**: the web composes it from existing blocks, each fact keeping its own source and as-of (INV-21).
1. **Price position**: `range_band` (12.3) -> "trading in the {lower|middle|upper} third of its 52-week range", with `range_pos_52w_pct` and the as-of.
2. **Current drawdown**: `current_dd_pct` (12.4) -> "{x}% below its highest close ({date})", or "at its highest close" when 0.
3. **Volatility**: `band` (12.7) -> "recent price swings are {quieter than usual|typical|bigger than usual} for this stock", with the percentile.
4. **This calendar month**: the seasonality entry of the current IST month (12.2) -> "{Month} closed green in {n_green} of {n_years} years", or the reason.

Fixed order, neutral tokens only (no red or green fill, no arrows implying good or bad), no ranking by "attractiveness", and the sentence "Context, not advice or a signal." A fact that is `null` shows an em dash with its reason; the others still show.

### 12.11 Deferred or not computed

- **Relative strength versus Nifty 50** (INV-22): deferred. The index series is only an optional owner import used by beta (docs/OPEN_QUESTIONS F06-3: no endpoint serves it), so the card would be empty for most stocks.
- Sharpe ratio: not shown (INV-19). A tile for tracked stocks beyond the watchlist: deferred (INV-9). A chosen SIP amount: deferred, results are scale-free (INV-18).

### 12.12 Owner-facing wording (read by `apps/web/scripts/gen-definitions.mjs`; F17 adds the entries and regenerates `definitions.ts`)

The lines below start with the marker the generator reads. They contain no ids and do not change any maths.

- **Owner text (year_price_return):** How much the price changed over the calendar year, from the last close of December of the year before to the last close of December. The first year shows only the months we have data for, and the running year is year to date. It is the price change only: dividends you received are not included.
- **Owner text (month_green_share):** In how many of the past years this calendar month ended higher than the month before. A month that ended exactly flat does not count as higher. The month that is still running is not counted.
- **Owner text (price_position):** Where today's closing price sits between the lowest and the highest close of the last 52 weeks. It describes the past year only. A low or high position does not mean the price will rise or fall.
- **Owner text (drawdown_profile):** How far the price has fallen from its highest earlier close, how long it stayed below that high, and how long past falls of 10% or 20% took to be won back. These are the stock's own past episodes, and only a few of them.
- **Owner text (holding_period):** What would have happened if you had bought on any past day and sold exactly 1, 3, 6 or 12 months or 3 years later. The windows overlap, so they are far fewer independent experiences than the count suggests.
- **Owner text (entry_study):** After the price first closed at least 10% or 20% below its 52-week high, what it did over the next 3 and 6 months. Each past episode counts once. With only a few episodes this is an anecdote, not a pattern.
- **Owner text (vol_regime):** How big the recent day-to-day price swings are compared with this stock's own history. It says nothing about direction.
- **Owner text (sip_vs_lump):** A look back: putting the same fixed amount in every month compared with putting all of the money in on the first day, using this stock's imported prices. It is a replay of the past with hindsight, not an estimate of what will happen.
- **Owner text (calmar):** Yearly price growth over the last 3 years divided by the deepest fall in that period. Higher means more growth for each unit of pain. It ignores dividends.
- **Owner text (downside_risk):** Yearly price growth divided by how large the falling days were, counting only days when the price fell. It ignores dividends and has no risk-free rate.
