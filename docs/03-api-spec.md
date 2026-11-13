# 03. API Specification (Safe Edition; Go API, base path `/api/v1`)

Claude Code must generate `openapi.yaml` from this file first, then implement handlers, then generate TypeScript types for the frontend.

---

## 1. Conventions

- JSON UTF-8. Dates `YYYY-MM-DD` (market date, IST). Timestamps RFC 3339 UTC.
- Numbers: prices as JSON numbers (double). Money in the portfolio API as **strings** with 4 decimals (e.g. `"1234.5000"`) to avoid float drift; the frontend parses with a decimal library for sums.
- Unavailable value: `null` plus a sibling `*_reason` or the response-level `warnings[]`. Never `0` for unknown.
- Success envelope:
```json
{ "data": { }, "meta": { "as_of": "2026-10-09T13:05:00Z", "source": "broker", "stale": false, "stale_age_hours": 0 }, "warnings": [ { "code": "UNCONFIRMED_ACTION", "message": "Possible split on 2026-09-12 not yet confirmed" } ] }
```
`meta.stale` is true when data age exceeds the freshness limit for its type (prices: > 1 trading day after expected EOD time; fundamentals: > 120 days since last successful fetch; shareholding: > 135 days since last quarter end; MF NAV: > 4 calendar days, see section 10 and B10-3; this replaces the earlier "2 business days" wording, owner to confirm in `OPEN_QUESTIONS.md` R-B10-3).
- Error envelope (HTTP status matches):
```json
{ "error": { "code": "NOT_FOUND", "message": "Instrument not found", "details": { "symbol": "XYZ" } } }
```
Codes: `BAD_REQUEST` 400, `UNAUTHENTICATED` 401, `FORBIDDEN` 403, `NOT_FOUND` 404, `CONFLICT` 409, `UNPROCESSABLE` 422 (validation, with `details.fields[]`), `RATE_LIMITED` 429 (with `Retry-After`), `DATA_UNAVAILABLE` 404 (valid target, no data yet; details: `reason`), `SOURCE_DOWN` 503, `INTERNAL` 500. No other code is used: task-specific 422/404 cases reuse `UNPROCESSABLE` / `DATA_UNAVAILABLE` and say why in `details.reason` (for example `no_nav_yet`, `no_common_dates`, `no_prices_imported`). Text inputs (`q`, `category`, `fund_house`, `sector`, `index`, cursors) containing a NUL byte or invalid UTF-8 are `422` with `details.fields`; a path symbol containing either is `404 NOT_FOUND`. A wrong method (405) and an oversized body (413) use `BAD_REQUEST`; routes not yet built return 501 `NOT_IMPLEMENTED`.
- Auth: cookie `session` (httpOnly, Secure, SameSite=Lax, path `/`). All routes need it except `GET /healthz`, `POST /auth/login`, `POST /telegram/webhook`, `GET /broker/callback` (state-verified, section 14a).
- CSRF: all non-GET requests must include header `X-Requested-With: fetch` (browsers cannot add it cross-site without CORS preflight; we send no CORS headers).
- Pagination: cursor-based `?limit=&cursor=`; `limit` default 50, max 200 (larger values are clamped to 200; non-integer or < 1 is a 422); response `{"items":[...],"next_cursor":null|string}`.
- Symbol path parameter: URL-encoded exact exchange symbol (`M%26M`, `BAJAJ-AUTO`); matching is case-insensitive; resolved through `instrument.symbol` then `symbol_alias.old_symbol` (alias -> 301-style response `{"redirect_symbol": "NEW"}` with HTTP 200 and `data.redirect_symbol`).
- Validation failures return 422 with `details.fields: [{"field":"qty","message":"must be > 0"}]`.
- Idempotency: `POST /portfolio/txns`, `POST /portfolio/mf/txns` and `POST /stocks/{symbol}/journal` accept optional header `Idempotency-Key` (UUID) stored 24 h.

## 2. Auth

| Method/Path | Body | Behavior |
|---|---|---|
| POST `/auth/login` | `{"password":"..."}` (1..200 chars) | Verify argon2id. On success create session (random 32 bytes, store sha256), set cookie, expiry now+`SESSION_DAYS`. On failure increment `app_user.failed_logins`; after `LOGIN_MAX_FAILS` set `locked_until = now + 15 min * 2^(lockouts)` (cap 24 h); respond `401 UNAUTHENTICATED` with identical message whether locked or wrong ("Invalid credentials or temporarily locked"); add 300-800 ms random delay. Reset counter on success |
| POST `/auth/logout` | none | Revoke current session, clear cookie |
| POST `/auth/logout-all` | none | Revoke all sessions |
| GET `/auth/me` | | `{ "authenticated": true, "telegram_linked": bool, "prefs": {...} }`; 401 if no session |
| POST `/auth/change-password` | `{"current":"","new":""}` | New: min 12 chars, must differ from current; revokes other sessions |

Session sliding: update `last_seen_at` and extend `expires_at` at most once per hour; when the expiry is extended the response re-sets the `session` cookie (same token, new `Expires`/`Max-Age`) so the browser keeps it as long as the row.

Client address (rate-limit key, session IP): `TRUSTED_PROXY_HOPS` (default 0). At 0, `X-Forwarded-For` is ignored and the socket address is used; at N the Nth entry from the right is used (shorter header or non-IP falls back to the socket address). Wrong `current` passwords on change-password are throttled per session and per IP (5 failures -> 429 `RATE_LIMITED` with `Retry-After`, block 5 min doubling to 1 h; blocked requests are not verified); they never count toward the login lockout.

Implementation notes (B02):
- Success body: `{"data":{"authenticated":true,"expires_at":"<RFC 3339>"}}`; logout and logout-all answer `{"data":{"ok":true}}` and clear the cookie; change-password answers `{"data":{"ok":true}}`. `prefs` in `/auth/me` is `app_user.display_prefs`.
- Lockout: every `LOGIN_MAX_FAILS`-th consecutive failure (`failed_logins` is not reset by a lockout, only by a success) starts lock number `failed_logins / LOGIN_MAX_FAILS`, lasting 15 min x 2^(n-1), capped at 24 h. Attempts made while locked are refused with the same 401 and do not count. The 300-800 ms delay applies to every failed attempt, locked or not; the body never says which.
- Login body: `password` must be 1..200 characters (else 422); malformed JSON or unknown fields are 400.
- Change password: `new` is 12..200 characters (the upper bound equals the login limit so the password can always be used) and must differ from `current`; a wrong `current` is a 422 on field `current` and does not count as a failed login. Policy errors are 422 with `details.fields[]`.
- CSRF: a non-GET request without `X-Requested-With: fetch` is `403 FORBIDDEN`, checked before authentication and rate limiting. `POST /telegram/webhook` is exempt (secret header, B12).
- Redirects: the login page may pass `next`; the server never redirects. The frontend uses the same-origin helper `auth.SafeNext` rules (relative path starting with a single `/`, no backslash, no control characters), otherwise `/`.

## 3. Stocks: search and profile

### GET `/stocks/index`
Compact list for client-side search. Cacheable (`ETag`, `Cache-Control: private, max-age=3600`).
```json
{ "data": { "generated_at": "...", "count": 2231, "items": [ [id, "TCS", "Tata Consultancy Services Ltd", flags] ] } }
```
`flags` bitmask: 1 `broker_ok`, 2 `tracked`, 4 `suspended`, 8 `delisted`, 16 `non_equity` (etf/reit/invit/sme), 32 `financial`, 64 `in_nifty50`, 128 `in_nifty100` (index flags only if the owner imported `index_tags`). Excludes nothing; the UI filters by flags.

### GET `/stocks?q=&index=&sector=&kind=&status=&limit=&cursor=`
Server search (fallback when index not cached): `q` min 1 char; ranking: exact symbol match, symbol prefix, name prefix, trigram similarity on name (threshold 0.3). `kind` default `equity`; `status` default `active`.

### GET `/stocks/{symbol}`
```json
{ "data": {
  "id": 123, "symbol": "TCS", "name": "...", "isin": "...", "series": "EQ", "sector": "...", "industry": "...",
  "company_type": "general", "status": "active", "instrument_kind": "equity", "listing_date": "2004-08-25",
  "broker_ok": true, "tracked": true, "price_mode": "broker|manual",
  "quote": { "ltp": 0, "prev_close": 0, "change": 0, "change_pct": 0, "day_high": 0, "day_low": 0, "wk52_high": 0, "wk52_low": 0, "volume": 0, "market_cap_cr": 0, "quote_ts": "...", "source": "broker" },
  "freshness": { "prices_stale": false, "holidays_missing": false, "prices_as_of": "2026-10-09", "fundamentals_as_of": "2026-08-20", "shareholding_as_of": "2026-06-30", "predictions_as_of": "2026-10-09" },
  "flags": { "no_prices": false, "limited_history": false, "series_warning": null }
} }
```
Side effect: sets `last_opened_at = now()`; if the stock is not tracked, sets `is_tracked=true, tracked_reason='opened'` (the API owns the tracked set; there is no `sync_instruments`). In **manual price mode** (current) there is no backfill and the response carries `"price_mode": "manual"`, `freshness.prices_as_of` (last imported bar) and, when `no_prices`, a hint "Import prices.csv for {symbol}". In broker mode (inactive, D-1): if `no_prices` and the broker session is active and `broker_ok != false`, the response includes `"backfill": { "status": "queued|running|none", "job_id": 5 }` and the API enqueues a `stock_backfill` job (section 7).
`freshness.prices_stale`: with holiday data for the year, true when the last bar is older than the expected last trading date; **without** holiday data (`holidays_missing=true`) true only after 4 calendar days without a new bar.
When no instruments exist, `GET /stocks` and `/stocks/index` return an empty list (`count: 0`); the UI shows "No stocks yet. Import instruments.csv or add a stock."

Implementation notes (B03):
- `/stocks/index` items are `[id, symbol, name, flags]`, ordered by symbol. `ETag` is a hash of the items only (stable while the list is unchanged); `If-None-Match` gives `304` with no body. `in_nifty100` is set for members of `NIFTY50`, `NEXT50` or `NIFTY100` (index names compared without spaces and case). Bit 1 (`broker_ok`) is always 0.
- `/stocks` items: `{id, symbol, name, isin, series, sector, industry, company_type, status, instrument_kind, tracked}`. `q` absent lists alphabetically; `q` present must be 1-100 characters after trimming (else 422). `kind` is one of equity, etf, reit, invit, sme, other; `status` one of active, suspended, delisted, symbol_changed; `sector` is an exact case-insensitive match; `index` matches an `index_constituent.index_name` without spaces and case. Order: rank (0 exact symbol, 1 symbol prefix, 2 name prefix, 3 trigram similarity on name >= 0.3), then similarity descending (rank 3), then symbol. The cursor is opaque; an invalid cursor is 422 on `cursor`.
- `/stocks/{symbol}`: the path segment is percent-decoded exactly once (`M%26M` is `M&M`, `A%2541` is the literal symbol `A%41`; this holds for every `/stocks/{symbol}/...` route). `/stocks/index` bit 128 (`in_nifty100`) also matches the owner tag `NEXT50` (and `NIFTYNEXT50`). Profile `no_prices`, `prices_as_of` and `limited_history` count valid (non-suspect) bars only, the rows `/prices` serves (BRK-08). In manual price mode `broker_ok` is `null`, `quote` is `null` unless a `quote_latest` row exists, there is no `backfill` block and no job is ever enqueued. `data.hint` ("Import prices.csv for {symbol}") appears only with `no_prices`. An alias answers `{"redirect_symbol":"NEW"}` and has no side effects. `meta`: `as_of` = the last bar date (now when there are no bars), `source` `import`, `stale` = `freshness.prices_stale`, `stale_age_hours` = the lag behind the expected last trading date in hours (0 when fresh).
- Expected last trading date: today (IST) if it is a trading day and the clock is past 18:00 IST (a bar is final only after 18:00 IST, docs/01 section 6.1), else the previous trading day; weekends and `market_holiday` rows (segment `trading`) are skipped. `holidays_missing` is true when `market_holiday` has no row for the current IST year; then `prices_stale` is true only when the last bar is more than 4 calendar days old.
- `fundamentals_as_of` = IST date of `fundamental_meta.last_success`; `shareholding_as_of` = latest `quarter_end`; `predictions_as_of` = latest shown prediction `as_of`; each is `null` when absent.
- `flags.limited_history` is true when the first imported bar is more than 7 days after max(today minus `PRICE_HISTORY_YEARS_TRACKED` years, listing date). `flags.series_warning` is the series code (for example `BE`) when the series is not `EQ`, else `null`; the UI owns the wording.

## 4. Prices and indicators

### GET `/stocks/{symbol}/prices?range=1M|3M|6M|1Y|3Y|5Y|MAX&adjusted=true|false&downsample=auto`
- `range` default 1Y. Max points returned 2,000: if more, server applies LTTB downsampling on `close` (keeping OHLC of the chosen bucket candle aggregation: weekly candles when > 2,000 daily points). `meta.interval` tells `1d` or `1w`.
- Response: `{ "bars": [[date, open, high, low, close, volume], ...], "adjusted": true, "actions": [{"date":"2024-06-12","type":"split","label":"1:2 split"}] }`. Suspect rows excluded.
- `adjusted=true` returns `adj_close` as close and scales open/high/low by the same factor (`adj_close/close`).
- Empty -> `DATA_UNAVAILABLE` with `reason: "backfill_pending"|"broker_unavailable|broker_session_missing"|"no_history"|"no_prices_imported"` (manual mode: `no_prices_imported`).

Implementation notes (B04):
- Prices: `range` counts calendar months back from the last valid bar; `downsample` accepts only `auto`. Over 2,000 daily points the server returns ISO-week candles (dated with the week's last trading day, `meta.interval` = `1w`) and applies LTTB only if weekly candles still exceed 2,000. Prices are rounded to 4 decimals. `data` also carries `range`, `limited_history` and `depth{first_bar,last_bar,bars}`. `actions[]` holds confirmed split/bonus markers (`label` = `ratio_num:ratio_den type`); detected ones only raise `UNCONFIRMED_ACTION`. Empty: 404 `DATA_UNAVAILABLE` reason `no_prices_imported`.
- Indicators: the stored columnar series (D05a-A6) are expanded to `[[date, value]]` pairs; the arrays of `analysis` aligned to the series dates (drawdown, rolling_vol_21/63, rolling_beta_252) too. No snapshot: reason `no_prices_imported`, or `no_history` when bars exist (fewer than 60 valid bars or not yet computed). See OPEN_QUESTIONS B04-1..B04-8.

### DELETE `/stocks/{symbol}/prices?from=YYYY-MM-DD&to=YYYY-MM-DD`
Owner-initiated delete of imported prices for one stock between two dates (inclusive); both required, `from <= to`. Body `{ "confirm": true }` required (the UI shows a ConfirmDialog with the row count from `POST /stocks/{symbol}/prices/delete-preview?from=&to=`, which returns `{ "rows": 120 }`). Writes an audit row (`import_batch` with `kind='manual_form'`, note "deleted prices {symbol} {from}..{to}, {n} rows") and enqueues `post_import` target `batch:<id>` to recompute analytics (and detection) for that symbol. Returns `{ "deleted": 120, "job_id": 14, "batch_id": 31 }` (`job_id` and `batch_id` are null and no audit row is written when no row was in range). The symbol must be the stock's current symbol (an old alias is 404). Shown on the stock's Data tab.

### POST `/prices/trim`
Owner-initiated "Trim history": body `{ "symbols": ["TCS","INFY"], "before": "2021-01-01", "confirm": true }`; deletes `price_daily` rows older than `before` for the chosen stocks (preview via `POST /prices/trim/preview` returning row counts per symbol and estimated MB freed). Audit row and `post_import` as above. Housekeeping never does this automatically (04 3.10). Preview returns `{ "per_symbol": [{"symbol":"TCS","rows":120}], "total_rows": 120, "estimated_mb_freed": 0.01 }` (rows x ~130 B); the trim returns `{ "deleted": 120, "per_symbol": [...], "batch_id": 32, "job_id": 15 }` (nulls when nothing was deleted). `symbols` holds 1-500 current symbols; an unknown symbol is a 422 on `symbols`.

### GET `/stocks/{symbol}/indicators`
Returns the latest `analysis_snapshot` (see `05-analytics-spec.md`): `{ "as_of": "...", "returns": {...}, "technicals": {...}, "scores": { "trend": {...}, "risk": {...}, "quality": {...} }, "series": { "sma50": [[d,v]...], "sma200":..., "rsi14":..., "macd": {...}, "bollinger": {...} } }`. `series` limited to the last 750 trading days. If the series requested exceeds data, arrays contain nulls at warm-up positions (never fabricated).

### 4a. Investment-context blocks of `analysis` (decision INV, PROPOSED; built by B16; formulas in `05` section 12)

There is **no new route**. The request named `GET /stocks/{symbol}/analysis`; no such route exists (the analysis arrays are served by `GET /stocks/{symbol}/indicators`, `data.analysis`), so the blocks below are added to that response (INV-11). All are optional (older snapshots lack them; the web treats a missing block as "not computed yet", never as zero). Conventions: percent fields are percent numbers (12.34 = 12.34%) including `*_pct` shares of years, windows and percentiles (0-100); ratios are plain numbers; a null scalar has a sibling `<name>_reason` from the enum in `05` 12.0; every block has `as_of` (date of the last bar used) and `bars`; sample sizes (`n_years`, `windows`, `episodes`) and `small_sample` travel with the numbers; dates are `YYYY-MM-DD` (IST). `meta.source` of the endpoint stays "owner-imported prices" and `price_basis` "adj_close (price return, excludes dividends)".

```json
"analysis": {
  "...existing arrays unchanged (drawdown, rolling_vol_21/63, rolling_beta_252, return_histogram, calendar)": "",
  "month_year": [[2023, 1, -10.0], [2023, 2, null], [2024, 2, -10.0]],
  "month_year_reasons": [[2023, 2, "incomplete_month_data"]],
  "year_returns": [
    { "year": 2022, "return_pct": 10.0, "return_pct_reason": null, "kind": "partial_first", "months_covered": 1, "base_date": "2022-11-30", "end_date": "2022-12-30" },
    { "year": 2023, "return_pct": -1.99, "return_pct_reason": null, "kind": "full", "months_covered": 12, "base_date": "2022-12-30", "end_date": "2023-12-29" },
    { "year": 2024, "return_pct": -1.0, "return_pct_reason": null, "kind": "ytd", "months_covered": 2, "base_date": "2023-12-29", "end_date": "2024-02-15" }
  ],
  "seasonality": {
    "as_of": "2024-02-15", "bars": 330, "first_bar": "2022-11-14", "last_bar": "2024-02-15", "years_of_history": 1.3,
    "min_years": 3, "small_sample_years": 5,
    "running": { "year": 2024, "month": 2, "mtd_return_pct": -10.0, "mtd_reason": null, "base_date": "2024-01-31", "as_of": "2024-02-15" },
    "months": [
      { "month": 12, "n_years": 4, "n_green": 2, "green_pct": 50.0, "green_pct_reason": null, "avg_pct": 1.5, "median_pct": 1.5,
        "best": { "pct": 5.0, "year": 2019 }, "worst": { "pct": -2.0, "year": 2020 }, "small_sample": true }
    ],
    "best_month": { "month": 3, "median_pct": 2.0, "n_years": 3 }, "worst_month": { "month": 12, "median_pct": 1.5, "n_years": 4 },
    "best_worst_reason": null,
    "years": { "n": 4, "n_green": 3, "green_pct": 75.0, "green_pct_reason": null, "avg_pct": 7.0, "median_pct": 8.0,
               "best": { "pct": 20.0, "year": 2021 }, "worst": { "pct": -8.0, "year": 2020 }, "small_sample": true }
  },
  "position": {
    "as_of": "...", "bars": 0, "close": 0, "high_52w_close": 0, "low_52w_close": 0,
    "range_pos_52w_pct": 80.0, "range_pos_52w_reason": null, "range_band": "upper",
    "dist_high_52w_pct": -6.67, "dist_high_all_pct": -30.0, "high_all_date": "...", "history_first_date": "...",
    "pctile_52w": 70.0, "pctile_52w_reason": null, "pctile_all": 50.0, "pctile_all_reason": null, "pctile_all_n": 7,
    "sma200": 0, "ext_sma200_pct": 5.0, "ext_sma200_reason": null
  },
  "drawdown_profile": {
    "as_of": "...", "bars": 13, "first_date": "...", "current_dd_pct": -4.55, "days_since_high": 1,
    "max_dd": { "depth_pct": -20.0, "peak_date": "...", "trough_date": "...", "recovery_date": "...", "recovered": true },
    "underwater_rows": 8, "time_under_water_pct": 61.54, "avg_underwater_depth_pct": -11.82, "episodes_total": 4,
    "recovery": [ { "threshold_pct": 10, "episodes": 2, "recovered": 2, "open": 0, "median_days": 3.0, "median_days_reason": null, "small_sample": true } ]
  },
  "holding_periods": {
    "as_of": "...", "bars": 0,
    "windows": [ { "key": "3m", "rows": 63, "windows": 0, "independent_periods": 0, "share_positive_pct": 0, "median_pct": 0,
                   "best_pct": 0, "best_end_date": "...", "worst_pct": 0, "worst_end_date": "...", "reason": null, "small_sample": false } ]
  },
  "entry_study": {
    "as_of": "...", "bars": 0, "w52_rows": 252,
    "rows": [ { "drawdown_pct": 10, "horizon": "3m", "horizon_rows": 63, "episodes": 3, "pending": 0, "median_pct": 10.0, "worst_pct": -10.0, "best_pct": 12.5,
                "share_positive_pct": 66.67, "all_windows_median_pct": -5.0, "last_event_date": "...", "reason": null, "small_sample": true } ]
  },
  "vol_regime": { "as_of": "...", "window_rows": 21, "current_vol_pct": 0, "percentile": 58.33, "sample": 0, "band": "typical", "reason": null, "first_date": "..." },
  "sip_backtest": {
    "as_of": "...", "amount_per_month_inr": 1000, "price_basis": "adj_close",
    "variants": [ { "day": null, "installments": 0, "skipped": 0, "first_date": "...", "last_date": "...", "span_days": 0,
                    "invested_inr": 0, "sip_value_inr": 0, "lump_value_inr": 0, "value_ratio": 1.125,
                    "sip_absolute_return_pct": 125.0, "lump_absolute_return_pct": 100.0,
                    "sip_xirr_pct": null, "lump_xirr_pct": null, "xirr_reason": "under_one_year",
                    "sip_worst_unrealised_pct": -25.0, "lump_worst_unrealised_pct": -50.0, "reason": null } ]
  },
  "risk_adjusted": {
    "as_of": "...", "window": "3y", "cagr_3y_pct": 15.0, "maxdd_3y_window_pct": -30.0, "calmar_3y": 0.5, "calmar_3y_reason": null,
    "downside_dev_3y_pct": 35.5, "return_per_downside_3y": 0.4226, "downside_reason": null
  }
}
```

Rules.
- `month_year` keeps its shape `[year, month, pct|null]` (last 10 calendar years, `HEATMAP_YEARS`); changes: a month whose previous calendar month has no bar is `null` (not paired across the gap, INV-4); a closed month whose imported prices do not reach its last expected trading day is `null` too (`incomplete_month_data`, D-INV), and every null cell has its reason in `month_year_reasons` (`[year, month, reason]`: `no_base`, `gap_before`, `incomplete_month_data`); a month is closed when today's IST date is after its last calendar day (not when a later bar exists), the running calendar month's cell is the month-to-date value and is identified by `seasonality.running` (the web marks it; it is excluded from every statistic).
- `year_returns` rows are for the same displayed years, ascending; `kind` is `full | partial_first | ytd`.
- `seasonality.months` always has 12 entries (`month` 1..12); `seasonality` and `years` statistics use **all** available history, not only the displayed 10 years (INV-3), and `years` is the year-column summary over full years. A month with no data has `n_years` 0 and null statistics with `green_pct_reason: "too_few_years"`. `seasonality.months_excluded_incomplete` and `analysis.months_excluded_incomplete` (additive, optional integers; D-INV3) are the number of closed months of the whole history that have bars but are incomplete (`incomplete_month_data`) and therefore in no statistic; weekdays on which no tracked instrument traded count as holidays when deciding completeness (docs/05 12.1).
- `sip_backtest.variants` has 29 entries: `day: null` (first trading day) and `day: 1..28`; `reason` `history_under_12_months` nulls every figure of a variant. INR figures are hypothetical, 2 decimals, JSON numbers. To keep the stored size under budget a variant omits `reason` and `xirr_reason` when they are null (absent means null), its percent fields have 2 decimals (`value_ratio` 4) and XIRR is a percent number with 2 decimals (error below 1e-4 as a fraction).
- `position`: when fewer than 252 rows exist `high_52w_close`, `low_52w_close`, `range_pos_52w_pct`, `range_band` and `dist_high_52w_pct` are all null and `range_pos_52w_reason` (`insufficient_history`) explains them; `flat_range` nulls only `range_pos_52w_pct` and `range_band`. `max_dd` carries `reason` (`no_drawdown` with `depth_pct` 0, null dates and `recovered` null) and `drawdown_profile` carries `avg_underwater_depth_reason` (`no_drawdown`). `vol_regime`, `sip_backtest` and `risk_adjusted` carry `bars` like the other blocks. The statistics of a block are rounded to 4 decimals (percent numbers), not to the 2 decimals of the examples.
- `holding_periods.windows[*].key` is `1m|3m|6m|1y|3y`; `entry_study.rows` has the 4 combinations `drawdown_pct` 10/20 x `horizon` `3m`/`6m`; `drawdown_profile.recovery` has the thresholds 10 and 20.
- All new blocks together add roughly 12 KB to the stored snapshot (the 29 SIP variants dominate); the snapshot stays under the 250 KB budget (RET-89, raised from 200 KB by SWD-9; the swing dips block adds about 5 KB, the new blocks together under 25 KB). The expansion step of B04 (`prices/expand.go`) passes the new blocks through unchanged (they carry their own dates; nothing is aligned to `series.dates`).
- Errors and `DATA_UNAVAILABLE` reasons are those of `/indicators` above. No endpoint takes a parameter for these blocks.

### 4a.RST. `data.analysis.relative_strength` (decision RST, PROPOSED; built by B21; formulas in `05` section 12.14)

Additive and optional like the other 4a blocks (an older snapshot lacks it; the web shows "Not computed yet", never zero). **No new route, no new query parameter**; it is part of `GET /stocks/{symbol}/indicators` `data.analysis`. Percent fields are percent numbers; `excess_pp` and `vs_median_pp` are percentage points; `percentile` is 0-100; dates are `YYYY-MM-DD`. Each half is an object or `null` with its sibling reason (`vs_index_reason`: `no_index_series | compute_error`; `vs_peers_reason`: `no_sector | compute_error`). A null number inside an object has the row's `reason` (`insufficient_history | insufficient_overlap | too_few_windows | too_few_peers`).

```json
"relative_strength": {
  "as_of": "2024-02-15", "bars": 330,
  "basis": "price return (adj_close), excludes dividends",
  "vs_index": {
    "index_code": "NIFTY50", "index_as_of": "2024-02-15", "index_rows": 2465,
    "aligned_rows": 328, "first_aligned": "2022-11-14", "last_aligned": "2024-02-15",
    "dropped_stock_dates": 2, "dropped_index_dates": 3,
    "windows": [ { "key": "1m", "rows": 21, "stock_pct": -3.1, "index_pct": 0.9, "excess_pp": -4.0, "reason": null } ],
    "years": [ { "year": 2023, "kind": "full", "base_date": "2022-12-30", "end_date": "2023-12-29", "stock_pct": 12.0, "index_pct": 19.4, "excess_pp": -7.4 } ],
    "rolling_year": { "windows": 76, "independent_periods": 1, "share_beat_pct": 61.84, "median_excess_pp": 3.2, "small_sample": true, "reason": null },
    "ratio_rebased": [100.0, 100.4, null, 99.1], "ratio_base_date": "2022-11-14", "ratio_reason": null
  },
  "vs_index_reason": null,
  "vs_peers": {
    "sector": "Banks", "as_of": "2024-02-15", "peers_in_sector": 6, "excluded": 1,
    "windows": [ { "key": "3m", "rows": 63, "stock_pct": 4.2, "n_peers": 5, "n_total": 6, "rank": 2, "percentile": 75.0,
                   "peer_median_pct": 1.9, "vs_median_pp": 2.3, "small_sample": false, "reason": null } ]
  },
  "vs_peers_reason": null
}
```
Rules.
- `windows` of `vs_index` has the four rows `1m|3m|6m|1y` (rows 21, 63, 126, 252); `windows` of `vs_peers` has `3m|6m|1y` (rows 63, 126, 252). `years` has at most 10 rows ascending (`kind` `full | ytd`).
- `ratio_rebased` has the length of the stored `series.dates` (the last 750 rows). The API zips `series.dates` into `[date, value]` pairs (section 4), so position `i` belongs to the date of pair `i` of `data.analysis.drawdown` (the same rows), and is `null` where that date is not an aligned date. `ratio_base_date` is its 100.
- `aligned_rows` is the number of dates present in both the stock and the NIFTY50 series; the two dropped counts are dates present in only one of them (docs/05 12.14.1) and are always shown. `index_rows`, `index_as_of` describe the stored index series (source: the owner's prices.csv import of the reserved symbol; the UI prints "Your imported NIFTY50").
- Hidden numbers: a null `rank`, `percentile`, `peer_median_pct`, `vs_median_pp` always has `reason` (`too_few_peers` below 3 peers; `insufficient_history` when the stock is shorter than the window); `n_peers` is always present.
- A failure inside one half never fails the snapshot or the other half: that half is `null` with `compute_error` and the incident is logged (`relative_strength_failed`, symbol, half, error class).
- Size: about 5 KB for a 750-row chart window (`ratio_rebased` dominates); the stored snapshot stays under the 200 KB budget (RET-89).
- Peer ranks are as of this stock's own last bar and update only when this stock is recomputed (RST-6).
### 4a-swing. `analysis.swing_dips` (decision SWD, PROPOSED; built by B18; formulas in `05` 12.13)

An additive, optional block next to `drawdown_profile` (which is unchanged). No new route and no parameter. Percent fields are percent numbers (a depth of -15.0 means 15% below the peak); the swing-leg rows are summaries only. Older snapshots lack the block (the web shows "Not computed yet"); a snapshot whose block failed to compute has `swing_dips: null` and `swing_dips_reason: "compute_error"` and every other block intact.

```json
"swing_dips": {
  "as_of": "2024-01-22", "bars": 22, "window_rows": 252, "min_episodes": 3,
  "thresholds": [
    { "threshold_pct": 10, "dips": 3, "recovered": 2, "superseded": 0, "open": 1,
      "recovered_share_pct": 66.6667, "recovered_share_reason": null,
      "median_depth_pct": -11.5385, "median_depth_reason": null,
      "worst_depth_pct": -15.0, "worst_depth_reason": null,
      "median_days_peak_to_low": 2.0, "median_days_peak_to_low_reason": null,
      "median_days_to_recover": null, "median_days_to_recover_reason": "too_few_episodes",
      "longest_open_days": 2, "longest_open_reason": null,
      "small_sample": true, "reason": null,
      "records": [
        { "peak_date": "2024-01-20", "peak_close": 105.0,
          "low_date": "2024-01-21", "low_close": 94.0, "depth_pct": -10.4762, "days_peak_to_low": 1,
          "recovery_date": null, "days_low_to_recovery": null, "days_low_to_recovery_reason": "open_dip", "status": "open" },
        { "peak_date": "2024-01-17", "peak_close": 104.0,
          "low_date": "2024-01-19", "low_close": 92.0, "depth_pct": -11.5385, "days_peak_to_low": 2,
          "recovery_date": "2024-01-20", "days_low_to_recovery": 1, "days_low_to_recovery_reason": null, "status": "recovered" }
      ] },
    { "threshold_pct": 20, "dips": 0, "recovered": 0, "superseded": 0, "open": 0, "worst_depth_pct": null, "worst_depth_reason": "no_dips",
      "longest_open_days": null, "longest_open_reason": "no_open_dip", "records": [], "...": "medians null with too_few_episodes" }
  ],
  "zigzag": [
    { "threshold_pct": 10, "legs": 4, "bounced": 3, "open": 1,
      "median_depth_pct": -22.1501, "median_depth_reason": null, "worst_depth_pct": -24.2424, "worst_depth_reason": null,
      "median_days_peak_to_low": 1.0, "median_days_peak_to_low_reason": null,
      "median_days_to_bounce": 1.0, "median_days_to_bounce_reason": null, "small_sample": true, "reason": null }
  ]
}
```

Rules.
- `thresholds` has the entries `threshold_pct` 10 and 20 (rule A, "Dips from the 52-week high"); `zigzag` has the same two thresholds (rule B, "Swings (fall then bounce)", summaries only). `records` lists the last 8 dips of rule A, newest first. `status` is `recovered | open | superseded`: a dip is **superseded** when its reference peak dropped out of the 252-row window before it was regained ("not regained within a year"); it is neither recovered nor open, keeps its low and depth, and the next dip is measured from the new 52-week high (D-SWD, `05` 12.13). `dips = recovered + superseded + open`; at most one dip is open. `recovery_date` and `days_low_to_recovery` are null, with `days_low_to_recovery_reason` `open_dip` or `superseded`, unless recovered. A record carries no start date.
- Counts and statistics of an entry are all null with `reason: "insufficient_history"` when fewer than 252 rows exist (rule A) or 2 rows (rule B). `median_depth_pct`, `median_days_peak_to_low` (both over all dips, the open one so far) and `recovered_share_pct` (recovered over all dips) are null with `too_few_episodes` below `min_episodes` (the block carries it; default `INV_MIN_EPISODES` 3) dips; `median_days_to_recover` (recovered dips only) is null with `too_few_episodes` below that many recovered; `worst_depth_pct` is null with `no_dips` when there is no dip; `longest_open_days` (days from the open dip's peak to `as_of`) is null with `no_open_dip` when none is open. Days are calendar days between bar dates.
- Sample sizes (`dips`, `recovered`, `superseded`, `open`, `legs`, `bounced`) and `small_sample` (fewer than `INV_SMALL_EPISODES` = 10) travel with the figures. To keep the stored size down (RET-89), a `reason` or `*_reason` that would be null is **omitted** (absent means null), as for the SIP variants, and so is `analysis.swing_dips_reason` when it would be null; the examples above show them for clarity. `swing_dips` itself is nullable: null with `swing_dips_reason: "compute_error"` when the block failed. The block is about 5 KB for a 25-year stock with many dips (8 records per threshold); the whole stored `indicators` value stays under **250 KB** and the new blocks grow it by under 25 KB (RET-89, SWD-9).
- The expansion step of B04 passes the block through unchanged; `data.analysis` passes unknown blocks through, so the API has no code change (a test pins it).

### 4b. GET `/stocks/seasonality?scope=all|watchlist` (decision D-INV2 / INVA, PROPOSED; built by B17; answers INV-9)
Read-only list for the Home tile "This month, across the years" (`06` 6.2a) over **every tracked stock** (`instrument.is_tracked = true`), not only the watchlist. `scope` is optional: `all` (default) or `watchlist` (only stocks that are on the watchlist); any other value -> 422 `UNPROCESSABLE` (field error `scope`). The route is declared before `/stocks/{symbol}`. Auth and CSRF as every GET; no body; `Cache-Control: no-store`.
```json
{ "data": { "month": 11, "month_name": "November", "as_of": "2026-11-10", "scope": "all",
  "stocks": [ { "symbol": "TCS", "name": "Tata Consultancy Services", "on_watchlist": true,
                "seasonality": { "...": "same object as stocks[].seasonality of GET /watchlist (section 11)" },
                "seasonality_reason": null },
              { "symbol": "XYZ", "name": "Xyz Ltd", "on_watchlist": false, "seasonality": null, "seasonality_reason": "no_prices_imported" } ] },
  "meta": { "source": "import", "stale": false } }
```
- `month` is today's IST calendar month, chosen by the API at request time (the same rule and the same IST midnight boundary as `GET /watchlist`); `as_of` is the newest `seasonality.as_of` among the rows, `null` when no row has a seasonality block. Rows are ordered by symbol; the client sorts.
- Each row reads the **newest** `analysis_snapshot` of that instrument (`indicators #> '{analysis,seasonality}'`) and applies the same selection and reasons as section 11 (`no_prices_imported`, `no_history`; MTD `no_bar_this_month`). An untracked stock is never listed; a tracked stock without a snapshot is listed with `seasonality: null` and its reason; no tracked stocks -> `stocks: []` (200).
- `on_watchlist` is true when a `watchlist_item` references the instrument.
- Cost: one query joining the newest snapshot per tracked instrument with the watchlist; the jsonb value of each snapshot is detoasted once, so the cost is linear in stocks (measured in B17, INVA-10). `GET /watchlist` keeps `stocks[].seasonality` unchanged (backward compatible).

## 5. Fundamentals, ownership, events, peers, research links

### GET `/stocks/{symbol}/fundamentals?basis=consolidated|standalone|auto&period=Q|A`
- `basis=auto` picks consolidated if present else standalone; response states `basis_used` and `basis_available`.
- Response shape:
```json
{ "data": {
  "basis_used": "consolidated", "period_type": "Q", "periods_available": 5,
  "unit": "INR_CR", "source_by_metric": { "pnl.revenue": "csv_import" },
  "periods": ["2025-09-30","2025-12-31","2026-03-31","2026-06-30","2026-09-30"],
  "labels": ["Q2 FY26","Q3 FY26","Q4 FY26","Q1 FY27","Q2 FY27"],
  "metrics": { "pnl.revenue": [ ... values aligned to periods or null ... ] },
  "derived": { "revenue_yoy": [...], "net_profit_yoy": [...], "op_margin": [...], "net_margin": [...] },
  "ratios": { "roe": null, "roce": null, "debt_equity": null, "interest_coverage": null, "cfo_to_pat": null, "fcf": null },
  "valuation": { "pe_ttm": null, "pe_basis": "ttm|latest_annual|n/a", "pb": null, "div_yield": null, "peg": null, "pe_percentile_5y": null },
  "company_type": "general", "status": "ok|partial|parse_error|none"
} }
```
Fiscal labels per `06-frontend-spec.md` section 3. Missing -> null. All values come from owner-supplied data; `periods_available` counts what the owner has entered/imported, and the response includes `"entry_hint": "Add results via Import or the manual form"` when empty. Derived values (growth, margins, ratios, valuation) are precomputed by the worker (`compute_analysis`) and read from `analysis_snapshot.indicators.fundamentals`; the API does not recompute them. `derived_as_of` is the time the worker computed the block that supplied `derived`, `ratios` and `valuation` (`indicators.fundamentals_meta.computed_at`, UTC RFC 3339); for older snapshots without it, the snapshot `as_of` date; null without a snapshot. The warning `DERIVED_STALE` is raised when the newest stored `fundamental_value.fetched_at` is later than `computed_at` (older snapshots: when a value was fetched on a later IST day than `as_of`; D05b-10). D05b additions, passed through unchanged from the snapshot (assumptions D05bGo-1..4): `valuation` also holds `ev_ebitda`, `market_cap_cr` (INR crore) and, when written, `eps_ttm`, `bvps`, `pb_source`, `eps_period_end`, `close`; `ratios` also holds `revenue_cagr_3y/5y`, `net_profit_cagr_3y/5y`, `cfo_to_pat_avg`, `eps_cagr_3y` (growth values are percent numbers); `derived` also holds `revenue_qoq`, `net_profit_qoq` (quarters) and `nii_yoy` when written; `null_reasons` = `{ "derived": {metric: {period_end: reason}}, "ratios": {metric: reason}, "valuation": {metric: reason} }` (reasons such as `n/m`, `missing_input`, `loss_making`, `negative_equity`, `insufficient_history`, `not_applicable_financial`; empty objects when nothing is computed); `ratio_meta` = `{ "roe_basis": "average|ending|null", "ratio_period": {ratio: period_end} }` (the annual period each ratio used). A null metric never shows 0. and `MIXED_SOURCES` lists metrics whose periods come from more than one source (`source_by_metric` names the latest period's source only). B05 additions to this shape (assumptions B05-1..B05-9 in `OPEN_QUESTIONS.md`): `basis_note`, `unit_by_metric`, block-level `*_reason`, `last_updated` and `last_updated_source` (per-stock stamp, D-R); defaults `basis=auto`, `period=Q`; the latest 12 quarters or 10 annual periods are returned.

### GET `/stocks/{symbol}/shareholding`
`{ "quarters": ["2025-12-31", ...], "promoter": [...], "fii": [...], "dii": [...], "mf": [...], "insurance": [...], "govt": [...], "public": [...], "pledged": [...], "qoq_change": { "promoter": 0.12, "fii": -0.3, ... }, "latest_filed_on": "...", "mf_available": true, "note": null }`. If `mf_available=false` (owner did not enter the MF figure), UI shows "DII (includes mutual funds)".

### GET `/stocks/{symbol}/events?from=&to=`
`{ "actions": [ {id, ex_date, record_date, type, ratio_num, ratio_den, amount_per_share, purpose_text} ], "calendar": [ {event_date, type, details} ] }`; default window: actions last 5 years; calendar next 90 days.

### GET `/stocks/{symbol}/peers?limit=8`
Algorithm in analytics spec section 7. Response: `{ "sector": "...", "industry": "...", "peers": [ { "symbol":"", "name":"", "market_cap_cr":0, "ret_1y":0, "pe":0, "pb":0, "roe":0, "rev_growth_3y":0, "op_margin":0, "debt_equity":0, "percentile_rank": {"pe":30.0,...} } ], "self": { ... same fields } }`. Query param `add=SYM1,SYM2` and `remove=SYM3` allow temporary overrides (not persisted).

### GET `/stocks/{symbol}/links`
Returns plain hyperlinks from `config/research_links.json` with `{symbol}`/`{name}` filled (URL-encoded): `{ "links": [ {"label":"NSE quote","url":"https://..."} ] }`. The server never requests these URLs. There is no news endpoint in the Safe Edition.

## 6. Prediction (experimental)

### GET `/stocks/{symbol}/prediction`
```json
{ "data": {
  "experimental": true,
  "disclaimer": "Experimental. Not investment advice. Statistical models often fail out of sample.",
  "as_of": "2026-10-09", "ref_close": 3500.0,
  "horizons": [
    { "days": 5, "shown": true, "p_up": 0.54, "bucket": "slightly_up", "band": { "q10": -0.041, "q50": 0.002, "q90": 0.046, "price_q10": 3356, "price_q50": 3507, "price_q90": 3661 }, "hidden_reason": null },
    { "days": 21, "shown": false, "hidden_reason": "model_not_better_than_baseline" }
  ],
  "trend": { "score": 72, "label": "up" }, "risk": { "score": 41, "label": "medium" },
  "model": { "version": "dir_5d@2026-10-04", "trained_at": "...", "oos_auc": 0.536, "oos_brier": 0.2491, "baseline_brier": 0.2503, "folds": 8 },
  "track_record": { "resolved": 140, "direction_hit_rate": 0.514, "band_coverage_80": 0.77, "since": "2026-04-01" }
} }
```
`hidden_reason` enum: `model_not_better_than_baseline`, `insufficient_history`, `low_liquidity`, `near_corporate_action`, `no_model`, `stale_data`. Buckets: `strongly_down` (p<0.40), `slightly_down` (0.40-0.47), `neutral` (0.47-0.53), `slightly_up` (0.53-0.60), `strongly_up` (>0.60). Trend/risk are always shown when data suffices (rule-based, not ML).

**Implementation notes (B14, decisions B14-1/2/7):** `data` also carries `state` (`ok|no_model|insufficient_universe|insufficient_history|guardrail_failed`) and `state_reason`; with no active model every horizon is `{days, shown:false, hidden_reason:"no_model"}` (hidden horizons never carry `p_up`, `bucket` or `band`) and `model`/`track_record`/`ref_close`/`as_of` are null with a reason. Each horizon also carries its own `model` card and `track_record`; the top-level ones mirror the first horizon that has them. `trend`/`risk` are `{score,label}` or null with `reason`. An old symbol answers `data.redirect_symbol`; an unknown symbol is `404 NOT_FOUND`. The response never contains a single target price.

**B14 review amendments (B14-11 .. B14-15):** (1) Two API-only hidden reasons extend the enum for horizons that have an active model: `awaiting_predictions` (the predict job has stored no row for the stock yet) and `not_tracked` (the stock is not tracked, not active or not an equity, so the worker never predicts it). The worker never writes them; `insufficient_history` now only comes from the worker's own rule (bars < 504) or a failed `insufficient_folds` candidate. (2) `state` also takes `training_aborted` (the last `train_models` run hit its time limit and stored nothing); a dry run reports `no_model` with its own wording. Only finished `train_models` runs with status `ok` or `partial` that carry `details.status` decide the state; skipped and failed runs are ignored. (3) The top-level `as_of` is the date of the newest stored prediction ("last stored prediction date"), not today's date; `ref_close` is the `adj_close` of that date (a price return basis, dividends excluded). `meta.as_of` is the same date, `meta.stale` and `meta.stale_age_hours` come from the holiday-aware calendar (`PricesStaleness`); with no stored row `meta.as_of` is null with `meta.as_of_reason: "no_data"`. (4) Read-time rules, applied on top of the worker's stored decision: quantiles must be finite and ordered `q10 <= q50 <= q90` and `0 <= p_up <= 1`, else the horizon is hidden as `stale_data`; the corporate-action rule of docs/05 10.6 is re-applied (a `detected` action of any date, or a non-rejected action with an ex-date within 5 trading days of the prediction date or of today, hides the horizon as `near_corporate_action`); the freshness rule counts trading days to the expected last trading date, which switches to today only after the 18:00 IST end-of-day cutoff, while the worker counts to today as soon as it is a trading day (one-day edge before 18:00, B14-12). (5) The `model` card and `track_record` are model-level facts: they stay on a horizon hidden for a stock-level reason (`low_liquidity`, `near_corporate_action`, `stale_data`, `not_tracked`, `awaiting_predictions`, `insufficient_history`) and never imply a forecast for that stock; clients must not present them as one.

## 7. Live refresh jobs

### POST `/stocks/{symbol}/refresh`
Body none. Behavior: if an active job for `(stock_refresh, SYMBOL)` exists return it (200). Else if last finished job for this target < `REFRESH_COOLDOWN_MIN` ago return `429 RATE_LIMITED` with `details.retry_after_seconds`. Else if global jobs in the last hour >= `REFRESH_GLOBAL_PER_HOUR` -> 429. Else insert `refresh_job(kind='stock_refresh')`, signal worker-http (fire-and-forget HTTPS POST with HMAC; if it fails the row stays `queued` for the next cron), return `202 { "job_id": 12, "status": "queued", "expected_wait_seconds": 90 }`.

### GET `/jobs/{id}`
`{ "id":12, "kind":"stock_refresh", "target":"TCS", "status":"running", "requested_at":"...", "started_at":null, "finished_at":null, "error":null, "result": {"prices_rows":3,"fundamentals":"skipped_cooldown"} }`. UI polls every 3 s for up to 3 minutes, then shows "still waiting; will update automatically at next run".

**Manual price mode (current):** the Refresh button is hidden; `stock_refresh`/`stock_backfill` return `422 PRICE_MODE_MANUAL`. The only job kind created by the API for stocks is `post_import` (target `batch:<id>`, enqueued after a prices commit, a delete-prices or trim action; deduped by the active-job index). `GET /jobs/{id}` for it returns `result: { "symbols_total": 80, "symbols_done": 40, "stage": "detect_actions|compute_analysis|alerts", "remaining": [...] }`; `stage` is written by the worker at each phase of the symbol in progress; `status` `partial` means more work was re-enqueued or is waiting for `process_queued_jobs` (04 3.12). `POST /mf/schemes/{code}/refresh` checks cooldown, global limit and insert in one advisory-locked transaction, so parallel clicks cannot exceed `REFRESH_GLOBAL_PER_HOUR`.
What `stock_refresh` does (broker mode, inactive): latest quote + last 10 days of daily candles from the broker (requires an active broker session; otherwise job `failed` with `error=broker_session_missing`), then split/bonus detection for that stock. It never fetches fundamentals (those are owner-supplied).
What `stock_backfill` does: full daily-candle history up to `LAZY_BACKFILL_MAX_YEARS` from the broker, then detection; sets `is_tracked=true, tracked_reason='opened'`. In manual price mode both kinds are rejected with `422 PRICE_MODE_MANUAL` (use prices import).

### POST `/mf/schemes/{code}/refresh`
Same pattern, kind `mf_refresh`. Unknown scheme code: `404 NOT_FOUND`; non-numeric or non-positive code: `422` with `details.fields`. Cooldown and global-limit 429s carry `details.retry_after_seconds` (the global one: seconds until the oldest counted request leaves the one-hour window).

## 8. Market and compare

### GET `/market/overview`
`{ "indices": [ {code,name,value,change,change_pct,as_of} ]  /* from `market_series` (reserved prices.csv symbols NIFTY50/INDIAVIX); otherwise empty with reason */, "vix": {...}, "movers": { "gainers": [...top 10 by day change among tracked, min volume filter], "losers": [...] }, "market_status": { "is_open": false, "next_open": "2026-10-12T03:45:00Z", "holiday": null } }`. Market hours 09:15-15:30 IST Mon-Fri excluding `market_holiday` (from `config/market_holidays.json`). There is no FII/DII data in the Safe Edition.

**Implementation notes (B14, B14-4/9/10):** `indices[]` items are `{code,name,value,change,change_pct (percent number),as_of,source,unit}` with `change` null and `change_reason` when there is no previous value; empty `indices` carries `indices_reason`, a missing `vix` is null with `vix_reason`. `movers` items are `{symbol,name,close,change_pct,volume,as_of}`. `market_status` adds `holiday_list_loaded`. `GET /market/holidays` returns `{year, holidays:[{date,description}], year_loaded, note}`; the default year is the current IST year, an invalid year is 422.

**B14 review amendments (B14-4, B14-13):** only the codes `NIFTY50` and `INDIAVIX` of `market_series` are shown. The VIX `unit` is `percent (annualised implied volatility)`, the Nifty `unit` is `index points`. `meta.as_of` is the newest of the index dates and the movers date (never the clock) and is null with `meta.as_of_reason: "no_data"` when there is nothing; `meta.stale` and `meta.stale_age_hours` come from the holiday-aware calendar. Movers rank the change between the newest bar date and the trading day just before it (holiday aware); a stock needs a non-suspect bar on both dates, so a partial import or a multi-day gap never produces a multi-day "day change". The liquidity filter is the 60-day average traded value (docs/05 10.6 `adv_value_60`, mean of `close * volume` over the last 60 bars, at least 0.5 crore); a stock with fewer than 60 bars does not qualify. `movers_reason` is `no_prices_imported` (no bars), `no_common_dates` (bars exist but no stock has both dates) or `no_qualifying_movers` (dates line up but no stock moved or qualifies).

### GET `/market/holidays?year=`
List from `market_holiday` (trading) plus `"year_loaded": true|false`. When no rows exist for the year, `year_loaded=false` and the app treats only weekends as closed.

### GET `/compare?symbols=A,B,C&range=1Y&metrics=pe,pb,roe,...`
2-5 symbols (422 otherwise; duplicates removed). Returns `{ "rebased": { "dates":[...], "series": { "A":[100,...] } }, "metrics": { "A": {...}, "B": {...} }, "best": { "pe": "B", ... } }`. Rebasing: first common trading date in range = 100, using `adj_close`. If a symbol has less than 60% of the range's dates, it is included but flagged `short_history`.

## 9. Screener

### POST `/screener/query`
```json
{ "filters": [ { "metric": "roe", "op": ">", "value": 15 }, { "metric": "market_cap_cr", "op": "between", "value": [5000, 100000] }, { "metric": "sector", "op": "in", "value": ["IT"] } ],
  "sort": { "metric": "roe", "dir": "desc" }, "limit": 100, "cursor": null,
  "universe": { "index": "NIFTY 500", "kind": "equity", "company_type": "general" } }
```
- Ops: `>`, `>=`, `<`, `<=`, `=`, `between` (2-element array), `in` (strings, <= 50). Max 12 filters.
- **Whitelisted metrics** (numeric unless noted; stored in `screener_row.metrics`): `market_cap_cr`, `price`, `pe`, `pb`, `ev_ebitda`, `div_yield`, `roe`, `roce`, `debt_equity`, `interest_coverage`, `op_margin`, `net_margin`, `rev_growth_1y`, `rev_growth_3y`, `rev_growth_5y`, `profit_growth_1y`, `profit_growth_3y`, `profit_growth_5y`, `cfo_to_pat`, `promoter_pct`, `promoter_pledged_pct`, `fii_pct`, `dii_pct`, `mf_pct`, `fii_change_qoq`, `mf_change_qoq`, `rsi14`, `dist_52w_high_pct`, `ret_1m`, `ret_6m`, `ret_1y`, `quality_score`, `trend_score`, `risk_score`; strings: `sector`, `industry`. Any other metric -> 422.
- Result item: `{ "symbol","name","values": { requested metrics }, "coverage": 0.83 }`. Stocks missing a metric used in a filter are excluded; response `meta.excluded_for_missing: {"roe": 41}`.
- Implementation: translate to parameterised SQL over `screener_row.metrics` using `(metrics->>'roe')::float8`; no string interpolation of user input; metric names come only from the whitelist map.
- Saved screens: `GET/POST /screener/saved` and `DELETE /screener/saved/{name}` storing `{name, spec}` in `app_setting` key `saved_screens` (max 30).
- Presets (defined in code, editable later): Quality (`roe>15`, `debt_equity<0.5`, `profit_growth_3y>10`, `promoter_pledged_pct<5`), Value (`pe<15`, `pb<2`, `roe>12`), Growth (`rev_growth_3y>15`, `profit_growth_3y>15`), Momentum (`dist_52w_high_pct>-10`, `ret_6m>15`).

Implementation notes (B13; assumptions B13-1..B13-14 in `OPEN_QUESTIONS.md`):
- Peers (`GET /stocks/{symbol}/peers`): `data` = `symbol`, `sector`, `industry`, `basis` (`industry` or `sector`, the candidate pool used), `market_cap_band` (`0.25-4` or `0.1-10`), `note` (`few comparable peers` or null), `units`, `peers[]`, `self`, `percentile_method`. Each row: `symbol`, `name`, `origin` (`self`, `auto`, `added`), the eight metrics (`market_cap_cr`, `ret_1y`, `pe`, `pb`, `roe`, `rev_growth_3y`, `op_margin`, `debt_equity`; number or null, with `value_reasons`), `percentile_rank` (percent 0-100, decision D05b-4; null with fewer than two values), `as_of`, `last_updated`, `last_updated_source`, `stale`, `stale_reason`. No `sector` and no `industry` on the stock: `404 DATA_UNAVAILABLE reason=no_sector_data`; no market cap: `reason=no_market_cap`. An old symbol answers `data.redirect_symbol`. `add`/`remove` take at most 10 symbols each; a symbol in both is a 422.
- Compare (`GET /compare`): default metrics `market_cap_cr, pe, pb, roe, roce, debt_equity, op_margin, rev_growth_3y, profit_growth_3y, ret_1y, quality_score, trend_score, risk_score`; `range` is one of `1M 3M 6M 1Y 3Y 5Y MAX` counted back from the newest bar. `data` = `range`, `symbols[]`, `rebased {base_date, dates, series, unit, reason}` (common dates only; a stock without prices has a null series; fewer than two stocks with prices or no common date gives empty `dates` and a `reason`, status stays 200), `metrics`, `metric_reasons`, `units`, `best` (explicit direction table; null when fewer than two usable values or a tie; no key for metrics without a direction). Alias symbols resolve to the current symbol.
- Screener: `POST /screener/query` body adds optional `columns` (whitelisted metrics, max 40) next to `filters`, `sort`, `limit`, `cursor`, `universe`; `values` holds the filter, sort and column metrics. `data` = `items[]` (`symbol`, `name`, `as_of` (screener row date), `values`, `value_reasons`, `coverage` (fraction 0-1 of the 36 whitelisted metrics present), `last_updated`, `last_updated_source`, `stale`, `stale_reason`), `next_cursor`, `total`, `units`; `meta.excluded_for_missing` counts, per filtered metric, the universe stocks that lack it. Universe defaults: `kind=equity`, `status=active`, only stocks with a `screener_row`. Every item carries the per-stock last updated date and stale flag (decision D-R): `last_updated` is the IST date of the newest owner-entered fundamentals/shareholding entry (derived values do not count); `stale` is true with no owner data, fundamentals entered more than 120 days ago, or a latest shareholding quarter more than 135 days old (`stale_reason`: `no_owner_data`, `fundamentals_older_than_120_days`, `shareholding_older_than_135_days`).
- Saved screens: `GET /screener/saved` returns `items[]` (`name`, `spec`, `saved_at`), `max_saved` and `presets[]`; `POST` upserts by name (case-insensitive; 201 new, 200 replaced; 409 `saved_screens_limit` for a 31st name); name `^[A-Za-z0-9][A-Za-z0-9 _.()-]{0,59}$`, spec at most 8 KiB; `DELETE /screener/saved/{name}` is 404 when absent.

## 10. Mutual funds

| Endpoint | Behavior |
|---|---|
| GET `/mf/schemes?q=&category=&plan=direct\|regular&option=growth\|idcw&fund_house=&limit=&cursor=` | Server search over `mf_scheme` (trigram on name). Default filters: `plan=direct`, `option=growth` unless `include_all=true`. Groups variants of the same fund when `group=true` |
| GET `/mf/schemes/{code}` | Meta + latest NAV + return table + risk metrics + `warnings` (IDCW caveat, merged/inactive notice). Sets `last_opened_at`; if no NAV rows, enqueues `mf_refresh` and returns `backfill` info like stocks |
| GET `/mf/schemes/{code}/nav?range=1M\|6M\|1Y\|3Y\|5Y\|MAX&log=false` | `{ "points": [[date, nav]...] }` downsampled to <= 2,000 points |
| GET `/mf/schemes/{code}/sip?amount=&start=&end=&day=` | SIP simulation (analytics spec section 9.4) |
| GET `/mf/compare?codes=a,b,c&range=3Y` | 2-5 schemes; rebased to 100 at first common date; table of returns/vol/drawdown |
| GET `/mf/categories` | Distinct categories for filters |

Return table keys: `r_1m,r_3m,r_6m,r_ytd,r_1y,r_3y,r_5y,r_since` (CAGR for >= 1y; absolute below). `null` when history shorter than the window. A scheme with no NAV rows still returns every key as `null` with `return_reasons[key] = "no_nav_yet"` (never an empty object).

Implementation notes (B10):
- All responses carry `attribution: "NAV data: AMFI, via mfapi.in"` (text from `docs/00` section 1 item 6; `docs/01` and `docs/06` omit the comma, B10-8) and `meta.source = "mfapi.in"`, `meta.as_of` = the scheme's own latest NAV date. `meta.stale` is true when that NAV is older than 4 calendar days (B10-3). NAV values are INR per unit; every percent field is a percent number.
- `GET /mf/schemes`: `q` is split into at most 12 words, each matched with `ILIKE '%word%'` (served by the trigram index) and AND-ed; results are ordered by `(name, code)` with a keyset cursor. With `group=true` the rows of the page are folded into funds `{name, fund_house, category, variants[]}` (B10-1). Items carry `latest_nav`, `last_nav_date`, `return_1y_pct` and `returns_as_of` from `mf_return_cache`; `latest_nav` and `last_nav_date` come from the same cache row (`end_nav` with `end_date`), so a NAV is never shown under another day's date; without a cache row `latest_nav` is null and `last_nav_date` is the scheme's own. `meta.as_of` is the newest `last_nav_date` on the page (now only when none). `include_all=true` also lists inactive schemes and drops the default plan/option filters; an explicit `plan` or `option` always applies.
- `GET /mf/schemes/{code}`: `returns` has the keys `r_1m, r_3m, r_6m, r_ytd, r_1y, r_3y, r_5y, r_since` (percent, or null) with `return_basis` (`cagr|absolute`) and `return_reasons` (why a value is null); `risk` has `volatility_pct, volatility_reason, volatility_years, max_drawdown_pct, sharpe_like, sharpe_reason, risk_free_rate`; `rolling_1y` and `nav_jumps` come from the cache. Warnings (envelope `warnings[]`): `IDCW_NOT_COMPARABLE`, `SCHEME_MAY_BE_MERGED` (inactive or last NAV older than 10 days), `METRICS_PENDING` (no cache row), `NO_NAV_DATA`. 404 for an unknown code carries `details.suggestions` (active schemes sharing the first four digits, B10-4).
- `GET /mf/schemes/{code}/nav`: `range` defaults to `1Y`; the window ends at the scheme's latest NAV date. `log=true` is echoed and never changes the values (B10-5).
- `GET /mf/schemes/{code}/sip`: `amount` (positive, at most 2 decimals, <= 1e9) and `start` (>= 1990-01-01) are required; `day` 1-28 (default 1) else 422; `end` defaults to the latest NAV date and is clamped to it with `END_CLAMPED`. Money fields are INR strings. The XIRR cash flows are dated at each installment's execution NAV date. An installment whose execution NAV (the first NAV on or after its date) falls after `end` is not executed and counts in `skipped_installments` (OQ R-B10-4). Downsampling of the NAV series uses LTTB, keeping the first and last point.
- `GET /mf/compare`: the window is `range` ending at the earliest of the schemes' latest NAV dates; the series use the dates present in every scheme and start at the first of them (100 there); the table's return, volatility and drawdown are computed over that common period from each scheme's own NAVs (volatility on the last 3Y at most, null under 1Y or for weekly NAV schemes). `different_starts` is true when schemes' own first dates in the window differ. No shared NAV date is `422 UNPROCESSABLE` with `details.reason = "no_common_dates"`.

## 11. Watchlist

`GET /watchlist` -> `{ "stocks":[{symbol,name,ltp,change_pct,added_at,note}], "funds":[{code,name,nav,change_pct}] }`. **Seasonality addition (INV, PROPOSED, B16; formulas `05` 12.2, screen `06` 6.2a):** each `stocks[]` row also carries `seasonality` for the **current calendar month in IST** (`month` 1..12 chosen by the API from today's IST date; no recompute is needed when the month changes), read from the newest `analysis_snapshot.indicators.analysis.seasonality`: `{ "month": 11, "month_name": "November", "as_of": "2026-11-10", "data_since": "2019-03-01", "years_of_history": 7.7, "n_years": 6, "n_green": 4, "green_pct": 66.67, "green_pct_reason": null, "small_sample": false, "min_years": 3, "avg_pct": 1.2, "median_pct": 1.5, "mtd_return_pct": 1.23, "mtd_reason": null, "mtd_as_of": "2026-11-10" }`. `green_pct` is a percent number (66.67); `n_years` counts only closed past months with a return (the running month never counts); `data_since` is the first imported bar (not the listing date); `green_pct` is `null` with reason `too_few_years` below `min_years` (3). `mtd_return_pct` is the running month's price change so far and is `null` with `mtd_reason` `no_bar_this_month` when the snapshot's `as_of` month is not the current IST month (the share is still valid), or `no_base` / `gap_before`. A stock without a snapshot has `"seasonality": null` and `"seasonality_reason": "no_prices_imported"` or `"no_history"`. For the Home tile over all tracked stocks the same object is also served by `GET /stocks/seasonality` (section 4b, D-INV2); this field on the watchlist stays for compatibility (INV-8 holds for the watchlist, superseded for the tile). Cost: the handler reads one jsonb path per stock from the newest snapshot (the whole value is detoasted, about 100-200 KB per stock); the watchlist is small (a few dozen stocks) and B16 measures it; if it breaks the budget the fallback is a small `analysis_snapshot.seasonality` column added by a forward-only migration (INV-8). `POST /watchlist` body `{"type":"stock","symbol":"TCS","note":""}` or `{"type":"mf","code":120503}` -> 201; duplicate -> 409. Adding a stock sets `is_tracked=true, tracked_reason='watchlist'` (if not already tracked for another reason); no backfill in manual mode. `DELETE /watchlist/{id}`: unsets tracked unless portfolio, imported prices or the LRU keep it. `PATCH /watchlist/{id}` updates note (max 500 chars).

## 12. Portfolio (stocks; mutual fund holdings and the All/Equity/Mutual funds views are in section 12a)

- `GET /portfolio/txns?symbol=&limit=&cursor=`; `POST /portfolio/txns` body:
```json
{ "symbol": "TCS", "side": "buy", "qty": "10", "price": "3500.00", "fees": "20.00", "trade_date": "2026-09-01", "note": "" }
```
Validation: symbol must resolve to an instrument; `qty` 0 < qty <= 1e9 (up to 4 decimals; whole numbers recommended); `price` > 0; `fees` >= 0; `trade_date` not in the future (IST) and not before the instrument's `listing_date`; trade_date must not be a weekend or listed holiday (warning only, not an error); a **sell must not exceed the held quantity at that date** (computed with adjustments) -> 422 `INSUFFICIENT_HOLDINGS`. PATCH/DELETE re-validate the whole sequence for that symbol (reject any edit that would make a later sell exceed holdings).
- Side effects: set `is_tracked=true, tracked_reason='portfolio'` (no backfill in manual mode).
- `GET /portfolio/summary?as_of=` -> holdings, totals, XIRR, realized P&L (FIFO), unrealized (average-cost basis), day change, allocation by stock and sector, benchmark comparison. Detailed math in analytics spec section 8. Money fields are strings. Holdings include `adjustments_applied: [ {date, type, multiplier} ]`.
- `GET /portfolio/adjustments` and `POST /portfolio/adjustments` (override) as per `portfolio_adjustment`.
- B11 response details (assumptions B11-1..B11-9 in `docs/OPEN_QUESTIONS.md`): `GET /portfolio/summary?as_of=&include_exited=` (fully sold positions are hidden by default; their realized P&L stays in `totals.realized_pnl`) returns `holdings[]`, `totals`, `returns {xirr_pct, xirr_reason, absolute_return_pct}`, `benchmark {code, xirr_pct, reason}`, `allocation_by_stock[]`, `allocation_by_sector[]`, `estimated_dividends {amount, label, items[]}`; every unknown value is null with a sibling `*_reason`. `POST /portfolio/txns` returns the created row (`201`; an idempotent replay returns the stored response with header `Idempotent-Replayed: true`). A rejected sell is `422 INSUFFICIENT_HOLDINGS` with `details {transaction_id, date, held_qty, sell_qty}`. `POST /portfolio/adjustments` body `{symbol, effective_date, qty_multiplier, corporate_action_id?, note?}` -> 201; one override per `(symbol, effective_date)` (409 otherwise). `GET /portfolio/adjustments` returns `{items:[{id, symbol, date, type, multiplier, source: override|confirmed_action|review_needed|detected_unconfirmed, applied, corporate_action_id, note}]}`. Watchlist rows carry `id` (needed by PATCH/DELETE); unknown symbol or scheme on `POST /watchlist` is 404.

## 12a. Mutual fund holdings and portfolio views (decisions D-MF, D-MF3; questions MFH-2..MFH-24; analytics in `05` section 8.5)

One logical ledger with an `asset_class` (`equity` | `mf`) on every holding and transaction row; All, Equity and Mutual funds are **filters** of it (`GET /portfolio/summary?view=`). Everything below follows the conventions of sections 1 and 12: money as decimal strings with 4 decimals, **units and NAV as decimal strings with up to 4 decimals**, percent fields are percent numbers, unknown values are `null` with a sibling `*_reason`, `Idempotency-Key` on POST (scope `mf_txn`, 24 h, same request hash rule: a different body under the same key is `409 CONFLICT`), CSRF header on non-GET, 422 with `details.fields`. Every response in this section carries `meta.source = "mfapi.in"` (NAV) for values and the attribution `"NAV data: AMFI, via mfapi.in"`; transaction rows carry `source` (`manual` | `import`).

### Summary views
`GET /portfolio/summary?view=all|equity|mf&as_of=&include_exited=` (extends section 12; unknown `view` is 422; **default `equity`** keeps the existing stocks-only contract unchanged, MFH-14; the UI sends `view` explicitly, default All). Additions to `data` (existing fields keep their meaning and are computed on the view's ledger):
- `view`, `as_of`, `asset_classes_present: ["equity","mf"]` (which classes have any transaction; drives the empty states).
- `totals`: existing fields plus `idcw_income` (MF; null for `equity`), `total_pnl`, `total_pnl_reason`, `purchase_cash`. `invested` = cost of units/shares still held; `realized_pnl` and `idcw_income` are separate buckets (`05` 8.5.3).
- `returns`: `xirr_pct`, `xirr_reason` (`under_one_year`, `no_sign_change`, `insufficient_flows`, `no_nav`, `missing_price`, `no_purchases`), `absolute_return_pct`, `absolute_return_basis`, `span_days`, `first_flow_date`. The one-year rule is in `05` 8.5.6 (MFH-3). **No averaging of XIRRs** (`05` 8.5.4).
- `breakdown[]` (view `all` only; empty otherwise): one row per asset class `{asset_class, invested, market_value, market_value_reason, unrealized_pnl, realized_pnl, idcw_income, total_pnl, xirr_pct, xirr_reason, absolute_return_pct, as_of, stale}`. These rows use only that class's flows; they need not add up to the All XIRR.
- `holdings[]`: equity holdings exactly as section 12 (each row now also has `asset_class: "equity"`); empty for `view=mf`.
- `mf_holdings[]`: the items of `GET /portfolio/mf/holdings` below; empty for `view=equity`.
- `allocation_by_stock[]`, `allocation_by_sector[]` (within the equity sleeve, sum 100; empty for `mf`), `allocation_by_scheme[]`, `allocation_by_category[]` (within the MF sleeve, sum 100; empty for `equity`), `allocation_by_asset_class[]` (`all` only, share of total value; empty otherwise); entries `{key, weight_pct}`; `allocation_excludes_unpriced` applies to each.
- `benchmark`: unchanged for `equity`; for `all` and `mf` the same keys with null values, `{code:null, xirr_pct:null, reason:"not_defined_for_view", level_as_of:null, note:null}` (MFH-9; a client schema must accept `code` null and read the `reason`, B15R-2). `estimated_dividends`: equity only (empty with label for `mf`); IDCW income is real, from transactions.
- `meta`: `as_of` = the valuation date; `meta.stale` true when any component is stale (equity price older than the section 1 limit, or any MF NAV older than 4 calendar days); `meta.source` = `"mixed"` for `all`, `"import"` for `equity`, `"mfapi.in"` for `mf`; each row carries its own `as_of`/`nav_date`/`source`.
- Warnings (envelope `warnings[]`, MF part): `NAV_STALE`, `SCHEME_MAY_BE_MERGED`, `IDCW_PAYOUTS_NOT_RECORDED`, `NAV_FEED_STARTS_AFTER_TXN`, `HOLDINGS_INCONSISTENT` (a stored sequence oversells, as B11-13), plus the existing equity warnings.

### Holdings
`GET /portfolio/mf/holdings?as_of=&include_exited=&group=scheme|folio` (default `group=scheme`) -> `{ items: [...], totals }` with `totals` like the summary's MF totals. Item: `asset_class:"mf"`, `scheme_code`, `scheme_name`, `fund_house`, `category`, `plan` (`direct|regular|unknown`), `option` (`growth|idcw|unknown`), `isin`, `folio` (only for `group=folio`; else `folios: [..]`), `units`, `avg_cost`, `invested`, `nav`, `nav_date`, `nav_stale`, `nav_reason`, `market_value`, `unrealized_pnl`, `unrealized_pct`, `unrealized_pct_reason` (`"n/m"` when the cost base is 0, else null), `realized_pnl`, `idcw_income`, `day_change`, `day_change_reason`, `weight_pct`, `xirr_pct`, `xirr_reason`, `absolute_return_pct`, `first_txn_date`, `span_days`, `exited`, `flags[]` (`inactive`, `idcw`, `merged_suspected`), `source` (`"your statement; NAV: AMFI via mfapi.in"`). Exited rows only with `include_exited=true`. Null never means zero; `nav_reason` is `no_nav` when no NAV exists.

### Transactions
- `GET /portfolio/mf/txns?scheme_code=&folio=&type=&from=&to=&source=&limit=&cursor=` -> `{items, next_cursor}` ordered by `(txn_date desc, id desc)`; item `{id, asset_class:"mf", scheme_code, scheme_name, isin, plan, option, folio, txn_type, txn_date, units, nav, amount, stamp_duty, external_ref, source, import_batch_id, note}`.
- `POST /portfolio/mf/txns` body `{ "scheme_code": 120503, "folio": "1234567/89", "txn_type": "sip", "txn_date": "2026-09-05", "units": "12.3450", "nav": "81.0000", "amount": "999.9500", "stamp_duty": "0.0500", "note": "" }` -> `201` with the created row (+ `warnings[]`); replay with the same `Idempotency-Key` returns the stored response with `Idempotent-Replayed: true`. Validation (422, `details.fields`): `scheme_code` must exist in `mf_scheme` (else `404 NOT_FOUND`); `folio` 1-40 chars; `txn_type` in `purchase|sip|redemption|idcw_payout|idcw_reinvest`, and `switch_in|switch_out|bonus_merger` are `422 MF_TXN_TYPE_NOT_SUPPORTED` (MFH-4); `units` 0 < units <= 1e9, `nav` > 0, `amount` > 0 (up to 4 decimals each, numeric strings or numbers, exponent notation rejected like the other manual forms); `stamp_duty` >= 0 (**`amount` is units x NAV, stamp duty is separate: the cost and cash outflow of a purchase is `amount + stamp_duty`**, MFH-6 correction); `txn_date` not in the future (IST) and not before 1990-01-01; a **redemption must not exceed the units held at that date in that `(scheme, folio)`** -> `422 INSUFFICIENT_UNITS` with `details {transaction_id, date, held_units, redeem_units}` (excess of at most 0.001 is accepted with warning `UNITS_ROUNDED`, MFH-8). Warnings (never errors): `AMOUNT_MISMATCH` (`abs(units x nav - amount) > max(1.00, 1% of amount)`, MFH-6), `NON_BUSINESS_DAY` (weekend or listed holiday, like PF-06), `NAV_FEED_STARTS_AFTER_TXN`, `DUPLICATE_LOOKING_TXN` (same scheme, folio, date, type, units and amount exists). Side effect: `mf_scheme.is_tracked=true`; no NAV backfill is forced here (a scheme without NAV rows enqueues `mf_refresh`, section 10).
- `PATCH /portfolio/mf/txns/{id}` same fields as the body, all optional, except `scheme_code` and `source` which cannot change (422; delete and re-create instead); the whole `(scheme, folio)` sequence (old and new folio) is re-validated: an edit that would make a later redemption exceed held units is `422 INSUFFICIENT_UNITS`. Imported rows may be edited (their `dedupe_key` is kept, so a re-import will not re-create them).
- `DELETE /portfolio/mf/txns/{id}` re-validates the sequence the same way (`422 INSUFFICIENT_UNITS` when a later redemption would oversell); returns `{deleted: id, warnings: []}`; re-derives `is_tracked`.
- All routes need the session; 401/404/422/429 as in section 1; the validation order and messages are table-tested (docs/07 MFH-V01..V15 and MFH-I20..I32).

### Fund-name mappings (MFH-23)
The statement carries only a fund name, so the scheme of every distinct name is chosen by the owner and remembered.
- `GET /portfolio/mf/fund-mappings` -> `{items: [{fund_name, fund_name_key, scheme_code, scheme_name, plan, option, isin, rows, created_at, updated_at, audit_note}]}` (`rows` = stored transactions that depend on the mapping).
- `PUT /portfolio/mf/fund-mappings` body `{ "fund_name": "...", "scheme_code": 120503, "remap": false }` (CSRF; `Idempotency-Key` not needed, the call is idempotent) -> `200` with the item. A name with no mapping is created. An existing mapping to the **same** scheme is a no-op. An existing mapping to a **different** scheme is allowed only while `rows = 0`; otherwise `409 FUND_MAPPING_IN_USE` (`details {rows}`) unless `remap=true`, which rewrites `scheme_code` of every transaction that depends on the mapping in **one transaction**, re-validates the `(scheme, folio)` sequences of the old and the new scheme (`422 INSUFFICIENT_UNITS`, nothing changes), re-derives `is_tracked`, and appends `remapped {date}: {old_code} -> {new_code} ({n} rows)` to `audit_note`. Unknown `scheme_code` is `404 NOT_FOUND`; an empty or over-200-character name is 422.

### Import
Kind `mf_statement` is added to `POST /imports/{kind}/validate`, `POST /imports/{kind}/commit` and `GET /imports/templates/{kind}` (section 14); format and parser rules in `01` section 7.9 (columns `Date | Fund Name | Transaction Type | Folio No | Units Traded | NAV | Amount | Stamp Duty`, CSV or `.xlsx`, blank rows skipped, no ISIN). Limits for this kind: 2 MB and 5,000 rows, type checked by content, read-only parsing (MFH-15, MFH-21). `.xlsx` is accepted only when the server runs with `MF_XLSX_ENABLED=true` (default off, B15R-1); otherwise an `.xlsx` is `422` with the message "xlsx not enabled" and CSV is unaffected. Only the 8 logical columns are kept in the upload store (`01` section 7.9). `validate` returns the usual envelope (row errors include `UNMAPPED_FUND`; warnings include `DUPLICATE_IN_FILE`, `AMOUNT_MISMATCH`, `NON_BUSINESS_DAY`; every preview row carries its file line `row`, the normalised fields, `fund_name` and `scheme_code` when mapped) plus `mf: { date_from, date_to, rows_by_type: {purchase, sip, ...}, funds: [{fund_name, fund_name_key, rows, mapped, scheme_code, scheme_name, plan, option}], unmapped_funds: [{fund_name, fund_name_key, rows, candidates: [{scheme_code, name, fund_house, plan, option, isin, on_watchlist, has_nav}]}], fund_mappings: [...the mapped entries of funds], duplicate_groups: [{rows: [5, 9], count: 2}], duplicates_in_db: 0 }` (a row already imported, by `dedupe_key`, is counted in `duplicates_in_db` and skipped at commit, so re-uploading the same statement inserts 0). `POST /imports/mf_statement/revalidate` body `{ "upload_id": "uuid" }` re-runs the validation of a stored upload against the current mappings and returns the same body as `validate` with the same `upload_id` (404 when the upload expired; the 1 h TTL is not extended). `commit` body `{ "upload_id", "note"?, "excluded_rows"?: [5] }` (`excluded_rows` = file lines the owner unticked, for example one of a `DUPLICATE_IN_FILE` group or a row with errors; they are not imported and the errors of an excluded row do not block the commit; an unknown line is 422; a header problem cannot be excluded) returns `{batch_id, inserted, skipped_duplicates, warnings}` and no `post_import_job_id` (holdings are computed on read); any remaining row error (including `UNMAPPED_FUND`) rejects the commit 422. Undo (`POST /imports/batches/{id}/undo`) is allowed within 30 days for this kind, deletes the batch's rows and answers `409 UNDO_BREAKS_HOLDINGS` (`details {scheme_code, folio, date}`) when a later redemption would then exceed held units; nothing changes in that case (MFH-20).

## 12b. Portfolio risk (decision PRK, PROPOSED; built by B19; formulas in `05` section 8.6, screen in `06` 6.7b; questions PRK-1..PRK-8)

`GET /portfolio/risk?view=all|equity|mf&as_of=` is one read-only endpoint (session required, no CSRF header) that serves concentration, position stress and the reconstructed value history with drawdown for one view. **Name:** `/portfolio/risk` (not `/portfolio/value-history`) because the three blocks share one ledger read and one set of reasons (PRK-5). `view` defaults to `all` (the Portfolio page default; the legacy `summary` default of `equity` exists only for compatibility, MFH-14); an unknown `view` is `422 UNPROCESSABLE` (`details.fields` `view`); `as_of` is `YYYY-MM-DD`, default today (IST), a future date or a bad format is `422` (field `as_of`). Conventions of sections 1, 12 and 12a: money as decimal strings with 4 decimals (INR), percent fields are percent numbers, unknown is `null` with a sibling `*_reason`, never `0`/`NaN`/`Infinity`. `meta.source` = `"mixed"` (`all`), `"owner transactions + imported prices"` (`equity`) or `"mfapi.in"` (`mf`); `meta.stale` is true when any component price or NAV is stale (as the summary); `warnings[]` carries `HOLDINGS_INCONSISTENT`, `HISTORY_STEP_SKIPPED`, `MISSING_PRICE`, `NAV_STALE` (one per cause).

```json
{ "data": {
  "view": "all", "as_of": "2026-11-12", "currency": "INR",
  "concentration": {
    "total_value": "10000.0000", "total_value_reason": null,
    "holdings_count": 4,
    "top1_pct": 50.0, "top3_pct": 95.0, "top5_pct": 100.0, "shares_reason": null,
    "hhi": 0.365, "effective_holdings": 2.74, "hhi_reason": null,
    "group_hhi": 0.665, "group_top1_pct": 80.0, "group_reason": null,
    "by_holding": [ { "key": "A", "name": "A Ltd", "asset_class": "equity", "group": "Banks", "value": "5000.0000", "weight_pct": 50.0, "weight_reason": null } ],
    "by_group": [ { "key": "Banks", "kind": "sector", "value": "8000.0000", "weight_pct": 80.0, "holdings": 2 } ]
  },
  "stress": {
    "label": "What if this one holding fell and nothing else moved. Arithmetic on today's values, not a forecast.",
    "falls_pct": [10, 20],
    "items": [ { "key": "A", "name": "A Ltd", "asset_class": "equity", "value": "5000.0000",
      "impact_10": "-500.0000", "impact_10_pct": -5.0, "impact_20": "-1000.0000", "impact_20_pct": -10.0, "impact_reason": null } ]
  },
  "history": {
    "basis": "time_weighted_index", "base": 100,
    "series_reason": null, "from": "2016-04-01", "to": "2026-11-12", "points_count": 2480,
    "points": [ { "date": "2016-04-01", "value": "100000.0000", "index": 100.0, "drawdown_pct": 0.0 } ],
    "gaps": [ { "from": "2016-01-04", "to": "2016-03-31", "dates": 61, "reason": "missing_price: A" } ],
    "gap_dates_total": 61, "gaps_truncated": false, "skipped_steps": 0,
    "current_drawdown_pct": -4.5, "peak_date": "2026-10-01", "peak_index": 183.2, "days_under_water": 42, "drawdown_reason": null,
    "max_drawdown": { "depth_pct": -31.2, "peak_date": "2020-01-14", "trough_date": "2020-03-23", "recovery_date": "2020-11-05", "recovered": true },
    "twr_since_start_pct": 83.2
  } }, "meta": { "as_of": "...", "source": "mixed", "stale": false, "stale_age_hours": 0 }, "warnings": [] }
```
- `concentration`: `total_value` is the summed value of the view's **open** holdings, `null` with `total_value_reason` (`missing_price: ...`, `missing_nav: ...`, `no_open_holdings`, `zero_value`) when any holding is unpriced or none is open; in that case `top1_pct`, `top3_pct`, `top5_pct`, `hhi`, `effective_holdings`, `group_hhi`, `group_top1_pct` and every `weight_pct` are `null` with the shared reason in `shares_reason`, `hhi_reason`, `group_reason`, `weight_reason` (never a partial sum as a total). `hhi` is a fraction in (0, 1] and `effective_holdings = 1/hhi` (2 decimals); `holdings_count` counts open holdings (priced or not); top-N with fewer than N holdings is the share of all of them. `by_holding` is ordered by value descending (unpriced last, ties by key); `key` is the stock symbol or the scheme code as a string; `group` repeats the holding's group key (`Unclassified` when the owner imported no sector or category). `by_group[].kind` is `sector`, `category`, `mutual_funds` or `unclassified`; in `all` every fund is in the single `Mutual funds` slice. Lists are `[]` when empty.
- `stress.items[]`: one row per open holding in `by_holding` order; `impact_10`/`impact_20` are negative money strings (`value x f / 100`), `impact_*_pct` are negative percent numbers of the current total, both `null` with `impact_reason` (`no_price`, `no_nav`, or the total's reason for the percent only). `label` is fixed copy and `falls_pct` is `[10, 20]`.
- `history`: `points` holds **only valid dates** in ascending order; `value` (money string; **includes the owner's deposits and withdrawals**, a full-exit day carries `"0.0000"`), `index` (time-weighted return index, base 100, 4 decimals), `drawdown_pct` (percent number, <= 0, 2 decimals). `gaps[]` are ranges of dates that could not be valued (`reason` `missing_price: SYM, ...` or `nav_gap: scheme name, ...`), at most the 50 most recent ranges (`gaps_truncated`, `gap_dates_total` always the exact count). `series_reason` is `no_transactions` or `no_priced_dates` when `points` is empty, else `null`. `skipped_steps` counts index steps that could not be computed because a transaction fell inside a price gap (`05` 8.6.3). `current_drawdown_pct`, `peak_date`, `peak_index`, `days_under_water`, `max_drawdown`, `twr_since_start_pct` are `null` with `drawdown_reason = too_few_points` when there are fewer than 2 points. `max_drawdown.recovery_date` is `null` with `recovered=false` while open; an index that never fell has `depth_pct` 0 and null `peak_date`, `trough_date`. Size: about 2,500 points for 10 years (about 250 KB of JSON before gzip; `Content-Encoding` is the gateway's job); a past `as_of` truncates the series.
- Cost: the handler reads transactions, adjustments and the held instruments' bars once and computes in memory; target under 500 ms for about 200 transactions and 10 years of daily prices (B19 measures it and records the number in `docs/OPEN_QUESTIONS.md` PRK-8); no cache is added unless the measurement misses the budget.
- Errors: 401 without a session; 422 for `view` or `as_of`; 429 as everywhere. A view with no data is a 200 with the reasons above (not an error).

## 13. Alerts and Telegram

- `POST /alerts` body `{ "target": {"type":"stock","symbol":"TCS"}, "kind":"price_above", "params":{"price":4000}, "one_shot":true, "cooldown_minutes":1440, "expires_on":"2027-03-31" }`.
- Params by kind (all validated; unknown keys rejected):

| kind | params | Fires when |
|---|---|---|
| `price_above` / `price_below` | `price` > 0 | latest known price crosses the threshold (see crossing rule in jobs spec) |
| `day_change_pct` | `pct` (0.1-50), `direction` up/down/either | day change from prev close exceeds pct |
| `wk52_high` / `wk52_low` | none | latest price makes a new 52-week high/low |
| `ma_cross` | `fast` (int 5-100), `slow` (int 20-300, > fast), `direction` golden/death | SMA fast crosses slow on daily close |
| `rsi_above` / `rsi_below` | `level` 1-99 | RSI(14) crosses level |
| `results_upcoming` | `days_before` 1-14 | calendar has a results event within N days (once per event) |
| `results_declared` | none | new quarterly results ingested |
| `holding_change` | `holder` promoter/fii/dii/mf, `delta_pct` 0.1-20 | new quarter filing changes the holding by at least delta |
| `nav_above` / `nav_below` | `nav` > 0 (MF) | latest NAV crosses |

- Alert text says "as of last update (time)"; v1 has no real-time ticks. **Manual price mode:** messages end "as of the last price import ({bar date})". Creation-time `THRESHOLD_ALREADY_MET` is checked against the **last imported bar**, and the 422 message says so ("already true at the last imported bar of {date}").
- `GET /alerts?status=`, `PATCH /alerts/{id}` (status active/paused, params), `DELETE /alerts/{id}`, `GET /alerts/events?limit=` (history with delivery status).
- Max 200 active alerts; 429-like `CONFLICT` beyond.
- `POST /telegram/link-code` -> `{ "code":"A7K9-Q2XM", "expires_at":"...", "bot_username":"..." , "deep_link":"https://t.me/<bot>?start=<code>" }`; code = 8 chars from an unambiguous alphabet, stored as sha256, valid 15 min, one use. `DELETE /telegram/link` clears chat id. `POST /telegram/test` sends a test message (rate limited 1/min). `POST /telegram/webhook` as in data-sources section 8; the route has a per-IP rate limit (60/min, `RATE_LIMITED`).

Implementation notes (B12):
- `POST /alerts` answers 201 with the alert `{id, target:{type,symbol|code,name}, kind, params, status, one_shot, cooldown_minutes, expires_on, last_fired_at, created_at}`. Defaults: `one_shot` true, `cooldown_minutes` 1440. `expires_on` must be today (IST) or later. Every `params` key of the kind is required (no silent defaults); unknown keys, numeric strings and fractional integers are 422 with `details.fields[].field = "params.<key>"`. `nav_*` kinds need a `mf` target (`{"type":"mf","code":120503}`), all other kinds a `stock` target; a kind/target mismatch is a 422 on `target.type`; an unknown symbol or scheme is 404 `NOT_FOUND`; a renamed symbol resolves through `symbol_alias`.
- `THRESHOLD_ALREADY_MET` (422, code `THRESHOLD_ALREADY_MET`, `details: {kind, threshold, value, as_of}`) applies to `price_above/below` (last non-suspect imported bar close) and `nav_above/below` (latest imported NAV), on create and when PATCH changes params. With no bar or NAV yet the alert is accepted.
- Limit: 200 alerts with `status='active'`; the 201st create, or resuming a paused alert into a full set, is 409 `CONFLICT`. Paused, fired and expired alerts do not count.
- `GET /alerts?status=active|paused|fired|expired&limit=&cursor=` and `GET /alerts/events?limit=&cursor=` return `{"items":[...],"next_cursor":null|string}`, newest first. An event item is `{id, alert_id, kind, target, fired_at, payload, delivery_status, delivery_attempts, delivered_at, last_error}`.
- `PATCH /alerts/{id}` takes `{status: "active"|"paused", params}` (at least one; any other key is 400). A params change clears `alert.last_state`. A fired or expired alert is final: 409. `DELETE` answers `{"data":{"ok":true}}`; a missing id is 404.
- `POST /telegram/link-code` answers 200 `{code, expires_at, bot_username, deep_link}`; `bot_username` and `deep_link` are null with warning `BOT_NOT_CONFIGURED` while `TELEGRAM_BOT_USERNAME` is unset. `DELETE /telegram/link` and `POST /telegram/test` answer `{"data":{"ok":true}}`; the test message is 409 when no chat is linked, 429 (`Retry-After`) within 60 s of the previous one, and 503 `SOURCE_DOWN` when no bot token is configured or Telegram refuses.
- `POST /telegram/webhook`: header `X-Telegram-Bot-Api-Secret-Token` compared in constant time with `TELEGRAM_WEBHOOK_SECRET`; missing, wrong or unconfigured secret is 401 and nothing is read or stored. Body limit 64 KiB. Only `/start <code>` (also `/start@<bot> <code>`) in a **private** chat is acted on: the code (case-insensitive, dash optional) is consumed atomically and the chat id stored (while a *different* chat is linked the request is refused, the code is not consumed and the chat gets a fixed "already linked" reply: unlink first; at most 10 unsuccessful attempts per 15 minutes are processed, B12-11), and the chat gets a fixed confirmation or "invalid, expired or already used" reply. Everything else (other commands, text, groups, channels, edits, callbacks, malformed JSON) is acknowledged with 200 and ignored, with no reply. The webhook needs no `X-Requested-With`.

## 13a. Decision journal (plan Item D, B20; questions JRN-1..JRN-6; table `journal_note`, docs/02 migration 0015)

A short dated note per stock saying why the owner bought, held or is watching it, so a later review compares the reason with what happened. Owner data: plain text, never sent anywhere, never exported (only the encrypted D08 backup holds it, docs/04 3.11). No Telegram reminder in v1 (JRN-2). All routes need the session; CSRF header on non-GET; errors use the envelope of section 1.

- `GET /stocks/{symbol}/journal?status=open|reviewed&limit=&cursor=` -> `data = {items, next_cursor, today, review_due_count}` ordered by `(noted_on desc, id desc)` (keyset cursor, default 50, max 200). `today` is the owner's IST date used to compute `review_due` (so a client never needs its own clock); `review_due_count` counts **all** open notes of the stock that are due, whatever the page or the status filter. An unknown symbol is 404 `NOT_FOUND` (old symbols resolve through `symbol_alias`, as elsewhere); an unknown `status` is 422 on `status`. `meta.source = "owner journal"`.
- Item: `{id, symbol, noted_on, note, price_at_note, price_as_of, price_source, price_reason, review_on, status, reviewed_at, review_due, portfolio_txn_id, txn}`.
  - `note`: plain text, 1 to 1,000 characters (counted in characters, not bytes), stored and returned as typed (trimmed at both ends; CRLF and lone CR become LF). It is untrusted text: the web renders it as text, never as HTML.
  - `price_at_note`: decimal string with 4 decimals, the latest valid (non-suspect) imported close on or before the day the note was written, **unadjusted as imported**; `price_as_of` is that bar's date; `price_source` is the constant `"your imported prices"`. With no imported price both price fields are `null` and `price_reason = "no_price_imported"` (never 0). The price is fixed when the note is created and cannot be edited (a changed mind is a new note).
  - `review_on`: optional IST date. `review_due` is `true` exactly when `status = "open"`, `review_on` is set and `review_on <= today` (the date itself counts as due); it is computed on read, never stored.
  - `status`: `open` or `reviewed`; `reviewed_at` is the UTC timestamp of the change to `reviewed` (null while open).
  - `txn`: null, or `{id, side, qty, price, trade_date}` of the linked `portfolio_txn` (decimal strings like section 12); `portfolio_txn_id` is the same id or null. A link whose transaction was later deleted becomes null.
- `POST /stocks/{symbol}/journal` body `{ "note": "Bought on the dip; thesis: ...", "review_on": "2027-03-31", "portfolio_txn_id": 42 }` (`review_on` and `portfolio_txn_id` optional) -> `201` with the item. `Idempotency-Key` header (UUID, optional, scope `journal_note`, 24 h): a replay returns the stored response with `Idempotent-Replayed: true`; the same key with a different body is `409 CONFLICT`. Validation (422, `details.fields`, one entry per field): `note` required, not blank, at most 1,000 characters, no control characters other than newline and tab (`"must not contain control characters"`), no bidirectional override, embedding or isolate characters (U+202A to U+202E, U+2066 to U+2069: `"must not contain text-direction control characters"`, JRN-7), and not only invisible characters (zero-width space, joiners, U+2060, U+FEFF count as blank; a zero-width joiner inside an emoji sequence is kept); `review_on` must be a valid `YYYY-MM-DD` and today (IST) or later and at most 10 years ahead; `portfolio_txn_id` must be the id of a transaction of **this** stock (otherwise 422 `"must be a transaction of this stock"`). `noted_on` is today's IST date (not accepted from the client). At most 500 notes per stock; the 501st is `409 CONFLICT` (JRN-3). Unknown body keys are 400 like every other route.
- `PATCH /journal/{id}` body with at least one of `note`, `review_on` (a date or `null` to clear), `status` (`open` | `reviewed`), `portfolio_txn_id` (an id or `null` to clear) (none: 422 on `body`) -> `200` with the item. Same validation as create; `review_on` may only be set to a past date when it equals the stored value (so an overdue note can still be marked reviewed or edited). Changing `status` to `reviewed` sets `reviewed_at`; back to `open` clears it. `price_at_note`, `price_as_of`, `noted_on` and the stock cannot change (unknown key 400). A missing or non-numeric id is 404.
- `DELETE /journal/{id}` -> `{"data":{"id":42,"deleted":true}}`; missing id is 404. Deleting is final (no soft delete); the web asks for confirmation.
- Error codes reused: `NOT_FOUND`, `UNPROCESSABLE` (422, `details.fields`), `CONFLICT` (409), `UNAUTHENTICATED`, `RATE_LIMITED`. Nothing new.

**Alert shortcuts (plan Item D, no API change; questions ALS-1..ALS-3).** The Analysis tab offers buttons that open the existing create-alert form (section 13) with the symbol, the kind (`price_below` or `price_above`) and the price already filled in. The levels are computed in the browser with decimal arithmetic from facts already on screen (`analysis.position.high_52w_close`, `analysis.position.sma200`, rounded to 2 decimals half up); the owner still reviews the form and presses Create. The server rules are unchanged: `POST /alerts`, `THRESHOLD_ALREADY_MET` (422, checked against the last imported bar), the 200-active limit and the validation of section 13 apply as they do for a hand-typed alert. No new alert kind is introduced (JRN/ALS: `wk52_high` and `wk52_low` exist, but "10% below the high" is a level, which `price_below` already expresses).

## 14. Imports and owner-entered data

All files go through **validate -> preview -> commit**. Formats, columns and rules are in `01-data-sources.md` section 7.

| Endpoint | Behavior |
|---|---|
| POST `/imports/{kind}/validate` | multipart `file` (<= 5 MB and 50,000 rows; **`prices`: 25 MB / 300,000 rows**, enabled only after S9 passes, until then the lower limit applies). `kind` in `prices`, `instruments`, `holidays`, `results_quarterly`, `results_annual`, `balance_cashflow`, `fundamentals_long`, `shareholding`, `corporate_actions`, `instrument_meta`, `mf_statement` (D-MF, D-MF3: **2 MB / 5,000 rows** instead of the 5 MB / 50,000 default, CSV or `.xlsx` (the other kinds stay CSV-only); type checked by content, so the file-name check accepts `.csv`, `.txt` and `.xlsx` for this kind; read-only parsing; section 12a and `01` 7.9). (`screener_xlsx` is not built: D-5.) Parsed as a stream. Returns `{ "upload_id":"uuid", "upload_group":null, "rows": 120, "preview": [first 20 normalized rows], "errors": [{"row":5,"column":"period_end","message":"..."}], "warnings": [...], "estimated_growth_mb": 3.2, "prices_already_adjusted": null }` plus `error_count` and `warning_count` (the `errors`/`warnings` lists keep the first 200 entries; row numbers are file lines, header = 1; optional form field `upload_group` is echoed for browser-split parts; 413 over the byte limit, 422 for too many rows, a non-CSV type or content; **429 `RATE_LIMITED` with `Retry-After` when 10 validated uploads or 100 MB of them are already waiting for a commit**) (`estimated_growth_mb` and `prices_already_adjusted` for `prices`; `null` = the owner has not yet chosen, the wizard must show the required raw / already adjusted / I don't know choice). Nothing is written. The validated file is stored in the `import_upload` table, 1 h TTL, so it survives an API restart |
| POST `/imports/{kind}/commit` | body `{ "upload_id":"uuid", "note":"as per filing dated 2026-08-12" }` (or `{ "upload_ids":[...], "upload_group":"uuid" }` when the browser split a large prices file; all parts commit in **one** transaction). Rejected with 422 if the upload has any errors, for `prices` with `422 PRICES_ADJUSTMENT_UNSET` while `PRICES_ALREADY_ADJUSTED` is unset, and for `prices` with `422 DB_SIZE_LIMIT` if current DB size (without this commit's own upload) + estimated growth (new rows only) would exceed `DB_SOFT_LIMIT_MB`; at most 10 `upload_ids` and 50 MB per commit else 422 on `upload_ids` (also rejected whenever the DB is already at the limit). Inserts in chunks of 5,000 rows inside one transaction (any error rolls back everything); deletes the `import_upload` row; returns `{ "batch_id": 7, "inserted": 100, "updated": 20, "renamed": 0, "post_import_job_id": 14, "warnings": ["TRACKED_OVER_400"] }` (`renamed` counts `previous_symbol` renames; `post_import_job_id` is null when nothing was queued, with warning `POST_IMPORT_NOT_QUEUED` if queueing failed after the commit; the commit re-validates the stored file against the current data). Prices commits mark symbols `is_tracked` (`imported`) and enqueue `post_import` |
| GET `/imports/batches?limit=` | List `import_batch` rows |
| POST `/imports/batches/{id}/undo` | Allowed within 30 days for results (quarterly/annual), balance/cash-flow, fundamentals long, shareholding, corporate-action and `mf_statement` batches (the last answers `409 UNDO_BREAKS_HOLDINGS` when a later redemption would oversell, section 12a); deletes the rows tagged with the batch (overwritten values are NOT restored) and queues `post_import`; returns `{ "batch_id": 7, "removed": 24, "post_import_job_id": 14, "warnings": [], "earlier_batch_ids": [] }`; 404 unknown batch; 409 if already undone, older than 30 days, or the kind is `prices`, `instruments`, `holidays`, `instrument_meta` or a manual-entry batch (B06b-4); **409 `UNDO_HAS_DEPENDENTS`** (`details.dependents` = `{ "portfolio_adjustment": 1 }`) when a `corporate_actions` batch contains an action that a portfolio adjustment refers to: nothing is changed and no portfolio data is deleted; remove the adjustment first (B08-1). `warnings` codes: `POST_IMPORT_NOT_QUEUED` (the undo is saved, analytics were not queued), `UNDO_REMOVED_NOTHING` (no row carried the batch id any more because a later import took the values over; the batch is still marked undone) and `UNDO_REMOVES_EARLIER_IMPORT` (the same file, by sha256, was imported earlier and not undone; a re-import re-tags the rows, so the undo also removed values that existed before this batch; `earlier_batch_ids` names those batches; overwritten values are still not restored) |
| GET `/imports/templates/{kind}` | Downloads the CSV template with the header row and one example row (includes `instruments`) |
| GET `/settings/prices-adjustment` | `{ "value": null|true|false, "set_at": "..." }` |
| PUT `/settings/prices-adjustment` | body `{ "value": true|false }` (`false` = raw, `true` = already adjusted). Used by the wizard choice; "I don't know" calls nothing. Changing an already-set value requires `{ "confirm": true }` and shows the mixing warning (existing bars keep their own `src_adjusted`) |
| POST `/imports/prices/adjustment-check` | body `{ "upload_id":"uuid", "symbol":"TCS", "ex_date":"2024-06-12", "expected_ratio": {"num":1,"den":2} (optional) }` -> `{ "bars": [[date, close], ... up to 5 trading days each side, from the uploaded file], "ratio": 0.5003, "nearest_fraction": "1/2"|null, "hint": "raw_likely|adjusted_likely|inconclusive" }`. Reads only the validated upload; writes nothing |
| POST `/instruments` | Manual **Add stock**: body `{ "symbol":"TCS", "name":"Tata Consultancy Services Ltd", "isin":"INE467B01029" }` (isin optional; same validators as `instruments.csv`, malformed ISIN = warning). 201 `{ "id": 1, "symbol":"TCS", "warnings":[] }`; existing symbol -> 409 (use the CSV to update) |
| POST `/stocks/{symbol}/results` | Single-period manual entry (quarterly or annual) with the same validators; body `{ "basis":"consolidated","period_type":"Q","period_end":"2026-09-30","values": {"revenue": 1234.5, ...}, "note":"" }` | Values are the 10 P&L columns of `01` 7.2 (`revenue` ... `eps`); numbers, numeric strings or null. Re-entering a period restates it: the metrics sent are overwritten, and metrics that were stored by an earlier manual entry but are not sent this time stay as they are (to remove them, delete the manual period and enter it again). Number cells in exponent notation (`1e5`) are rejected with the message "exponent notation not accepted"; keys of `values` that differ only by case or surrounding spaces (`Revenue` and `revenue`) are a 422 "duplicate key". Response (201, or 200 when only updated): `{ "batch_id", "inserted", "updated", "warnings": [{"field","code","message"}], "post_import_job_id" }`; when the queue fails after the save, `warnings` gets `{"field":"post_import","code":"POST_IMPORT_NOT_QUEUED",...}` and `post_import_job_id` is null (all three manual POSTs); every manual write records an `import_batch` of kind `manual_form` with the note (B06b-10)
| POST `/stocks/{symbol}/shareholding` | Manual shareholding quarter entry; flat body with the columns of `01` 7.3 (`quarter_end`, `promoter`, `fii`, `dii`, `mf`, `insurance`, `govt`, `public`, `pledged_of_promoter`, `shareholders_count`, `filed_on`) plus `note`; same response shape as results |
| POST `/stocks/{symbol}/actions` | Manual corporate action entry (status `confirmed`); flat body with the columns of `01` 7.4 (`ex_date`, `type`, `ratio_num`, `ratio_den`, `amount_per_share`, `purpose_text`) plus `note`; response adds `id`; a repeat of the same stock, ex-date, type and purpose updates that row; `warnings` carries `DUPLICATE_EX_DATE_ACTION` (message names the existing action id) when another confirmed or pending split/bonus exists for the same stock and ex-date (the row is still stored, B07R-1; the CSV commit returns the code in its `warnings` list) |
| PATCH `/stocks/{symbol}/actions/{id}` | Body `{ "status": "confirmed|rejected" }` for **detected** actions; confirm triggers history re-adjustment (job) and analytics recompute. Confirming a detected candidate also needs `action_type` (`split`\|`bonus`), `ratio_num`, `ratio_den` (B07-1); 409 when a confirmed split/bonus already exists on that ex-date, when a rejected candidate is confirmed or a confirmed one rejected; repeats are idempotent; response adds `multiplier`, `warnings` (`RATIO_DISAGREES_WITH_DETECTED` beyond 3%; `RATIO_EXTREME` when the multiplier is above 100 or below 0.01; `ADJUSTMENT_SKIPPED_SRC_ADJUSTED` when the ex-date bars were imported as already adjusted, so prices do not change; B07R-2/3, interim), `post_import_job_id` |
| DELETE `/stocks/{symbol}/results?period_type=&period_end=&basis=` | Remove the **manual** values of a period (CSV values stay); returns `{ "deleted", "batch_id", "post_import_job_id", "warnings": [] }` (`warnings` has `POST_IMPORT_NOT_QUEUED` when the queue failed after the delete); 404 when the period has no manual entry; 422 for a bad query |

Validators reject (422 with `details.fields`) what the spec calls errors and return warnings for suspicious values (unit mix-ups, tax/PBT mismatches).

## 14a. Broker connection (read-only data)

**Manual price mode (current, D-1): only `GET /broker/status` is built and returns `{ "enabled": false, "mode": "manual" }`; the other routes below are not implemented (`422 BROKER_DISABLED` if called). Table kept as a design reference.**

| Endpoint | Behavior |
|---|---|
| GET `/broker/status` | `{ "enabled": true, "broker": "upstox", "connected": true, "expires_at": "...", "minutes_left": 420, "needs_reconnect": false }` |
| GET `/broker/login` | Creates `broker_oauth_state` (10 min), returns `{ "url": "<broker authorize URL>" }`; the browser navigates there. Disabled with `422 BROKER_DISABLED` in manual price mode |
| GET `/broker/callback?code=&state=` | Public route (state-verified). Exchanges the code, stores the encrypted token, marks any prior active session `revoked`, redirects to `/settings?broker=connected` (or `?broker=error&reason=...`) |
| DELETE `/broker/session` | Revoke and delete the stored token |
The token is never returned by any endpoint and never logged.

## 15. Admin / ops

`GET /admin/status` -> `{ "sources": [source_health rows], "jobs": [latest ingestion_run per job], "coverage": { "instruments": 2231, "tracked": 612, "with_prices": 598, "with_fundamentals": 410, "with_shareholding": 401 }, "db": { "size_mb": 210, "tables": [ {name, mb, rows} ], "warn_level": "ok|70|85|95|limit" }, "holiday_list_missing_years": [2026], "version": "git sha", "storage_policy": {...}` . Implementation notes (B14, B14-5/6/8): `sources` omit the dormant broker; `jobs` and `recent_errors` (newest 50 failed or partial runs with an error) use the table columns of docs/02 as keys; `db` also has `limit_mb` and `used_pct`, and `warn_level` is computed at read time; `storage_policy` is a flat key/value object; `version` is the `GIT_SHA` env var or `unknown`. No broker session state (manual price mode). B14 review: `jobs` is the latest non-skipped run per job (a skipped "already running" run never masks the last real result) and carries `last_skipped_at` when a skipped run is newer; `db.tables[].rows` is the planner estimate and is null for a table that was never analyzed; `db.used_pct` is null when no limit is configured; `sources[].note` and `jobs[].error`/`recent_errors[].error` are passed through the log scrubber at read time. `GET /healthz` -> `{ "ok": true }` (no DB call; also served at the root path `/healthz` for the hosting health check). `GET /readyz` (auth) -> DB ping.

## 16. Rate limits and security headers
- Per-IP login: 10/min. Authenticated general: 120/min. Refresh endpoints: as above. Return `X-RateLimit-*` headers (optional).
- Headers on every response: `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `Cache-Control: no-store` (except `/stocks/index`), `Content-Security-Policy` set at the Next.js layer.
- Log lines never contain passwords, cookies, tokens, or full request bodies.
