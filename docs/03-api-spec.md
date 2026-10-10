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
Codes: `BAD_REQUEST` 400, `UNAUTHENTICATED` 401, `FORBIDDEN` 403, `NOT_FOUND` 404, `CONFLICT` 409, `UNPROCESSABLE` 422 (validation, with `details.fields[]`), `RATE_LIMITED` 429 (with `Retry-After`), `DATA_UNAVAILABLE` 404 (valid target, no data yet; details: `reason`), `SOURCE_DOWN` 503, `INTERNAL` 500.
- Auth: cookie `session` (httpOnly, Secure, SameSite=Lax, path `/`). All routes need it except `GET /healthz`, `POST /auth/login`, `POST /telegram/webhook`.
- CSRF: all non-GET requests must include header `X-Requested-With: fetch` (browsers cannot add it cross-site without CORS preflight; we send no CORS headers).
- Pagination: cursor-based `?limit=&cursor=`; `limit` default 50, max 200; response `{"items":[...],"next_cursor":null|string}`.
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
  "freshness": { "prices_as_of": "2026-10-09", "fundamentals_as_of": "2026-08-20", "shareholding_as_of": "2026-06-30", "predictions_as_of": "2026-10-09" },
  "flags": { "no_prices": false, "limited_history": false, "series_warning": null }
} }
```
Side effect: sets `last_opened_at = now()`; if the stock is not tracked, sets `is_tracked=true, tracked_reason='opened'` (the API owns the tracked set; there is no `sync_instruments`). In **manual price mode** (current) there is no backfill and the response carries `"price_mode": "manual"`, `freshness.prices_as_of` (last imported bar) and, when `no_prices`, a hint "Import prices.csv for {symbol}". In broker mode (inactive, D-1): if `no_prices` and the broker session is active and `broker_ok != false`, the response includes `"backfill": { "status": "queued|running|none", "job_id": 5 }` and the API enqueues a `stock_backfill` job (section 7).
When no instruments exist, `GET /stocks` and `/stocks/index` return an empty list (`count: 0`); the UI shows "No stocks yet. Import instruments.csv or add a stock."

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
Same pattern, kind `mf_refresh`.

## 8. Market and compare

### GET `/market/overview`
`{ "indices": [ {code,name,value,change,change_pct,as_of} ]  /* only indices the broker serves; otherwise empty with reason */, "vix": {...}, "movers": { "gainers": [...top 10 by day change among tracked, min volume filter], "losers": [...] }, "market_status": { "is_open": false, "next_open": "2026-10-12T03:45:00Z", "holiday": null } }`. Market hours 09:15-15:30 IST Mon-Fri excluding `market_holiday` (from `config/market_holidays.json`). There is no FII/DII data in the Safe Edition.

### GET `/market/holidays?year=`
List from `market_holiday` (trading).

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
- Saved screens: `GET/POST/DELETE /screener/saved` storing `{name, spec}` in `app_setting` key `saved_screens` (max 30).
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

## 14. Imports and owner-entered data

All files go through **validate -> preview -> commit**. Formats, columns and rules are in `01-data-sources.md` section 7.

| Endpoint | Behavior |
|---|---|
| POST `/imports/{kind}/validate` | multipart `file` (<= 5 MB and 50,000 rows; **`prices`: 25 MB / 300,000 rows**, enabled only after S9 passes, until then the lower limit applies). `kind` in `prices`, `instruments`, `results_quarterly`, `results_annual`, `balance_cashflow`, `fundamentals_long`, `shareholding`, `corporate_actions`, `instrument_meta`. (`screener_xlsx` is not built: D-5.) Parsed as a stream. Returns `{ "upload_id":"uuid", "upload_group":null, "rows": 120, "preview": [first 20 normalized rows], "errors": [{"row":5,"column":"period_end","message":"..."}], "warnings": [...], "estimated_growth_mb": 3.2 }` (`estimated_growth_mb` for `prices`). Nothing is written. The validated file is stored in the `import_upload` table, 1 h TTL, so it survives an API restart |
| POST `/imports/{kind}/commit` | body `{ "upload_id":"uuid", "note":"as per filing dated 2026-08-12" }` (or `{ "upload_ids":[...], "upload_group":"uuid" }` when the browser split a large prices file; all parts commit in **one** transaction). Rejected with 422 if the upload has any errors, and for `prices` with `422 DB_SIZE_LIMIT` if current DB size + estimated growth would exceed `DB_SOFT_LIMIT_MB` (also rejected whenever the DB is already at the limit). Inserts in chunks of 5,000 rows inside one transaction (any error rolls back everything); deletes the `import_upload` row; returns `{ "batch_id": 7, "inserted": 100, "updated": 20, "post_import_job_id": 14, "warnings": ["TRACKED_OVER_400"] }`. Prices commits mark symbols `is_tracked` (`imported`) and enqueue `post_import` |
| GET `/imports/batches?limit=` | List `import_batch` rows |
| POST `/imports/batches/{id}/undo` | Allowed within 30 days for non-price, non-instruments batches; returns counts; 409 if already undone or if kind is `prices` or `instruments` |
| GET `/imports/templates/{kind}` | Downloads the CSV template with the header row and one example row (includes `instruments`) |
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

`GET /admin/status` -> `{ "sources": [source_health rows], "jobs": [latest ingestion_run per job], "coverage": { "instruments": 2231, "tracked": 612, "with_prices": 598, "with_fundamentals": 410, "with_shareholding": 401 }, "db": { "size_mb": 210, "tables": [ {name, mb, rows} ], "warn_level": "ok|70|85|95|limit" }, "version": "git sha", "storage_policy": {...}` . `GET /healthz` -> `{ "ok": true }` (no DB call). `GET /readyz` (auth) -> DB ping.

## 16. Rate limits and security headers
- Per-IP login: 10/min. Authenticated general: 120/min. Refresh endpoints: as above. Return `X-RateLimit-*` headers (optional).
- Headers on every response: `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `Cache-Control: no-store` (except `/stocks/index`), `Content-Security-Policy` set at the Next.js layer.
- Log lines never contain passwords, cookies, tokens, or full request bodies.
