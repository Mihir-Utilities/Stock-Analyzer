# 05. Analytics, Portfolio, Mutual Fund and ML Specification (Safe Edition)

Every formula here must have a unit test with a hand-computed or reference-library expected value (tolerance stated). Where a number is a design choice (weights, thresholds), it lives in `app_setting` so it can change without code changes, and its default is listed here. Design choices are not evidence-based facts; they are documented judgements.

---

## 1. Conventions

- Prices for returns/indicators: `adj_close` (series A). **Price returns only**: dividends are not adjusted in the Safe Edition; the UI says "price return (excludes dividends)". High/low/open scaled by `k = adj_close/close` per row when "adjusted" is needed. Suspect rows excluded before anything else; gaps are never forward-filled.
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
- **ROCE** = `ebit / average(capital_employed_t, _{t-1}) * 100`, `capital_employed = total_assets - current_liabilities`.
- `debt_equity = borrowings / equity` (latest annual); equity <= 0 -> null. `interest_coverage = ebit / interest` (interest 0 or missing -> null reason `no_interest`).
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
Adjustment rule: for every lot with `trade_date < ex_date <= as_of`, `qty *= multiplier` and `unit_cost /= multiplier` (total cost unchanged). Lots bought on/after ex_date are in post-action units already. A sell on date d validates against holdings computed with confirmed actions having `ex_date <= d`. Owner overrides in `portfolio_adjustment` take precedence for the same `(instrument, ex_date)`. History adjustment (`adj_close`): for each trading date t before ex_date, `adj_close_t = close_t * product(1/multiplier for confirmed actions with ex_date > t)` when `BROKER_PRICES_ADJUSTED=false`.

### 8.3 XIRR
Cash flows: buy `-(qty*price + fees)` at trade_date; sell `+(qty*price - fees)`; plus a terminal inflow of current market value (`sum(qty*LTP)` using latest price as of `as_of`) dated `as_of` (only for open holdings). `t_i = (date_i - date_0)/365`. Solve `sum(cf_i/(1+r)^t_i) = 0`. Method: bracket on `r in [-0.9999, 100]` and use Brent's method (bisection fallback), tolerance 1e-7, max 200 iterations. Return null if no sign change or fewer than one outflow and one inflow. If total span < 30 days, display absolute return only and mark XIRR `n/a (period too short)`. Test vector: flows `-1000` on 2020-01-01 and `+1100` on 2021-01-01 -> r = 0.09973 (leap-year day count: 366/365; tolerance 1e-4).

### 8.4 Other portfolio outputs
- Day change = `sum(qty * (LTP - prev_close))` for holdings.
- Allocation by stock and by sector (market value share).
- Estimated dividends received: for each owner-entered dividend action with ex_date inside the holding period: `qty_held_at_record_date * amount_per_share`; shown separately as "estimated, not included in XIRR/P&L".
- Benchmark comparison: invest the same cash flows into Nifty 50 (`NIFTY50` series from the broker, price index, excludes dividends) and report its XIRR; omitted with a note if the index series is unavailable.
- Brokerage, STT, taxes beyond the `fees` the user enters are not modelled.

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
Live gate: after >= 100 resolved live predictions for a horizon, if live AUC < 0.50 or live band coverage outside [0.70, 0.90], set `guardrail_pass = false` for that horizon until a newer model run passes again and live metrics recover.

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
