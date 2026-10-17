# 04. Worker Jobs Specification (Safe Edition)

One Python package `apps/worker`:
- CLI: `python -m worker run <job> [--symbols A,B] [--dry-run] [--record-fixtures]` (GitHub Actions or a home machine).
- HTTP: `uvicorn worker.http:app` on Render free (on-demand jobs only: `stock_refresh`, `stock_backfill`, `mf_refresh`).

Allowed data sources: mfapi.in, AMFI file, Telegram (and the owner's broker API in broker mode, which is **inactive** in manual price mode, D-1). Stock prices arrive only through owner imports processed by the Go API (`01` 7.1). Nothing else (`00-legal-and-safety.md`).

## 1. Common rules
1. **Lock:** insert `ingestion_run(status='running')`; the partial unique index allows one running instance per job; a conflict exits as `skipped`. A run older than 2x its timeout may be marked `failed` by the next run.
2. **Idempotent:** upserts by natural key; re-running never duplicates.
3. **Timeout:** hard per-job timeout below; on timeout finish the current item, write progress, mark `partial`.
4. **Per-item isolation:** one symbol failing never fails the run; keep the first 50 errors in `details`.
5. **Market date:** expected last trading date from `market_holiday` (seeded from `config/market_holidays.json`, plus owner `holidays` imports) + weekends; if the year has no holiday rows, weekends only (no auto-detection) and the stale chip uses the 4-calendar-day rule. Never infer from the server date alone.
6. **Source health + circuit breaker:** per `01-data-sources.md` section 1.
7. **Owner notifications:** a job failing or `partial` with > 20% items failed twice in a row triggers one Telegram message per 24 h per job. Broker session problems have their own reminder rules (job 3.3).
8. **GitHub Actions:** each workflow uses `concurrency: { group: <job-group>, cancel-in-progress: false }`, pins actions by SHA, never prints secrets.
9. **Dry run:** fetch/parse/validate and print a summary; write nothing.
10. **Safe Edition guard:** a unit test asserts that no module under `apps/worker` imports `yfinance`, `nsepython`, `bs4` against financial sites, or contains hostnames of forbidden sources (a deny-list test).

## 2. Schedules (GitHub cron is UTC; IST = UTC+5:30; cron is best-effort and may be late)

| Job | IST | Cron (UTC) | Timeout |
|---|---|---|---|
| ~~`sync_instruments`~~ | OFF in manual mode (no workflow) | | |
| ~~`broker_session_check`~~ | OFF in manual mode | | |
| ~~`ingest_prices_eod`~~ | OFF in manual mode (replaced by event-driven `post_import`, 3.12) | | |
| ~~`price_completeness_retry`~~ | OFF in manual mode | | |
| `process_queued_jobs` | 19:00 daily | `30 13 * * *` | 20 min (runs queued/partial `post_import`, `mf_refresh` jobs older than 15 min; then `predict` when models exist) |
| `ingest_mf_navs` | 22:00 and 04:00 daily | `30 16 * * *` and `30 22 * * *` | 30 min |
| `sync_mf_schemes` | Sun 05:00 | `30 23 * * 6` | 20 min |
| ~~`evaluate_alerts` (intraday)~~ | OFF in manual mode (no intraday data) | | |
| `evaluate_alerts` (EOD) | 19:30 Mon-Fri | `0 14 * * 1-5` | 8 min |
| `train_models` | Sat 11:00 | `30 5 * * 6` | 90 min |
| `housekeeping` | Sun 12:00 | `30 6 * * 0` | 20 min |
| `backup_user_data` | Sun 12:30 | `0 7 * * 0` | 10 min |
| `keepalive` | monthly | `0 0 1 * *` | 2 min (empty commit to branch `heartbeat`; avoids auto-disabled schedules in public repos) |

Late-run tolerance: every job computes its work from data state ("bars missing since last stored date"), never from "today's run".

## 3. Job specifications

> Jobs 3.1, 3.3 and 3.4 are **not run in manual price mode** (D-1, D-2). They are kept as a reference for a future broker mode. The tracked set (`is_tracked`) is maintained by the API (opened stock, watchlist add, portfolio txn, prices import), not by a worker job.

### 3.1 `sync_instruments`
Requires an active broker session (skip with reason otherwise; manual price mode skips the job entirely). Download the broker instrument master; validate (>= 1,500 NSE equity rows; contains RELIANCE, TCS, INFY); upsert; change detection per `01` 3.3; probe up to 100 never-probed/stale (> 30 days) instruments by requesting 5 days of candles; set `broker_ok`. Recompute `is_tracked` = watchlist + portfolio + most recently opened (LRU cap `OPENED_STOCKS_LRU_CAP`, default 150) + imported.

### 3.2 `detect_actions`
For each tracked stock with new bars (in manual mode: each symbol of the `post_import` batch): run the split/bonus detector (`01` 3.7). If the ex-date falls inside bars with `src_adjusted=true`, still insert the action but set `warnings=['ADJUSTMENT_CONFLICT']` (never adjust those bars; `01` 3.7). Insert `corporate_action(status='detected')` rows (unique on instrument+ex_date+type). Send one Telegram note per newly detected action: "Possible split/bonus on {symbol} ({date}). Confirm in the app."

### 3.3 `broker_session_check` and reminders
If no active session or it expires before the next scheduled broker job: send **one** Telegram reminder per slot ("Broker session expired. Open the app and tap Reconnect.") and write `source_health(broker, ok=false, note='session_missing')`. Never attempt automated login.

### 3.4 `ingest_prices_eod`
1. Needs an active broker session; otherwise `skipped (broker_session_missing)`.
2. `expected_date` = last completed trading day. Universe = tracked, `broker_ok`, active stocks plus index series (`NIFTY50`, `INDIAVIX` if served).
3. For each stock (sequential, throttled): request candles from `last_bar_date + 1` to `expected_date` (full backfill when no rows). Write bars after sanity rules.
4. `adj_close` = `close` x factor from confirmed actions (or `= close` when `PRICES_ALREADY_ADJUSTED=true`). When a confirmed action's re-adjustment is pending, recompute that stock's `adj_close` for the whole history (single UPDATE by date range).
5. Update `quote_latest` from the last bar if no fresher quote exists.
6. Completeness = `with_expected_bar / universe`; < 90% -> `partial` and the retry job runs at 20:30 IST. (Broker mode only; there is no holiday auto-detection.)
7. Details: `{expected_date, universe, with_bar, rate_limited, session_ok}`.

### 3.5 `ingest_mf_navs`
Targets: watchlisted + opened schemes (`is_tracked`, cap 150). Increments with `startDate = last_nav_date + 1`; full history for new. Validation: NAV > 0; day change > 25% flagged in `details` (kept). Update `mf_return_cache`. Fallback: AMFI file for latest NAV.

### 3.6 `sync_mf_schemes`
Paginate `GET /mf?limit=1000&offset=` until empty; upsert code/name; derive `plan`/`option_type`; enrich from the AMFI file; mark schemes absent for 60 days `inactive`.

### 3.7 `compute_analysis`
For each tracked stock with >= 60 valid bars: indicators + scores (`05` sections 3-6) and, where the owner supplied data exist, derived fundamentals/valuation/shareholding analytics (`05` section 5) -> `analysis_snapshot` (`as_of` = last bar date; keep latest 30). Risk percentiles need >= 20 eligible stocks. Rebuild `screener_row` (price metrics for all tracked stocks; fundamental metrics only where entered; coverage recorded). For MF: `mf_return_cache` for tracked schemes. Stocks with unconfirmed detected actions get `warnings=['UNCONFIRMED_ACTION']`.

### 3.8 `train_models` / `predict` (Phase 7; deferred by the owner, D-4)
Per `05` section 10; universe = tracked stocks with >= 750 valid bars and no unconfirmed actions (D-H; there is no separate training basket). If fewer than 20 eligible stocks: status `insufficient_universe`, no model, forecasts hidden with reason `no_model`. `predict` resolves past predictions into `prediction_outcome` when horizon bars exist.

### 3.9 `evaluate_alerts`
1. Load active alerts; expire past `expires_on`; alerts on delisted stocks are expired with a note.
2. Latest known price: **manual price mode (current):** the last imported bar only (no quotes, no intraday run). Evaluation is **event-driven** (called at the end of `post_import` for the affected symbols) and also runs in the 19:30 IST EOD run for all active alerts. Only bars **newer than the alert's last evaluated bar** (`alert.last_state.last_bar_date`) can fire; after evaluating, store that bar date. The staleness rule (ALR-14: no price alert if data older than 1 trading day) **does not apply** in manual mode. (Broker mode, inactive: `quote_latest` if its `quote_ts` is within 30 minutes during market hours; else last bar; intraday runs refresh quotes only for stocks with active price/day-change alerts.)
3. Evaluate by kind (rules below); compute `dedupe_key` (**includes the bar date**, e.g. `alert_id|kind|bar_date|threshold`, so the same bar never fires twice); insert `alert_event` (conflict = already fired).
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
Message format (HTML): `<b>TCS</b> above 4,000 | price 4,012.50 as of 14:45 IST (09 Oct). Alert #12`. **Manual mode:** `<b>TCS</b> above 4,000 | close 4,012.50, as of the last price import (09 Oct 2026). Alert #12`.

### 3.10 `housekeeping`
- **Manual price mode: imported price data is never deleted automatically, not even by size.** Stocks with `tracked_reason='imported'` (and watchlist/portfolio stocks) are exempt from the LRU cap and the 12-month rule. The LRU cap (`OPENED_STOCKS_LRU_CAP`) applies only to stocks tracked solely as `opened` that have **no** imported prices (they hold only derived rows: `analysis_snapshot`, `prediction*`; set `is_tracked=false`). Owner-entered data (fundamentals, shareholding, actions) is never evicted automatically.
- **Size thresholds** at 70%, 85% and 95% of `DB_SOFT_LIMIT_MB` (380): send one Telegram notice per threshold crossing and set `db.warn_level` (admin page shows a warning). At 100% (380 MB) price imports are rejected (`DB_SIZE_LIMIT`) until the owner frees space. Space is freed only by owner actions: **Trim history** (`POST /prices/trim`) and **Delete prices for {symbol} between {from} and {to}** (`DELETE /stocks/{symbol}/prices`).
- Delete: sessions expired/revoked > 7 days; link codes and OAuth states expired > 1 day; `refresh_job` > 90 days; `ingestion_run` > 180 days; `alert_event` > 400 days; `import_upload` rows past `expires_at`; MF NAVs for unopened schemes > 12 months.

### 3.11 `backup_user_data`
Export `watchlist_item`, `portfolio_txn`, `portfolio_adjustment`, `alert`, `app_setting`, owner-entered `fundamental_value/shareholding/corporate_action/import_batch`, and `app_user` **without** `password_hash` and without any broker tokens. Encrypt with `age` to the owner's public key **before** uploading as a workflow artifact (30-day retention). Restore requires resetting the password via the seed command and reconnecting the broker. Never back up `broker_session`.

### 3.12 `post_import` (event-driven; manual mode)
Triggered by the API (via worker-http) after a prices import commit, a delete-prices action or a trim. Input: the `import_batch` id in `refresh_job.target` (`batch:<id>`); the affected symbol list is derived from the batch (stored in `refresh_job.result.remaining` at enqueue).
1. Process symbols **in order**; for each: re-adjust that stock's history (confirmed split/bonus only, `01` 3.7; idempotent), `detect_actions` (3.2), then `compute_analysis` (3.7) for that symbol, then alert evaluation (3.9) for that symbol. Per-item isolation (rule 1.4).
2. **Resumable:** worker-http jobs have a 4-minute cap. Stop starting new symbols at **3.5 minutes**; write progress to `refresh_job.result` (`symbols_total`, `symbols_done`, `remaining`), set `status='partial'` and enqueue a continuation job for the remainder (same target, new row; the unique active-job index is satisfied because the partial row is no longer `queued/running`). `process_queued_jobs` (3.13) continues any job left `queued`/`partial` with remaining work.
3. After the last symbol: recompute `screener_row` for the affected symbols and set `status='ok'`.
4. Idempotent: re-running a symbol never duplicates actions, snapshots or alert events (dedupe by bar date).

### 3.13 `process_queued_jobs` (daily 19:00 IST)
Selects `refresh_job` rows that are `queued` for > 15 minutes or `partial` with remaining work, and runs them with the same resumable logic (no 4-minute cap when run by GitHub Actions; the 3.5-minute stop does not apply there, the 20-minute workflow timeout does). Then runs `predict` if models exist (Phase 7).

## 4. worker-http (on-demand)
Routes `POST /run {job_id}` and `GET /health`. Auth: headers `X-Timestamp` and `X-Signature = hex(HMAC_SHA256(WORKER_HMAC_KEY, f"{ts}.{method}.{path}.{sha256_hex(body)}"))`; reject if the timestamp is more than 120 s off, the signature mismatches (constant-time), or the job row is not `queued`. Allow-listed kinds: `post_import`, `mf_refresh` (and `stock_refresh`, `stock_backfill` in broker mode, inactive). One job at a time (in-process lock); max 4 minutes (`post_import` stops at 3.5 minutes, see 3.12); the target is read from the DB row, never from request input. Jobs left `queued` for > 15 minutes are executed by the daily `process_queued_jobs` workflow (3.13). `X-Timestamp` is unix seconds (integer); an identical signature is accepted only once inside the 120 s window; `POST /run` answers `202` and runs the job in the background (the caller polls `refresh_job`); errors use `{"error": {"code", "message"}}` with 401 `UNAUTHORIZED`, 404, 409 `JOB_NOT_QUEUED`/`BUSY`, 422, 501 `JOB_NOT_AVAILABLE` (no handler installed yet). All outbound HTTP from the worker goes through `worker.egress.make_client` (allow-list `config/allowed_hosts.json`, D-N).

## 5. GitHub Actions workflows
One workflow per row of section 2 with `workflow_dispatch`, `timeout-minutes` = table value, secrets `DATABASE_URL`, `BROKER_TOKEN_KEY`, `TELEGRAM_BOT_TOKEN`, `WORKER_HMAC_KEY`, optional `AGE_PUBLIC_KEY`. Manual mode: no broker workflows are created. (Broker mode, inactive: if the broker rejects the runner's IP, run the same CLI from a static-IP machine; the owner decided not to pay for one, D-8.)

## 6. Budgets (estimates; measure in S11)
Manual mode: no intraday alert cadence; EOD alerts and `process_queued_jobs` are a few minutes per day; `post_import` runs on demand in worker-http; weekly ML <= 45 min (deferred). A private repo is workable at 30-minute alert cadence; a public repo has no minute limit. Never commit secrets (use Actions secrets).
