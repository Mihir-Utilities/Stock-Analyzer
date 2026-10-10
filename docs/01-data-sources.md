# 01. Data Sources Specification (Safe Edition)

Legend: **V** verified from documentation; **U** unverified, resolved by a spike in `08-phase0-spikes.md` (do not build on it before the spike has a GO verdict). Rate numbers are our own conservative defaults, not vendor-published limits.

Read `00-legal-and-safety.md` first. Anything not listed in section 2 as ALLOWED must not be implemented.

---

## 1. Global rules for every adapter and importer

1. Adapters live only in `apps/worker/adapters/` (Python) and `apps/api/internal/importers/` (Go, file parsing). No network code elsewhere.
2. HTTP client: connect timeout 10 s, read 30 s, total 60 s; `User-Agent: IndiaAnalyzerPersonal/1.0`.
3. Retries: up to 3 on network errors, 5xx, 429. Backoff `min(60, 2^attempt + random(0,1))` s; honour `Retry-After`.
4. Throttle per source (`*_MIN_INTERVAL_SEC` in `app_setting`), process-wide limiter with +/-20% jitter.
5. Circuit breaker per source in `source_health`: 5 consecutive failures -> `disabled_until = now + 30 min` (then 2 h, then 12 h); reset after 3 successes. While open: raise `SourceDisabled` immediately.
6. All responses and uploaded files are schema-validated (pydantic in Python, explicit structs in Go). Invalid rows are rejected and counted; **never** write partially validated rows.
7. Record redacted fixtures (`/fixtures/<source>/...`) with `--record-fixtures`; tests run only on fixtures (no live network in tests).
8. Store `source` and `fetched_at` with every datum. Never mix sources inside one series without a visible label.
9. Secrets only from environment variables. Tokens encrypted at rest. Never logged.

## 2. Source inventory

| Source | Status | Use |
|---|---|---|
| mfapi.in | ALLOWED (open API, no auth) | MF scheme list, NAV history |
| AMFI `NAVAll.txt` | ALLOWED (public NAV publication; check terms in S14) | MF metadata, fallback latest NAV |
| Owner's broker API (one of Angel One SmartAPI, Fyers, Upstox, Dhan; chosen in spike S1) | ALLOWED with owner's own account, OAuth, read-only scope | Instrument master, daily candles, quotes, index candles |
| Telegram Bot API | ALLOWED | Alerts |
| Owner-supplied CSV/forms | ALLOWED (owner's responsibility) | Prices (if no broker), fundamentals, shareholding, corporate actions, sector/index tags |
| Optional Screener Excel (owner's own export) | OFF by default (`SCREENER_IMPORT_ENABLED=false`); gray area under Screener's terms | Fundamentals backfill |
| NSE/BSE websites or endpoints, nsepython, Yahoo/yfinance, Screener scraping, news scraping | **FORBIDDEN** | n/a |

## 3. Broker adapter (stocks)

### 3.1 Candidate brokers (choose exactly one in spike S1; implement behind the interface)
Angel One SmartAPI, Fyers API, Upstox API, DhanHQ. Third-party comparisons describe all four as free for account holders; Kite Connect's data plan is paid and is excluded. For each candidate S1 records: official terms on data use/storage, auth flow (OAuth redirect or other), **token lifetime**, whether **data-only** calls need a static IP, rate limits, daily-candle depth per request and overall, instrument master format/URL, index and India VIX availability, whether daily candles are split-adjusted, cost (must be 0). Selection rubric: all hard requirements met (free; read-only data scope; OAuth the owner performs personally; no static IP needed for data, or owner has one); then longest token lifetime; then deepest daily history; then simplest API.

### 3.2 Interface (Python Protocol)
```python
class BrokerSource(Protocol):
    name: str
    def auth_url(self, state: str, redirect_uri: str) -> str: ...
    async def exchange_code(self, code: str, redirect_uri: str) -> TokenBundle: ...   # used by Go API equivalent; see 3.4
    async def instrument_master(self) -> list[InstrumentRow]: ...
    async def daily_candles(self, key: str, start: date, end: date) -> list[Bar]: ...  # chunked internally to the broker's per-request limit
    async def quotes(self, keys: list[str]) -> dict[str, Quote]: ...
    async def index_candles(self, code: str, start: date, end: date) -> list[Bar]: ...  # NIFTY50, INDIAVIX if available
```
Internal types: `Bar(date, open, high, low, close, volume)`, `Quote(ts, ltp, prev_close, open, high, low, volume, wk52_high?, wk52_low?)`. All broker-specific field mapping lives in the adapter. Raise typed errors: `SessionExpired`, `SourceDisabled`, `RateLimited`, `SchemaError`, `NotFound`.

### 3.3 Instrument master
- Download the broker's published instrument file (official, intended for API users; location per broker, U). Filter exchange = NSE, segment = equity cash, series in (EQ, BE, BZ, SM, ST...) -> `instrument`. Map: `symbol`, `name`, `isin`, `series`, `broker_key`, `lot size` ignored.
- Validation: >= 1,500 equity rows; contains `RELIANCE`, `TCS`, `INFY` (abort run otherwise, keep old data).
- Change detection per daily run: same as before: missing symbol for 3 consecutive runs -> `delisted`; same ISIN new symbol -> `symbol_alias`; name change -> update; series change -> update + warning chip.
- Index instruments (Nifty 50, India VIX etc.) come from the same file if listed (U).
- Sector/industry/index tags: not in the master. They come only from the owner's `instrument_meta` CSV import (section 7.5). Until imported they are null and peers/screener sector filters show "not available; import sector data".

### 3.4 OAuth and token handling
- Owner flow: Settings -> "Connect broker" -> `GET /api/v1/broker/login` returns the broker authorize URL (with `state` stored 10 min) -> owner logs in at the broker (their own 2FA) -> broker redirects to `GET /api/v1/broker/callback?code=...&state=...` on the Go API -> API exchanges the code with the broker (using the app's client id/secret from env) and stores the token encrypted in `broker_session` -> redirects to `/settings?broker=connected`.
- Storage: AES-256-GCM, 32-byte key from env `BROKER_TOKEN_KEY` (API and worker both hold it). Columns: `broker`, `token_enc`, `issued_at`, `expires_at` (from broker response; if absent assume next 03:30 IST, U), `status`.
- Daily workflow: after expiry, jobs that need the broker skip with reason `broker_session_missing` and send **one** Telegram reminder (08:30 IST weekdays if the token will not cover 18:30 IST, and again at 17:30 IST if still missing): "Broker session expired. Open the app to reconnect." The UI shows a prominent "Reconnect" banner.
- Never automate the owner's login (no stored passwords, no TOTP secrets, no headless login). Never request order-capable scopes if the broker allows read-only; never call order endpoints.
- If `BROKER_ENABLED=false` (owner has no broker account) the app runs in **manual price mode** (section 7.1).

### 3.5 Daily candles
- Request in chunks no larger than the broker's per-request limit (U per broker; e.g., a daily-interval request may cap at about a year). Backfill loops chunk by chunk until `LAZY_BACKFILL_MAX_YEARS` or the broker returns empty.
- Dates: store the market date in IST. Drop weekend rows. Drop rows with `close <= 0`.
- Sanity rules (row stored with `suspect=true` if violated and excluded from analytics): OHLC <= 0; `high < max(open, close, low)` or `low > min(open, close, high)` beyond 1e-6; `volume < 0`; day-over-day close change > 50% **and** no confirmed corporate action within +/-1 trading day (this also triggers split/bonus detection, 3.7).
- Partial bar: only persist today's bar if run time is after 18:00 IST and the bar is final per the broker (U); otherwise skip today.
- Throttle default: 2 requests/second max (U: broker documented limits; set lower of that and our default).

### 3.6 Quotes
`quotes()` for up to N keys per call (U). Used for `quote_latest` (watchlist/portfolio/alert stocks only). During market hours the broker feed may be delayed or real-time (U). UI shows `quote_ts` age always.

### 3.7 Adjustment policy (decision; confirm with spike S4)
- Config `BROKER_PRICES_ADJUSTED` (true/false), set from spike S4.
- If **false** (raw prices): `price_daily.close` = raw close; `adj_close` = raw close x cumulative factor from **confirmed** split/bonus actions after that date (dividends are not adjusted; returns are price returns, stated in the UI).
- If **true**: `adj_close = close`; actions are still stored for portfolio math.
- **Detection:** for each stock nightly, flag day t when `|C_t/C_{t-1} - 1| > 0.35` and the ratio `r = C_t/C_{t-1}` is within 3% of one of: 1/2, 1/3, 1/4, 1/5, 1/10, 1/20, 2/3, 3/4, 4/5, 5/6, and volume is > 1.5x its 20-day average. Insert `corporate_action(status='detected', action_type='split_or_bonus', ratio_num/den from the matched fraction)`. Detected actions are **not** applied until the owner confirms; the stock page shows a banner "Possible split/bonus on {date}: price changed {x}%. Confirm to adjust history" with Confirm / Reject. While unconfirmed, analytics set `warnings=['UNCONFIRMED_ACTION']` and ML is hidden for that stock.
- On confirmation: write `adj_close` factors (re-computation job), recompute analytics.
- This heuristic cannot see small splits/bonus (ratio between 0.65 and 1) or rights/demergers; owners can add those manually.

## 4. mfapi.in (V)
- Base `https://api.mfapi.in`. Endpoints: `GET /mf?limit=&offset=` (list, paginate), `GET /mf/search?q=`, `GET /mf/{code}` (full history), `GET /mf/{code}?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD`, `GET /mf/{code}/latest`.
- Response `{"meta":{fund_house, scheme_type, scheme_category, scheme_code, scheme_name, isin_growth, isin_div_reinvestment},"data":[{"date":"DD-MM-YYYY","nav":"123.45"}],"status":"SUCCESS"}`. Order of `data` U: always sort ascending after parsing. Parse date `%d-%m-%Y`; `nav` string -> float; skip non-numeric or <= 0.
- `plan`, `option_type` derived from the scheme name (Direct/Regular; Growth/IDCW or Dividend); else `unknown`.
- Updates 3x daily (2:05 PM, 9:05 PM, 3:09 AM IST, V). Ingest at 22:00 and 04:00 IST. Cache aggressively; increments via `startDate`. Statements about rate limits are contradictory (V): keep `MFAPI_MIN_INTERVAL_SEC=0.5` and back off on 429.
- Attribution in UI: "NAV data: AMFI via mfapi.in".

## 5. AMFI NAVAll.txt (format V; availability U)
- URL `https://www.amfiindia.com/spages/NAVAll.txt`. Header `Scheme Code;ISIN Div Payout/ISIN Growth;ISIN Div Reinvestment;Scheme Name;Net Asset Value;Date`; section lines for scheme type and AMC name; data rows have 6 `;`-separated fields with a numeric code. State machine: blank line then a no-`;` line = section header; remember the latest (scheme type, AMC). NAV `N.A.`/`-` skipped; date `DD-Mon-YYYY`.
- Use: weekly enrichment of `mf_scheme` (fund house, type/category) and fallback latest NAV when mfapi fails. One download per run; no historical report scraping.

## 6. Telegram Bot API (V)
`sendMessage(chat_id, text, parse_mode=HTML, disable_web_page_preview=true)`. Webhook via `setWebhook(url, secret_token)`; header `X-Telegram-Bot-Api-Secret-Token`. Webhook and getUpdates are mutually exclusive; updates are retained at most 24 h. Flow: API route `POST /api/v1/telegram/webhook` (public, secret-header authenticated, constant-time compare) handles `/start <code>` only: look up unexpired unused code -> store `chat_id`; ignore every other chat. Worker sends alert messages sequentially with 1.1 s spacing (our default; Telegram's documented per-chat guidance is about 1 message/second, U), digest when > 10 events in a run. Escape `& < >` in dynamic text.

## 7. Owner-supplied data (CSV templates, forms, imports)

All imports are handled by the Go API (`apps/api/internal/importers`). Flow for every file: **upload -> validate -> preview (first 20 rows + error list) -> confirm -> commit in one transaction -> `import_batch` audit row**. Re-uploading the same file is idempotent (upsert by natural key). Each non-price batch can be undone within 30 days (rows tagged with the batch id are deleted; values that the batch overwrote are NOT restored, so the UI warns before undo). `prices.csv` batches cannot be undone (re-import corrected data instead). Max file size 5 MB, 50,000 rows. UTF-8 (BOM allowed), comma or semicolon auto-detect, dates `YYYY-MM-DD` or `DD-MM-YYYY` or `DD-Mon-YYYY` (parsed unambiguously; `MM-DD-YYYY` is rejected). Numbers accept `1,234.56` (commas stripped) but reject `1.234,56` ambiguity (error). Empty cell = NULL (not zero).

### 7.1 `prices.csv` (manual price mode or gap filling)
Columns: `symbol,date,open,high,low,close,volume`. Rules: symbol must exist (else row error "unknown symbol" with suggestion); `open/high/low/close > 0`; `high >= low`; volume integer >= 0; not future; sanity rules of 3.5; upsert on `(instrument, date)`; `source='import'`. Optional "NSE bhavcopy" column mapper is **not** built unless the owner supplies a sample file and confirms they downloaded it personally (S13).

### 7.2 Fundamentals: wide template `results_quarterly.csv` / `results_annual.csv`
Columns: `symbol,basis,period_end,revenue,ebitda,operating_income,other_income,interest,depreciation,pbt,tax,net_profit,eps` (units: INR crore except EPS in INR). Optional balance/cash-flow template `balance_cashflow_annual.csv`: `symbol,basis,period_end,total_assets,total_liabilities,equity,borrowings,current_liabilities,cash,shares_outstanding,cfo,cfi,cff,capex`. Long format `fundamentals_long.csv`: `symbol,basis,period_type,period_end,metric_key,value,unit` (keys from `05-analytics-spec.md` section 2).
Validation: `basis` in consolidated/standalone; quarterly `period_end` must be a calendar quarter end (31 Mar/30 Jun/30 Sep/31 Dec) else error; annual `period_end` should be 31 Mar (other dates allowed with a warning); not in the future; `net_profit` magnitude <= `revenue` x 2 else warning ("check units"); revenue < 1e7 crore else error; EPS within +/-1e5; `shares_outstanding` > 0; `pbt - tax` vs `net_profit` mismatch > 15% -> warning (minority interest/exceptional items). Source `csv_import`.

### 7.3 `shareholding.csv`
Columns: `symbol,quarter_end,promoter,fii,dii,mf,insurance,govt,public,pledged_of_promoter,shareholders_count,filed_on`. Rules: percentages 0-100; `promoter+fii+dii+govt+public` within 100 +/- 1.0 when all present (error otherwise; `mf` and `insurance` are components of `dii` and must satisfy `mf+insurance <= dii + 0.5`); quarter_end is a quarter end; `pledged_of_promoter` blank = unknown.

### 7.4 `corporate_actions.csv`
Columns: `symbol,ex_date,type,ratio_num,ratio_den,amount_per_share,purpose_text`. `type` in split/bonus/dividend/rights/buyback/merger/demerger/other. For `split`: `ratio_num` = old face value, `ratio_den` = new face value (e.g., 10 and 2). For `bonus`: `ratio_num` = new shares, `ratio_den` = held shares (1:1 means one new for one held). Confirmed on import (`status='confirmed'`). Manual entry form mirrors this.

### 7.5 `instrument_meta.csv`
Columns: `symbol,sector,industry,company_type,index_tags`. `company_type` in general/financial; `index_tags` pipe-separated (e.g., `NIFTY50|NIFTY100`). Updates `instrument.sector/industry/company_type` and `index_constituent`. The owner may build it from official index publications they download personally.

### 7.6 Manual forms (UI) 
Equivalents of 7.2-7.4 for single entries (quarterly results, annual results, shareholding quarter, corporate action) with the same validators, unit hints, and an "as per company filing dated ..." note field stored in `import_batch.note`.

### 7.7 Optional Screener Excel (disabled unless `SCREENER_IMPORT_ENABLED=true`)
Only if the owner enables it after reading Screener's terms (restricts copying/mirroring). Parser mapped from owner-provided sample files (S13). Source `screener_import`. UI shows a persistent notice. Never fetch pages from Screener.

## 8. Static files maintained by the owner/Claude Code
- `config/market_holidays.json`: `{ "2026": [ {"date":"2026-01-26","description":"Republic Day"}, ... ] }`. Updated yearly from the exchange's published holiday circular (read by a human). Fallback if missing: weekends only, plus "no candle returned by the broker" detection (a weekday with no candles for > 90% of tracked stocks is treated as a holiday and recorded in `market_holiday` with `description='detected'`).
- `config/financial_industry_patterns.json`: patterns marking `company_type='financial'` (bank, NBFC, insurance, housing finance, asset management, capital markets).

## 9. Research links (no data fetched)
The stock page shows plain hyperlinks (opened by the owner in a new tab; `rel="noopener noreferrer"`): NSE quote page, BSE quote page (needs BSE code only if known), company investor-relations search, Google search for "{name} results", TradingView symbol page, Screener company page, Moneycontrol search. Templates in `config/research_links.json` with `{symbol}` and `{name}` placeholders (URL-encoded). The app never requests these URLs from the server or the browser (no iframes, no previews).

## 10. Adapter interfaces and error handling summary
- `BrokerSource` (3.2), `MFSource` (`search`, `nav_history`, `latest_navs`), `TelegramSender`.
- Importers (Go): `ParsePricesCSV`, `ParseResultsCSV`, `ParseBalanceCashflowCSV`, `ParseFundamentalsLong`, `ParseShareholdingCSV`, `ParseActionsCSV`, `ParseInstrumentMetaCSV`, each returning `{rows, errors[], warnings[]}`.
- Jobs catch typed errors and apply the fallback matrix:

| Failure | Behavior |
|---|---|
| Broker session expired | Skip broker jobs; Telegram reminder; UI banner; data shown as stale |
| Broker rate-limited/down | Backoff/circuit breaker; stale chip; manual price upload still possible |
| mfapi down | AMFI latest NAV fallback; history from DB with stale chip |
| AMFI down | mfapi only |
| Import validation failure | Reject whole file with exact row/column errors; nothing written |
| Detected split not confirmed | Banner + analytics warning; ML hidden for that stock |
