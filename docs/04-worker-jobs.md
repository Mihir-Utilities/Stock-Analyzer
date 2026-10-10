# 04. Worker Jobs Specification (Safe Edition)

One Python package `apps/worker`:
- CLI: `python -m worker run <job> [--symbols A,B] [--dry-run] [--record-fixtures]` (GitHub Actions or a home machine).
- HTTP: `uvicorn worker.http:app` on Render free (on-demand jobs only: `stock_refresh`, `stock_backfill`, `mf_refresh`).

Allowed data sources: broker API (owner session), mfapi.in, AMFI file, Telegram. Nothing else (`00-legal-and-safety.md`).

## 1. Common rules
1. **Lock:** insert `ingestion_run(status='running')`; the partial unique index allows one running instance per job; a conflict exits as `skipped`. A run older than 2x its timeout may be marked `failed` by the next run.
2. **Idempotent:** upserts by natural key; re-running never duplicates.
3. **Timeout:** hard per-job timeout below; on timeout finish the current item, write progress, mark `partial`.
4. **Per-item isolation:** one symbol failing never fails the run; keep the first 50 errors in `details`.
5. **Market date:** expected last trading date from `config/market_holidays.json` + weekends (+ detected holidays). Never infer from the server date alone.
6. **Source health + circuit breaker:** per `01-data-sources.md` section 1.
7. **Owner notifications:** a job failing or `partial` with > 20% items failed twice in a row triggers one Telegram message per 24 h per job. Broker session problems have their own reminder rules (job 3.3).
8. **GitHub Actions:** each workflow uses `concurrency: { group: <job-group>, cancel-in-progress: false }`, pins actions by SHA, never prints secrets.
9. **Dry run:** fetch/parse/validate and print a summary; write nothing.
10. **Safe Edition guard:** a unit test asserts that no module under `apps/worker` imports `yfinance`, `nsepython`, `bs4` against financial sites, or contains hostnames of forbidden sources (a deny-list test).

## 2. Schedules (GitHub cron is UTC; IST = UTC+5:30; cron is best-effort and may be late)

| Job | IST | Cron (UTC) | Timeout |
|---|---|---|---|
| `sync_instruments` | 07:00 daily | `30 1 * * *` | 10 min |
| `broker_session_check` | 08:30 and 17:30 Mon-Fri | `0 3 * * 1-5` and `0 12 * * 1-5` | 2 min |
| `ingest_prices_eod` | 18:30 Mon-Fri | `0 13 * * 1-5` | 40 min (then chains `detect_actions`, `compute_analysis`, `predict`) |
| `price_completeness_retry` | 20:30 Mon-Fri | `0 15 * * 1-5` | 20 min |
| `ingest_mf_navs` | 22:00 and 04:00 daily | `30 16 * * *` and `30 22 * * *` | 30 min |
| `sync_mf_schemes` | Sun 05:00 | `30 23 * * 6` | 20 min |
| `evaluate_alerts` (intraday) | every 15 min 09:30-15:30 Mon-Fri | `*/15 4-9 * * 1-5` and `0 10 * * 1-5` | 8 min (private repo mode: every 30 min) |
| `evaluate_alerts` (EOD) | 19:30 Mon-Fri | `0 14 * * 1-5` | 8 min |
| `train_models` | Sat 11:00 | `30 5 * * 6` | 90 min |
| `housekeeping` | Sun 12:00 | `30 6 * * 0` | 20 min |
| `backup_user_data` | Sun 12:30 | `0 7 * * 0` | 10 min |
| `keepalive` | monthly | `0 0 1 * *` | 2 min (empty commit to branch `heartbeat`; avoids auto-disabled schedules in public repos) |

Late-run tolerance: every job computes its work from data state ("bars missing since last stored date"), never from "today's run".

## 3. Job specifications

### 3.1 `sync_instruments`
Requires an active broker session (skip with reason otherwise; manual price mode skips the job entirely). Download the broker instrument master; validate (>= 1,500 NSE equity rows; contains RELIANCE, TCS, INFY); upsert; change detection per `01` 3.3; probe up to 100 never-probed/stale (> 30 days) instruments by requesting 5 days of candles; set `broker_ok`. Recompute `is_tracked` = watchlist + portfolio + training basket + most recently opened (LRU cap `OPENED_STOCKS_LRU_CAP`, default 150).

### 3.2 `detect_actions`
For each tracked stock with new bars: run the split/bonus detector (`01` 3.7). Insert `corporate_action(status='detected')` rows (unique on instrument+ex_date+type). Send one Telegram note per newly detected action: "Possible split/bonus on {symbol} ({date}). Confirm in the app."

### 3.3 `broker_session_check` and reminders
If no active session or it expires before the next scheduled broker job: send **one** Telegram reminder per slot ("Broker session expired. Open the app and tap Reconnect.") and write `source_health(broker, ok=false, note='session_missing')`. Never attempt automated login.

### 3.4 `ingest_prices_eod`
1. Needs an active broker session; otherwise `skipped (broker_session_missing)`.
2. `expected_date` = last completed trading day. Universe = tracked, `broker_ok`, active stocks plus index series (`NIFTY50`, `INDIAVIX` if served).
3. For each stock (sequential, throttled): request candles from `last_bar_date + 1` to `expected_date` (full backfill when no rows). Write bars after sanity rules.
4. `adj_close` = `close` x factor from confirmed actions (or `= close` when `BROKER_PRICES_ADJUSTED=true`). When a confirmed action's re-adjustment is pending, recompute that stock's `adj_close` for the whole history (single UPDATE by date range).
5. Update `quote_latest` from the last bar if no fresher quote exists.
6. Completeness = `with_expected_bar / universe`; < 90% -> `partial` and the retry job runs at 20:30 IST. A weekday with bars for < 10% of the universe is recorded as a detected holiday (`market_holiday.description='detected'`) and not treated as an error.
7. Details: `{expected_date, universe, with_bar, rate_limited, session_ok}`.

### 3.5 `ingest_mf_navs`
Targets: watchlisted + opened schemes (`is_tracked`, cap 150). Increments with `startDate = last_nav_date + 1`; full history for new. Validation: NAV > 0; day change > 25% flagged in `details` (kept). Update `mf_return_cache`. Fallback: AMFI file for latest NAV.

### 3.6 `sync_mf_schemes`
Paginate `GET /mf?limit=1000&offset=` until empty; upsert code/name; derive `plan`/`option_type`; enrich from the AMFI file; mark schemes absent for 60 days `inactive`.

### 3.7 `compute_analysis`
For each tracked stock with >= 60 valid bars: indicators + scores (`05` sections 3-6) and, where the owner supplied data exist, derived fundamentals/valuation/shareholding analytics (`05` section 5) -> `analysis_snapshot` (`as_of` = last bar date; keep latest 30). Risk percentiles need >= 20 eligible stocks. Rebuild `screener_row` (price metrics for all tracked stocks; fundamental metrics only where entered; coverage recorded). For MF: `mf_return_cache` for tracked schemes. Stocks with unconfirmed detected actions get `warnings=['UNCONFIRMED_ACTION']`.

### 3.8 `train_models` / `predict` (Phase 7)
Per `05` section 10. If fewer than 20 eligible stocks: status `insufficient_universe`, no model, forecasts hidden with reason `no_model`. `predict` resolves past predictions into `prediction_outcome` when horizon bars exist.

### 3.9 `evaluate_alerts`
1. Load active alerts; expire past `expires_on`; alerts on delisted stocks are expired with a note.
2. Latest known price: `quote_latest` if its `quote_ts` is within 30 minutes during market hours; else last bar. Intraday runs refresh quotes **only** for stocks with active price/day-change alerts (needs an active broker session; otherwise use last bar and say so in the message).
3. Evaluate by kind (rules below); compute `dedupe_key`; insert `alert_event` (conflict = already fired).
4. For new events: set alert state (`fired` if one-shot, else `last_fired_at=now`); deliver via Telegram per rules.
5. Delivery: respect quiet hours (events stay `pending` until quiet hours end); sequential sends with 1.1 s spacing; > 10 events -> digest; failures retried 5 times at 15-minute spacing then `failed`. If `telegram_chat_id` is null: events stay `pending`; when linked later, pending events younger than 24 h are sent, older ones marked `failed(not_linked)`.

**Trigger rules**
- `price_above(T)`: fire when latest price >= T; `price_below(T)`: <= T. Creation is rejected (`422 THRESHOLD_ALREADY_MET`) if already true. Recurring alerts re-arm only after price has moved back across T by 0.5% and the cooldown has elapsed.
- `day_change_pct`: `|ltp/prev_close - 1| >= pct` in the chosen direction; once per market date.
- `wk52_high/low`: latest >= max of stored 52-week high (bars excluding today); once per market date.
- `ma_cross`: on EOD bars, golden if `fast[t-1] <= slow[t-1]` and `fast[t] > slow[t]`; death mirrored; once per cross date.
- `rsi_above/below`: crossing between consecutive EOD values; once per date.
- `results_upcoming`: owner-entered calendar event of type `results` with `0 <= days_to_event <= days_before`; once per event row. (The owner maintains the calendar; there is no automated results calendar.)
- `results_declared`: a new quarterly `period_end` appears in `fundamental_value` for that stock after the alert's `last_state.latest_period`.
- `holding_change`: a newly entered shareholding quarter differs from the previous quarter by >= `delta_pct` for the chosen holder.
- `nav_above/below`: latest NAV crosses; MF NAV freshness 1 business day.
Message format (HTML): `<b>TCS</b> above 4,000 | price 4,012.50 as of 14:45 IST (09 Oct). Alert #12`.

### 3.10 `housekeeping`
- Evict non-watchlist, non-portfolio, non-training-basket tracked stocks beyond the LRU cap (oldest `last_opened_at`) or unopened for 12 months: delete `price_daily`, `analysis_snapshot`, `prediction*`; `is_tracked=false`. Owner-entered data (fundamentals, shareholding, actions) is never evicted automatically.
- If `pg_database_size` > 380 MB: trim price history beyond `PRICE_HISTORY_YEARS_TRACKED` for non-watchlist/portfolio stocks, then reduce the LRU cap by 20%; notify via Telegram.
- Delete: sessions expired/revoked > 7 days; link codes and OAuth states expired > 1 day; `refresh_job` > 90 days; `ingestion_run` > 180 days; `alert_event` > 400 days; stale `import` uploads; MF NAVs for unopened schemes > 12 months.

### 3.11 `backup_user_data`
Export `watchlist_item`, `portfolio_txn`, `portfolio_adjustment`, `alert`, `app_setting`, owner-entered `fundamental_value/shareholding/corporate_action/import_batch`, and `app_user` **without** `password_hash` and without any broker tokens. Encrypt with `age` to the owner's public key **before** uploading as a workflow artifact (30-day retention). Restore requires resetting the password via the seed command and reconnecting the broker. Never back up `broker_session`.

## 4. worker-http (on-demand)
Routes `POST /run {job_id}` and `GET /health`. Auth: headers `X-Timestamp` and `X-Signature = hex(HMAC_SHA256(WORKER_HMAC_KEY, f"{ts}.{method}.{path}.{sha256_hex(body)}"))`; reject if the timestamp is more than 120 s off, the signature mismatches (constant-time), or the job row is not `queued`. Allow-listed kinds: `stock_refresh`, `stock_backfill`, `mf_refresh`. One job at a time (in-process lock); max 4 minutes; the target is read from the DB row, never from request input. Jobs left `queued` for > 15 minutes are executed by the nightly `process_queued_jobs` step at the end of `ingest_prices_eod`.

## 5. GitHub Actions workflows
One workflow per row of section 2 with `workflow_dispatch`, `timeout-minutes` = table value, secrets `DATABASE_URL`, `BROKER_TOKEN_KEY`, `TELEGRAM_BOT_TOKEN`, `WORKER_HMAC_KEY`, optional `AGE_PUBLIC_KEY`. If the broker rejects the runner's IP (S1/S2), run the same CLI from the owner's machine (cron/Task Scheduler) and document it in `RUNBOOK.md`.

## 6. Budgets (estimates; measure in S11)
Alerts about 790 min/month at 15-minute cadence; nightly prices much smaller than before (only tracked stocks, one candle request each) at roughly 10 min/night; weekly ML <= 45 min. A private repo is workable at 30-minute alert cadence; a public repo has no minute limit. Never commit secrets (use Actions secrets).
