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
`meta.stale` is true when data age exceeds the freshness limit for its type (prices: > 1 trading day after expected EOD time; fundamentals: > 120 days since last successful fetch; shareholding: > 135 days since last quarter end; MF NAV: > 2 business days).
- Error envelope (HTTP status matches):
```json
{ "error": { "code": "NOT_FOUND", "message": "Instrument not found", "details": { "symbol": "XYZ" } } }
```
Codes: `BAD_REQUEST` 400, `UNAUTHENTICATED` 401, `FORBIDDEN` 403, `NOT_FOUND` 404, `CONFLICT` 409, `UNPROCESSABLE` 422 (validation, with `details.fields[]`), `RATE_LIMITED` 429 (with `Retry-After`), `DATA_UNAVAILABLE` 404 (valid target, no data yet; details: `reason`), `SOURCE_DOWN` 503, `INTERNAL` 500. A wrong method (405) and an oversized body (413) use `BAD_REQUEST`; routes not yet built return 501 `NOT_IMPLEMENTED`.
- Auth: cookie `session` (httpOnly, Secure, SameSite=Lax, path `/`). All routes need it except `GET /healthz`, `POST /auth/login`, `POST /telegram/webhook`.
- CSRF: all non-GET requests must include header `X-Requested-With: fetch` (browsers cannot add it cross-site without CORS preflight; we send no CORS headers).
- Pagination: cursor-based `?limit=&cursor=`; `limit` default 50, max 200 (larger values are clamped to 200; non-integer or < 1 is a 422); response `{"items":[...],"next_cursor":null|string}`.
- Symbol path parameter: URL-encoded exact exchange symbol (`M%26M`, `BAJAJ-AUTO`); matching is case-insensitive; resolved through `instrument.symbol` then `symbol_alias.old_symbol` (alias -> 301-style response `{"redirect_symbol": "NEW"}` with HTTP 200 and `data.redirect_symbol`).
- Validation failures return 422 with `details.fields: [{"field":"qty","message":"must be > 0"}]`.
- Idempotency: `POST /portfolio/txns` accepts optional header `Idempotency-Key` (UUID) stored 24 h.

## 2. Auth

| Method/Path | Body | Behavior |
|---|---|---|
| POST `/auth/login` | `{"password":"..."}` (1..200 chars) | Verify argon2id. On success create session (random 32 bytes, store sha256), set cookie, expiry now+`SESSION_DAYS`. On failure increment `app_user.failed_logins`; after `LOGIN_MAX_FAILS` set `locked_until = now + 15 min * 2^(lockouts)` (cap 24 h); respond `401 UNAUTHENTICATED` with identical message whether locked or wrong ("Invalid credentials or temporarily locked"); add 300-800 ms random delay. Reset counter on success |
| POST `/auth/logout` | none | Revoke current session, clear cookie |
| POST `/auth/logout-all` | none | Revoke all sessions |
| GET `/auth/me` | | `{ "authenticated": true, "telegram_linked": bool, "prefs": {...} }`; 401 if no session |
| POST `/auth/change-password` | `{"current":"","new":""}` | New: min 12 chars, must differ from current; revokes other sessions |

Session sliding: update `last_seen_at` and extend `expires_at` at most once per hour.

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
- `/stocks/{symbol}`: the path segment is percent-decoded once (`M%26M`). In manual price mode `broker_ok` is `null`, `quote` is `null` unless a `quote_latest` row exists, there is no `backfill` block and no job is ever enqueued. `data.hint` ("Import prices.csv for {symbol}") appears only with `no_prices`. An alias answers `{"redirect_symbol":"NEW"}` and has no side effects. `meta`: `as_of` = the last bar date (now when there are no bars), `source` `import`, `stale` = `freshness.prices_stale`, `stale_age_hours` = the lag behind the expected last trading date in hours (0 when fresh).
- Expected last trading date: today (IST) if it is a trading day and the clock is past 18:00 IST (a bar is final only after 18:00 IST, docs/01 section 6.1), else the previous trading day; weekends and `market_holiday` rows (segment `trading`) are skipped. `holidays_missing` is true when `market_holiday` has no row for the current IST year; then `prices_stale` is true only when the last bar is more than 4 calendar days old.
- `fundamentals_as_of` = IST date of `fundamental_meta.last_success`; `shareholding_as_of` = latest `quarter_end`; `predictions_as_of` = latest shown prediction `as_of`; each is `null` when absent.
- `flags.limited_history` is true when the first imported bar is more than 7 days after max(today minus `PRICE_HISTORY_YEARS_TRACKED` years, listing date). `flags.series_warning` is the series code (for example `BE`) when the series is not `EQ`, else `null`; the UI owns the wording.

## 4. Prices and indicators

### GET `/stocks/{symbol}/prices?range=1M|3M|6M|1Y|3Y|5Y|MAX&adjusted=true|false&downsample=auto`
- `range` default 1Y. Max points returned 2,000: if more, server applies LTTB downsampling on `close` (keeping OHLC of the chosen bucket candle aggregation: weekly candles when > 2,000 daily points). `meta.interval` tells `1d` or `1w`.
- Response: `{ "bars": [[date, open, high, low, close, volume], ...], "adjusted": true, "actions": [{"date":"2024-06-12","type":"split","label":"1:2 split"}] }`. Suspect rows excluded.
- `adjusted=true` returns `adj_close` as close and scales open/high/low by the same factor (`adj_close/close`).
- Empty -> `DATA_UNAVAILABLE` with `reason: "backfill_pending"|"broker_unavailable|broker_session_missing"|"no_history"|"no_prices_imported"` (manual mode: `no_prices_imported`).

### DELETE `/stocks/{symbol}/prices?from=YYYY-MM-DD&to=YYYY-MM-DD`
Owner-initiated delete of imported prices for one stock between two dates (inclusive); both required, `from <= to`. Body `{ "confirm": true }` required (the UI shows a ConfirmDialog with the row count from `POST /stocks/{symbol}/prices/delete-preview?from=&to=`, which returns `{ "rows": 120 }`). Writes an audit row (`import_batch` with `kind='manual_form'`, note "deleted prices {symbol} {from}..{to}, {n} rows") and enqueues `post_import` target `batch:<id>` to recompute analytics (and detection) for that symbol. Returns `{ "deleted": 120, "job_id": 14 }`. Shown on the stock's Data tab.

### POST `/prices/trim`
Owner-initiated "Trim history": body `{ "symbols": ["TCS","INFY"], "before": "2021-01-01", "confirm": true }`; deletes `price_daily` rows older than `before` for the chosen stocks (preview via `POST /prices/trim/preview` returning row counts per symbol and estimated MB freed). Audit row and `post_import` as above. Housekeeping never does this automatically (04 3.10).

### GET `/stocks/{symbol}/indicators`
Returns the latest `analysis_snapshot` (see `05-analytics-spec.md`): `{ "as_of": "...", "returns": {...}, "technicals": {...}, "scores": { "trend": {...}, "risk": {...}, "quality": {...} }, "series": { "sma50": [[d,v]...], "sma200":..., "rsi14":..., "macd": {...}, "bollinger": {...} } }`. `series` limited to the last 750 trading days. If the series requested exceeds data, arrays contain nulls at warm-up positions (never fabricated).

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
Fiscal labels per `06-frontend-spec.md` section 3. Missing -> null. All values come from owner-supplied data; `periods_available` counts what the owner has entered/imported, and the response includes `"entry_hint": "Add results via Import or the manual form"` when empty. Derived values (growth, margins, ratios, valuation) are precomputed by the worker (`compute_analysis`) and read from `analysis_snapshot.indicators.fundamentals`; the API does not recompute them.

### GET `/stocks/{symbol}/shareholding`
`{ "quarters": ["2025-12-31", ...], "promoter": [...], "fii": [...], "dii": [...], "mf": [...], "insurance": [...], "govt": [...], "public": [...], "pledged": [...], "qoq_change": { "promoter": 0.12, "fii": -0.3, ... }, "latest_filed_on": "...", "mf_available": true, "note": null }`. If `mf_available=false` (owner did not enter the MF figure), UI shows "DII (includes mutual funds)".

### GET `/stocks/{symbol}/events?from=&to=`
`{ "actions": [ {id, ex_date, record_date, type, ratio_num, ratio_den, amount_per_share, purpose_text} ], "calendar": [ {event_date, type, details} ] }`; default window: actions last 5 years; calendar next 90 days.

### GET `/stocks/{symbol}/peers?limit=8`
Algorithm in analytics spec section 7. Response: `{ "sector": "...", "industry": "...", "peers": [ { "symbol":"", "name":"", "market_cap_cr":0, "ret_1y":0, "pe":0, "pb":0, "roe":0, "rev_growth_3y":0, "op_margin":0, "debt_equity":0, "percentile_rank": {"pe":0.3,...} } ], "self": { ... same fields } }`. Query param `add=SYM1,SYM2` and `remove=SYM3` allow temporary overrides (not persisted).

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

## 7. Live refresh jobs

### POST `/stocks/{symbol}/refresh`
Body none. Behavior: if an active job for `(stock_refresh, SYMBOL)` exists return it (200). Else if last finished job for this target < `REFRESH_COOLDOWN_MIN` ago return `429 RATE_LIMITED` with `details.retry_after_seconds`. Else if global jobs in the last hour >= `REFRESH_GLOBAL_PER_HOUR` -> 429. Else insert `refresh_job(kind='stock_refresh')`, signal worker-http (fire-and-forget HTTPS POST with HMAC; if it fails the row stays `queued` for the next cron), return `202 { "job_id": 12, "status": "queued", "expected_wait_seconds": 90 }`.

### GET `/jobs/{id}`
`{ "id":12, "kind":"stock_refresh", "target":"TCS", "status":"running", "requested_at":"...", "started_at":null, "finished_at":null, "error":null, "result": {"prices_rows":3,"fundamentals":"skipped_cooldown"} }`. UI polls every 3 s for up to 3 minutes, then shows "still waiting; will update automatically at next run".

**Manual price mode (current):** the Refresh button is hidden; `stock_refresh`/`stock_backfill` return `422 PRICE_MODE_MANUAL`. The only job kind created by the API for stocks is `post_import` (target `batch:<id>`, enqueued after a prices commit, a delete-prices or trim action; deduped by the active-job index). `GET /jobs/{id}` for it returns `result: { "symbols_total": 80, "symbols_done": 40, "stage": "detect_actions|compute_analysis|alerts", "remaining": [...] }`; `status` `partial` means more work was re-enqueued (04 3.12).
What `stock_refresh` does (broker mode, inactive): latest quote + last 10 days of daily candles from the broker (requires an active broker session; otherwise job `failed` with `error=broker_session_missing`), then split/bonus detection for that stock. It never fetches fundamentals (those are owner-supplied).
What `stock_backfill` does: full daily-candle history up to `LAZY_BACKFILL_MAX_YEARS` from the broker, then detection; sets `is_tracked=true, tracked_reason='opened'`. In manual price mode both kinds are rejected with `422 PRICE_MODE_MANUAL` (use prices import).

### POST `/mf/schemes/{code}/refresh`
Same pattern, kind `mf_refresh`. Unknown scheme code: `404 NOT_FOUND`; non-numeric or non-positive code: `422` with `details.fields`. Cooldown and global-limit 429s carry `details.retry_after_seconds` (the global one: seconds until the oldest counted request leaves the one-hour window).

## 8. Market and compare

### GET `/market/overview`
`{ "indices": [ {code,name,value,change,change_pct,as_of} ]  /* from `market_series` (reserved prices.csv symbols NIFTY50/INDIAVIX); otherwise empty with reason */, "vix": {...}, "movers": { "gainers": [...top 10 by day change among tracked, min volume filter], "losers": [...] }, "market_status": { "is_open": false, "next_open": "2026-10-12T03:45:00Z", "holiday": null } }`. Market hours 09:15-15:30 IST Mon-Fri excluding `market_holiday` (from `config/market_holidays.json`). There is no FII/DII data in the Safe Edition.

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

## 10. Mutual funds

| Endpoint | Behavior |
|---|---|
| GET `/mf/schemes?q=&category=&plan=direct\|regular&option=growth\|idcw&fund_house=&limit=&cursor=` | Server search over `mf_scheme` (trigram on name). Default filters: `plan=direct`, `option=growth` unless `include_all=true`. Groups variants of the same fund when `group=true` |
| GET `/mf/schemes/{code}` | Meta + latest NAV + return table + risk metrics + `warnings` (IDCW caveat, merged/inactive notice). Sets `last_opened_at`; if no NAV rows, enqueues `mf_refresh` and returns `backfill` info like stocks |
| GET `/mf/schemes/{code}/nav?range=1M\|6M\|1Y\|3Y\|5Y\|MAX&log=false` | `{ "points": [[date, nav]...] }` downsampled to <= 2,000 points |
| GET `/mf/schemes/{code}/sip?amount=&start=&end=&day=` | SIP simulation (analytics spec section 9.4) |
| GET `/mf/compare?codes=a,b,c&range=3Y` | 2-5 schemes; rebased to 100 at first common date; table of returns/vol/drawdown |
| GET `/mf/categories` | Distinct categories for filters |

Return table keys: `r_1m,r_3m,r_6m,r_ytd,r_1y,r_3y,r_5y,r_since` (CAGR for >= 1y; absolute below). `null` when history shorter than the window.

## 11. Watchlist

`GET /watchlist` -> `{ "stocks":[{symbol,name,ltp,change_pct,added_at,note}], "funds":[{code,name,nav,change_pct}] }`. `POST /watchlist` body `{"type":"stock","symbol":"TCS","note":""}` or `{"type":"mf","code":120503}` -> 201; duplicate -> 409. Adding a stock sets `is_tracked=true, tracked_reason='watchlist'` (if not already tracked for another reason); no backfill in manual mode. `DELETE /watchlist/{id}`: unsets tracked unless portfolio, imported prices or the LRU keep it. `PATCH /watchlist/{id}` updates note (max 500 chars).

## 12. Portfolio (stocks only in v1)

- `GET /portfolio/txns?symbol=&limit=&cursor=`; `POST /portfolio/txns` body:
```json
{ "symbol": "TCS", "side": "buy", "qty": "10", "price": "3500.00", "fees": "20.00", "trade_date": "2026-09-01", "note": "" }
```
Validation: symbol must resolve to an instrument; `qty` 0 < qty <= 1e9 (up to 4 decimals; whole numbers recommended); `price` > 0; `fees` >= 0; `trade_date` not in the future (IST) and not before the instrument's `listing_date`; trade_date must not be a weekend or listed holiday (warning only, not an error); a **sell must not exceed the held quantity at that date** (computed with adjustments) -> 422 `INSUFFICIENT_HOLDINGS`. PATCH/DELETE re-validate the whole sequence for that symbol (reject any edit that would make a later sell exceed holdings).
- Side effects: set `is_tracked=true, tracked_reason='portfolio'` (no backfill in manual mode).
- `GET /portfolio/summary?as_of=` -> holdings, totals, XIRR, realized P&L (FIFO), unrealized (average-cost basis), day change, allocation by stock and sector, benchmark comparison. Detailed math in analytics spec section 8. Money fields are strings. Holdings include `adjustments_applied: [ {date, type, multiplier} ]`.
- `GET /portfolio/adjustments` and `POST /portfolio/adjustments` (override) as per `portfolio_adjustment`.

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
- `POST /telegram/link-code` -> `{ "code":"A7K9-Q2XM", "expires_at":"...", "bot_username":"..." , "deep_link":"https://t.me/<bot>?start=<code>" }`; code = 8 chars from an unambiguous alphabet, stored as sha256, valid 15 min, one use. `DELETE /telegram/link` clears chat id. `POST /telegram/test` sends a test message (rate limited 1/min). `POST /telegram/webhook` as in data-sources section 8.

Implementation notes (B12):
- `POST /alerts` answers 201 with the alert `{id, target:{type,symbol|code,name}, kind, params, status, one_shot, cooldown_minutes, expires_on, last_fired_at, created_at}`. Defaults: `one_shot` true, `cooldown_minutes` 1440. `expires_on` must be today (IST) or later. Every `params` key of the kind is required (no silent defaults); unknown keys, numeric strings and fractional integers are 422 with `details.fields[].field = "params.<key>"`. `nav_*` kinds need a `mf` target (`{"type":"mf","code":120503}`), all other kinds a `stock` target; a kind/target mismatch is a 422 on `target.type`; an unknown symbol or scheme is 404 `NOT_FOUND`; a renamed symbol resolves through `symbol_alias`.
- `THRESHOLD_ALREADY_MET` (422, code `THRESHOLD_ALREADY_MET`, `details: {kind, threshold, value, as_of}`) applies to `price_above/below` (last non-suspect imported bar close) and `nav_above/below` (latest imported NAV), on create and when PATCH changes params. With no bar or NAV yet the alert is accepted.
- Limit: 200 alerts with `status='active'`; the 201st create, or resuming a paused alert into a full set, is 409 `CONFLICT`. Paused, fired and expired alerts do not count.
- `GET /alerts?status=active|paused|fired|expired&limit=&cursor=` and `GET /alerts/events?limit=&cursor=` return `{"items":[...],"next_cursor":null|string}`, newest first. An event item is `{id, alert_id, kind, target, fired_at, payload, delivery_status, delivery_attempts, delivered_at, last_error}`.
- `PATCH /alerts/{id}` takes `{status: "active"|"paused", params}` (at least one; any other key is 400). A params change clears `alert.last_state`. A fired or expired alert is final: 409. `DELETE` answers `{"data":{"ok":true}}`; a missing id is 404.
- `POST /telegram/link-code` answers 200 `{code, expires_at, bot_username, deep_link}`; `bot_username` and `deep_link` are null with warning `BOT_NOT_CONFIGURED` while `TELEGRAM_BOT_USERNAME` is unset. `DELETE /telegram/link` and `POST /telegram/test` answer `{"data":{"ok":true}}`; the test message is 409 when no chat is linked, 429 (`Retry-After`) within 60 s of the previous one, and 503 `SOURCE_DOWN` when no bot token is configured or Telegram refuses.
- `POST /telegram/webhook`: header `X-Telegram-Bot-Api-Secret-Token` compared in constant time with `TELEGRAM_WEBHOOK_SECRET`; missing, wrong or unconfigured secret is 401 and nothing is read or stored. Body limit 64 KiB. Only `/start <code>` (also `/start@<bot> <code>`) in a **private** chat is acted on: the code (case-insensitive, dash optional) is consumed atomically and the chat id stored, and the chat gets a fixed confirmation or "invalid, expired or already used" reply. Everything else (other commands, text, groups, channels, edits, callbacks, malformed JSON) is acknowledged with 200 and ignored, with no reply. The webhook needs no `X-Requested-With`.

## 14. Imports and owner-entered data

All files go through **validate -> preview -> commit**. Formats, columns and rules are in `01-data-sources.md` section 7.

| Endpoint | Behavior |
|---|---|
| POST `/imports/{kind}/validate` | multipart `file` (<= 5 MB and 50,000 rows; **`prices`: 25 MB / 300,000 rows**, enabled only after S9 passes, until then the lower limit applies). `kind` in `prices`, `instruments`, `holidays`, `results_quarterly`, `results_annual`, `balance_cashflow`, `fundamentals_long`, `shareholding`, `corporate_actions`, `instrument_meta`. (`screener_xlsx` is not built: D-5.) Parsed as a stream. Returns `{ "upload_id":"uuid", "upload_group":null, "rows": 120, "preview": [first 20 normalized rows], "errors": [{"row":5,"column":"period_end","message":"..."}], "warnings": [...], "estimated_growth_mb": 3.2, "prices_already_adjusted": null }` (`estimated_growth_mb` and `prices_already_adjusted` for `prices`; `null` = the owner has not yet chosen, the wizard must show the required raw / already adjusted / I don't know choice). Nothing is written. The validated file is stored in the `import_upload` table, 1 h TTL, so it survives an API restart |
| POST `/imports/{kind}/commit` | body `{ "upload_id":"uuid", "note":"as per filing dated 2026-08-12" }` (or `{ "upload_ids":[...], "upload_group":"uuid" }` when the browser split a large prices file; all parts commit in **one** transaction). Rejected with 422 if the upload has any errors, for `prices` with `422 PRICES_ADJUSTMENT_UNSET` while `PRICES_ALREADY_ADJUSTED` is unset, and for `prices` with `422 DB_SIZE_LIMIT` if current DB size + estimated growth would exceed `DB_SOFT_LIMIT_MB` (also rejected whenever the DB is already at the limit). Inserts in chunks of 5,000 rows inside one transaction (any error rolls back everything); deletes the `import_upload` row; returns `{ "batch_id": 7, "inserted": 100, "updated": 20, "post_import_job_id": 14, "warnings": ["TRACKED_OVER_400"] }`. Prices commits mark symbols `is_tracked` (`imported`) and enqueue `post_import` |
| GET `/imports/batches?limit=` | List `import_batch` rows |
| POST `/imports/batches/{id}/undo` | Allowed within 30 days for non-price, non-instruments batches; returns counts; 409 if already undone or if kind is `prices` or `instruments` |
| GET `/imports/templates/{kind}` | Downloads the CSV template with the header row and one example row (includes `instruments`) |
| GET `/settings/prices-adjustment` | `{ "value": null|true|false, "set_at": "..." }` |
| PUT `/settings/prices-adjustment` | body `{ "value": true|false }` (`false` = raw, `true` = already adjusted). Used by the wizard choice; "I don't know" calls nothing. Changing an already-set value requires `{ "confirm": true }` and shows the mixing warning (existing bars keep their own `src_adjusted`) |
| POST `/imports/prices/adjustment-check` | body `{ "upload_id":"uuid", "symbol":"TCS", "ex_date":"2024-06-12", "expected_ratio": {"num":1,"den":2} (optional) }` -> `{ "bars": [[date, close], ... up to 5 trading days each side, from the uploaded file], "ratio": 0.5003, "nearest_fraction": "1/2"|null, "hint": "raw_likely|adjusted_likely|inconclusive" }`. Reads only the validated upload; writes nothing |
| POST `/instruments` | Manual **Add stock**: body `{ "symbol":"TCS", "name":"Tata Consultancy Services Ltd", "isin":"INE467B01029" }` (isin optional; same validators as `instruments.csv`, malformed ISIN = warning). 201 `{ "id": 1, "symbol":"TCS", "warnings":[] }`; existing symbol -> 409 (use the CSV to update) |
| POST `/stocks/{symbol}/results` | Single-period manual entry (quarterly or annual) with the same validators; body `{ "basis":"consolidated","period_type":"Q","period_end":"2026-09-30","values": {"revenue": 1234.5, ...}, "note":"" }` |
| POST `/stocks/{symbol}/shareholding` | Manual shareholding quarter entry |
| POST `/stocks/{symbol}/actions` | Manual corporate action entry (status `confirmed`) |
| PATCH `/stocks/{symbol}/actions/{id}` | Body `{ "status": "confirmed|rejected" }` for **detected** actions; confirm triggers history re-adjustment (job) and analytics recompute |
| DELETE `/stocks/{symbol}/results?period_type=&period_end=&basis=` | Remove a manual period |

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

`GET /admin/status` -> `{ "sources": [source_health rows], "jobs": [latest ingestion_run per job], "coverage": { "instruments": 2231, "tracked": 612, "with_prices": 598, "with_fundamentals": 410, "with_shareholding": 401 }, "db": { "size_mb": 210, "tables": [ {name, mb, rows} ], "warn_level": "ok|70|85|95|limit" }, "holiday_list_missing_years": [2026], "version": "git sha", "storage_policy": {...}` . `GET /healthz` -> `{ "ok": true }` (no DB call; also served at the root path `/healthz` for the hosting health check). `GET /readyz` (auth) -> DB ping.

## 16. Rate limits and security headers
- Per-IP login: 10/min. Authenticated general: 120/min. Refresh endpoints: as above. Return `X-RateLimit-*` headers (optional).
- Headers on every response: `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `Cache-Control: no-store` (except `/stocks/index`), `Content-Security-Policy` set at the Next.js layer.
- Log lines never contain passwords, cookies, tokens, or full request bodies.
