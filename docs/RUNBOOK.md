# RUNBOOK (kept up to date by every task)

## 1. Daily routine
- Manual price mode (current): after market close, upload the day's `prices.csv` in Import center. Alerts and analytics run automatically right after the import (`post_import`) and at 19:30 IST (EOD). Alerts say "as of the last price import".
- First setup: import `instruments.csv` (or use Add stock), then `prices.csv`.
- Watch DB size (Import center > Storage). Notices at 70/85/95% of 380 MB; at 380 MB price imports are refused. Nothing is deleted automatically: free space with Trim history or Delete prices.
- Broker reconnect is not applicable (broker mode dormant).
## 2. Deploy
(Fill during T00/T02/B01/F01: Neon setup, Render services (API + worker-http), Vercel project, GitHub secrets, environment variables from .env.example.)

### 2a. Database migrations and seed (T02)
Migrations live in `db/migrations` (goose, numbered, forward-only; never edit an applied file, add a new one). Each runs in its own transaction, so a failing migration leaves nothing half-applied (SYS-07). Run from the repo root with `DATABASE_URL` set (Neon: `sslmode=require`):
```
go run github.com/pressly/goose/v3/cmd/goose@v3.22.1 -dir db/migrations postgres "$DATABASE_URL" up
go run github.com/pressly/goose/v3/cmd/goose@v3.22.1 -dir db/migrations postgres "$DATABASE_URL" status
```
`pg_trgm` is created by migration 0001; if the host forbids the extension, `up` stops with the Postgres error and nothing else is applied. `down` exists for local/CI round-trip tests only; **in production never run `down`**: fix forward with a new migration, or restore the latest backup (section 5).
Seed (after `up`, from `apps/api`; `INITIAL_PASSWORD_HASH` and `DATABASE_URL` from the environment):
```
printf '%s\n' "your long password" | go run ./cmd/seed hash-password   # prints the argon2id hash; put it in INITIAL_PASSWORD_HASH
go run ./cmd/seed -config-dir ../../config                           # idempotent; never overwrites owner edits
```
The seed creates the single owner row, the default `app_setting` rows (MASTER_PLAN section 5; `BROKER_ENABLED=false`, `DB_SOFT_LIMIT_MB=380`; `PRICES_ALREADY_ADJUSTED` stays unset), and `market_holiday` rows from `config/market_holidays.json` only for years that have no rows yet. It creates no instruments. A year with an empty list prints a "weekends only" warning. Re-running with a different hash does not change the stored password; change it through the app. Regenerate typed queries after editing `apps/api/queries/*.sql` (from `apps/api`): `docker run --rm -v "$PWD/../..:/src" -w /src/apps/api sqlc/sqlc:1.27.0 generate`.
Integration tests use `TEST_DATABASE_URL` (CI service) or start a throwaway Postgres with testcontainers; without Docker they skip locally and fail in CI.

## 3. Scheduled jobs
(Link to .github/workflows; how to trigger manually with workflow_dispatch; how to run the worker from a home machine.)

## 3a. CI, guards and local checks (T00)
`.github/workflows/ci.yml` runs on every push to `main` and every pull request: **guards** (script tests, deny-list, lockfiles, `.env.example`, licence scan + notices), **api** (go vet, golangci-lint, `go test -race`, build; Postgres 16 service, `TEST_DATABASE_URL`), **worker** (ruff, ruff format, `mypy --strict` on `worker/adapters` and `worker/analytics`, pytest), **web** (eslint, prettier, `tsc`, node tests, `next build`). Actions are pinned by commit SHA; `.github/renovate.json` opens dependency PRs (SYS-11).
Run the same checks locally from the repo root (needs Go, uv, Node 20):
```
python scripts/deny_list_check.py        # SAF-01/02: forbidden libraries, hosts, order methods
python scripts/check_lockfiles.py        # SYS-11
python scripts/check_env_example.py      # every config key listed, no secret values
python scripts/license_scan.py           # SAF-04; add --write to regenerate THIRD_PARTY_NOTICES.md
uv run --project apps/worker pytest scripts/tests apps/worker/tests
(cd apps/api && go vet ./... && go test ./... && golangci-lint run ./...)
(cd apps/worker && uv run ruff check . && uv run ruff format --check . && uv run mypy)
(cd apps/web && npm ci --ignore-scripts && npm run lint && npm run format:check && npm run typecheck && npm test && npm run build && npm run build-storybook && npm run test:e2e)
```
Adding a dependency: run `python scripts/license_scan.py --write` and commit the regenerated `THIRD_PARTY_NOTICES.md`. The scan fails on GPL/AGPL and unknown licences; MPL-2.0 and LGPL packages are listed as **Review** (OQ-8).
The deny-list scans every non-binary file except Markdown, tool directories (`node_modules`, `.venv`, `.next`, caches), `config/research_links.json` (plain hyperlinks the app never requests) and its own script/test. It also checks joined string literals, decoded escapes, base64 tokens and UTF-16 files (SAF-09). It cannot see values built at runtime; the egress allow-list in D01/B01 (D-N) covers that.
The licence scan lists Python packages from `uv.lock`, so `THIRD_PARTY_NOTICES.md` is identical on Windows, Linux and CI. Licence text comes from the installed environment (`uv sync --all-groups --all-extras`); a platform-only package (colorama on Windows) reuses the row already in the notices file. If CI says a package has an UNKNOWN licence, run `--write` on a machine where it installs. The Go collector needs `go mod download` first and fails closed without it (SAF-12). Since T02 it lists only modules that provide a package in `go list -deps -test ./...` for a fixed `GOOS=linux GOARCH=amd64 CGO_ENABLED=0` (not the whole `go list -m all` graph, which includes hundreds of never-built modules pulled in by testcontainers and cannot be classified); the list is therefore identical on every machine.
## 3b. Worker foundation (D01)
- **Run a job:** `cd apps/worker && uv run python -m worker run <job> [--symbols A,B] [--dry-run] [--record-fixtures]` (needs `DATABASE_URL`; `--dry-run` needs nothing and writes nothing). No jobs are registered until D03+; an unknown job name prints the known ones.
- **HTTP service:** `uv run uvicorn worker.http:app --host 0.0.0.0 --port $PORT`; `GET /health` is open, `POST /run {"job_id": n}` needs `X-Timestamp` (unix seconds) and `X-Signature` (docs/04 section 4) made with `WORKER_HMAC_KEY`. An empty key rejects everything (fail closed).
- **Egress:** the only HTTP client is `worker.egress.make_client`; hosts come from `config/allowed_hosts.json` (`mfapi.in`, `www.amfiindia.com`, `api.telegram.org`), https and port 443 only. `EgressDenied` in a log means code tried another host: fix the code, never add hosts without an owner decision. ruff bans `requests`, `urllib.request`, `urllib3`, `http.client`, `aiohttp` everywhere and `httpx` outside `worker/egress.py`.
- **Circuit breaker stuck open:** inspect `SELECT * FROM source_health;`. After `disabled_until` passes calls are allowed again; 3 consecutive successes close it. To reset by hand after fixing the cause: `UPDATE source_health SET consecutive_failures = 0, disabled_until = NULL, ok = true WHERE source = '<source>';`.
- **Stuck lock:** a `running` row older than 2x the job timeout is failed automatically by the next run; otherwise `UPDATE ingestion_run SET status='failed', finished_at=now(), error='manual' WHERE job='<job>' AND status='running';`.
- **Tests:** sockets are disabled (loopback only). Integration tests need Postgres 16: `docker run -d --rm --name d01-pg -e POSTGRES_USER=analyzer -e POSTGRES_PASSWORD=local-test-only -e POSTGRES_DB=analyzer_test -p 55432:5432 postgres:16`, then set `TEST_DATABASE_URL=postgres://analyzer:local-test-only@127.0.0.1:55432/analyzer_test?sslmode=disable`. Without it those 6 tests are skipped locally; CI always sets it and fails if it is missing.
## 4. Failure modes and responses
| Symptom | Likely cause | Action |
|---|---|---|
| AMFI import rejects the file (missing header) or rows lack an AMC | AMFI changed the layout of `NAVAll.txt` (it went from 6 to 8 fields on or before 2026-10-10) | Keep last good data; save the new file as a fixture; read columns by header name; scheme-type lines start with `Open Ended`/`Close Ended`/`Interval Fund`, others are AMC lines (docs/01 section 5, MF-19, MF-20) |
| MF scheme search slower than 300 ms | Planner picks a sequential scan instead of `mf_scheme_name_trgm` on long queries (seen at 10k rows, 330-590 ms) | Make sure the API role uses `random_page_cost=1.1` (or `SET LOCAL enable_seqscan = off` for the search query); re-run `scripts/spikes/s10_sizing.sql` timings on Neon (S10) |
| mfapi list or history looks reversed or has a weekend date | Normal: `data` is newest first and Sunday 31 March rows exist | Always sort ascending after parsing; keep weekend NAVs (docs/01 section 4, MF-16) |
## 5. Backup and restore drill
(Fill in D08.)
## 5a. Repository settings (owner, once, on GitHub)
Branch protection for `main` (Settings > Branches): require a pull request, require the status checks **guards**, **api**, **worker** and **web** to pass and be up to date, block force pushes and deletion. The repository is public: secrets live only in GitHub Actions secrets and host environment variables; never commit `.env` or real data. Install the Renovate GitHub app (or use the hosted one) so `.github/renovate.json` takes effect.
## 6. Plan B
- Render free hours exhausted; broker blocks cloud IP; Neon limit reached; GitHub schedule disabled.
## 7. Incident log
- 2026-10-10: first CI run failed in the licence scan ("THIRD_PARTY_NOTICES.md is missing or stale"). Cause: notices generated on Windows listed colorama, which a Linux runner never installs. Fix: Python packages are listed from `uv.lock` (section 3a), test SAF-12.

## 8. Go API operations (B01)
- **Start-up** needs `DATABASE_URL`, `WORKER_HMAC_KEY` (>= 32 chars) and `WORKER_BASE_URL`; a missing or invalid value stops the process and the message lists every problem (never a value). `BROKER_ENABLED=true` is refused (manual price mode, D-1). Optional tunables (`SESSION_DAYS`, `LOGIN_MAX_FAILS`, `REFRESH_COOLDOWN_MIN`, `REFRESH_GLOBAL_PER_HOUR`, `DB_SOFT_LIMIT_MB`) fall back to the MASTER_PLAN section 5 defaults. The pool is created lazily, so a sleeping Neon database does not block start-up.
- **Health:** `GET /healthz` (also `/api/v1/healthz`) is `{"ok":true}` and never touches the database (use it for the Render health check). `GET /api/v1/readyz` needs a session and pings the database; a failed ping is retried once after 750 ms (Neon cold start, SYS-01), then `503 SOURCE_DOWN`.
- **Logs** are JSON on stdout with `request_id` (also returned as `X-Request-Id`); only method, path (no query string), status, duration and size are logged, never headers or bodies. A scrubber redacts cookies, tokens, passwords, argon2 hashes, bot tokens, URL passwords and every configured secret value (SEC-08). If a secret ever shows up in a log, rotate it and add a pattern to `internal/logx` with a test.
- **Rate limits** (in memory, reset on restart): login 10/min per client address, authenticated routes 120/min; answer `429 RATE_LIMITED` with `Retry-After`. The client address is the rightmost `X-Forwarded-For` entry (set by the hosting proxy) or the socket peer. Behind the Vercel rewrite this can be the proxy's address, which only makes the limit stricter for a single owner.
- **Limits and timeouts:** JSON bodies 1 MiB, import uploads 26 MiB (25 MB file limit plus multipart overhead), request timeout 30 s, server read/write timeout 60 s.
- **Egress (D-N, SAF-13):** the API makes no outbound calls today. `internal/egress` is the only permitted HTTP client (host allow-list, checked on every request and redirect before dialing; no IP literals, credentials in URLs or other schemes). `golangci-lint` (`forbidigo`, `depguard`) fails on `http.Get/Post/Head/PostForm`, `http.DefaultClient`, `http.DefaultTransport`, `http.Client`, `http.Transport` and `net.Dial` outside it. When B09 needs to call the worker it builds the client with `egress.FromURL(cfg.WorkerBaseURL)`; B12 adds `api.telegram.org` (https).
- **Stubs:** every route of docs/03 exists and answers `501 NOT_IMPLEMENTED` in the error envelope until its task lands; `/broker/login`, `/broker/callback` and `/broker/session` answer `422 BROKER_DISABLED`. Protected routes answer 401 until B02 replaces `httpx.DenyAll`.
- **Contract workflow:** edit `docs/03-api-spec.md`, then `openapi.yaml`, then `internal/httpx/routes.go`, then run `npm run generate` in `packages/api-types` and commit `src/schema.d.ts` (CI job `api-types` fails when it is stale). `TestRoutesMatchOpenAPI` fails when the router and `openapi.yaml` differ. Add the `api-types` job to the required status checks in section 5a.

## 9. Authentication (B02)
- **Owner password** is seeded once from `INITIAL_PASSWORD_HASH` (argon2id PHC string, `cmd/seed`); it is never read again. Change it in the app (`POST /auth/change-password`, min 12 characters); that revokes every other session.
- **Locked out?** Look at `SELECT failed_logins, locked_until FROM app_user;`. The lock ends by itself (15 min, then 30, 60 ... max 24 h). To clear it immediately: `UPDATE app_user SET failed_logins = 0, locked_until = NULL;` (owner, with database access).
- **Forgot the password:** generate a new hash with `go run ./cmd/seed hash-password` (section 1), then `UPDATE app_user SET password_hash = '<hash>', failed_logins = 0, locked_until = NULL;` and `UPDATE session SET revoked_at = now() WHERE revoked_at IS NULL;`.
- **Sessions:** cookie `session` (HttpOnly, Secure, SameSite=Lax), `SESSION_DAYS` long, sliding but updated at most hourly; only the sha256 of the token is stored. Revoke all with `POST /auth/logout-all` or the SQL above. Expired and revoked rows are harmless; they are not purged yet (housekeeping, D08).
- **CSRF:** every non-GET API call must carry `X-Requested-With: fetch` (the web app does); a 403 `Missing CSRF header` from curl means the header is missing. The Telegram webhook is exempt.
- **Rate limits** are per instance and in memory; login 10/min per IP. A failed login also waits 300-800 ms server-side.

## 10. Prices, adjustment and split/bonus detection (D03)
- **Where prices come from:** only owner imports (Go API). The worker never fetches prices; there is no `ingest_prices_eod`. After an import the API enqueues `post_import` (`refresh_job.result.remaining` = ordered symbols).
- **`post_import`** (worker-http, kind `post_import`): per symbol re-adjusts history, runs `detect_actions`, then the D05/D06 hooks (no-ops until those tasks land). It stops starting symbols after 3.5 minutes, stores `symbols_total/symbols_done/remaining/failed/new_actions` in `refresh_job.result`, sets `partial` and enqueues a continuation row (same target). A continuation stays `queued` until the API triggers it or the daily `process_queued_jobs` runs.
- **`process_queued_jobs`** (daily 19:00 IST, `python -m worker run process_queued_jobs`, 20-minute limit): continues `queued` rows older than 15 minutes and `partial` rows with remaining work and no successor. If it hits the 20-minute limit it re-enqueues the rest. `--dry-run` lists what it would run.
- **Other CLI jobs:** `python -m worker run detect_actions [--symbols A,B] [--dry-run]` (default: tracked stocks) and `python -m worker run readjust_prices --symbols A` (recompute `adj_close` for the whole history in one UPDATE).
- **Adjustment rule (D-K):** `adj_close = close x factor` only for `src_adjusted=false` bars and only for **confirmed** `split`/`bonus` actions with `ex_date` up to today (IST); `src_adjusted=true` bars always keep `adj_close = close`. Rights, buyback, merger, demerger and an untyped `split_or_bonus` are never applied (listed as `review_needed` in the job result).
- **Detector** (`worker/analytics/actions.py`, `DetectorConfig`): trigger 0.35, tolerance 3%, volume > 1.5x the average of the prior 20 bars (day t excluded, D-T), at least 20 prior bars. Candidates are inserted once (`corporate_action`, status `detected`, source `detected`); a rejected date is never re-detected. Thresholds are code defaults; tune them only after spike S8 on real files (BLOCKED-OWNER).
- **Soft flag (D-O):** a one-day drop of 20% or more with no action on that date is derived at read time (`actions_db.list_soft_flags`); it creates no action and no `UNCONFIRMED_ACTION`. Dismissals live in `flag_dismissals` (migration 0011): Dismiss inserts a row, Undo deletes it. To clear all dismissals for a stock: `DELETE FROM flag_dismissals WHERE instrument_id = (SELECT id FROM instrument WHERE symbol = 'X');`.
- **Symptoms:** `ADJUSTMENT_CONFLICT` (a detected action inside already-adjusted bars): the owner mixed raw and adjusted files; nothing was adjusted; check which file is raw. A stock whose `adj_close` looks wrong after confirming: run `readjust_prices --symbols X` and read `review_needed`. `post_import` stuck `running`: the row is a normal `refresh_job`; set it to `failed` by hand, the API can enqueue again.
- **Local DB tests:** the worker integration tests apply every `db/migrations/*.sql` Up section to a clean schema in `TEST_DATABASE_URL` (the test database is wiped, never point it at real data).

## 11. Web app operations (F01)
- **`API_BASE_URL`** (Vercel environment variable, no trailing slash, no `/api`): the Go API origin. `next.config.ts` reads it **at build time** to create the `/api/:path*` rewrite, so set it for the build and redeploy after changing it. Unset, the rewrite points at `http://localhost:8080` and every API call fails (the UI shows the error state with Retry).
- **Cold API:** after 3 s without an answer the shell shows "Waking up the server. This can take up to a minute on the free plan." with elapsed seconds; each request gives up after 70 s with a Retry. No keep-warm pings (D-3).
- **Session gate:** `middleware.ts` only checks that a `session` cookie exists. A stale cookie gets a 401 from the API, which clears all caches and sends the browser to `/login?next=<path>`. If someone is stuck on `/login`, clear the `session` cookie.
- **CSP:** per-request nonce set in `middleware.ts`. A blank page with "Content Security Policy" errors in the console means a script was added without going through Next (inline script, third-party script); remove it rather than loosening the policy. Next 16 prints a deprecation notice for the `middleware.ts` file name; see OPEN_QUESTIONS F01-1.
- **Browser tests:** `npm run build` then `npm run test:e2e` (Playwright, uses system Chrome in CI and Edge locally; set `PW_CHANNEL=chrome` to override). Storybook: `npm run storybook` (dev) or `npm run build-storybook`.
- **Lighthouse (owner, once, until F15 automates it):** build and start the app, sign in, run Lighthouse mobile on `/` in Chrome DevTools; record the accessibility score in `docs/SPIKE_RESULTS.md` (target >= 95). The automated proxy is the axe test in `tests/e2e/shell.spec.ts`.
- **Fonts and icons:** Inter (OFL-1.1) from `@fontsource-variable/inter` through `next/font/local`, `lucide-react` (ISC); ECharts (Apache-2.0) is added with ChartFrame in F02. All permissive; recorded in `THIRD_PARTY_NOTICES.md` (S15). Tailwind pulls in `lightningcss` (MPL-2.0), listed as Review like `axe-core` (D-OQ8).
- **Install quirk:** npm 10 can fail with "Cannot read properties of null (reading 'edgesOut')" when adding vitest next to eslint 10; `npm i --legacy-peer-deps <pkg>` works and the committed lockfile installs with plain `npm ci`.

## 12. Mutual fund data (D04)
- **Jobs:** `python -m worker run sync_mf_schemes` (Sun 05:00 IST, 20 min) lists mfapi (`limit=10000` pages until empty), downloads `NAVAll.txt` once, enriches `mf_scheme` (fund house, type, category, missing plan/option/ISIN) and sets `active`/`inactive`. `python -m worker run ingest_mf_navs [--symbols 122639,...] [--dry-run]` (22:00 and 04:00 IST, 30 min) fetches NAVs for tracked schemes (cap 150): full history for a new scheme, else `startDate = last_nav_date + 1`; then rebuilds `mf_return_cache`. worker-http kind `mf_refresh` (target = scheme code) does the same for one scheme.
- **Hosts:** `api.mfapi.in` and `www.amfiindia.com` only (egress allow-list; `api.mfapi.in` pending owner confirmation, OQ D04-A1). Throttle: `MFAPI_MIN_INTERVAL_SEC` (default 0.5); retries 3x on 5xx/429/network; breaker `source_health` rows `mfapi` and `amfi`.
- **Reading a run:** `ingestion_run.details` holds `mfapi_error` / `amfi_error`, `amfi_fallback` (codes whose latest NAV came from AMFI because mfapi failed; run is `partial`), `nav_jumps` (day change above 25%, kept, flagged), `nav_rejected` (rows dropped for bad date or NAV), `status_changed` / `now_inactive`.
- **Symptoms:** `EgressDenied` on mfapi = host not on the allow-list. `SchemaError: AMFI header is missing required columns` = AMFI changed the layout; the file is rejected and nothing (including status) changes; add a fixture of the new header, a failing test, then fix `adapters/amfi.py`. A scheme wrongly `inactive` right after a failed AMFI run cannot happen (status changes only on a parsed file); if a scheme is wrongly inactive after a good run, check its AMFI value date and `last_nav_date` (rule: freshest of the two must be within 60 days).
- **Fixtures:** `fixtures/mfapi/`, `fixtures/amfi/NAVAll_sample.txt` (small sample; the 10,000-row check uses a synthetic file of the same layout). Live smoke check (owner, once): `python -m worker run sync_mf_schemes --dry-run` should report `amfi_rows` above 10,000 and `schemes_listed` near 38,000.

## 13. Refresh and post-import jobs from the API (B09)
- **Routes:** `POST /mf/schemes/{code}/refresh` (202 new job, 200 when one is already active, 429 `retry_after_seconds` on cooldown or hourly limit, 404 unknown scheme), `GET /jobs/{id}`. `POST /stocks/{symbol}/refresh` always answers `422 PRICE_MODE_MANUAL`; `stock_backfill` has no route. Prices come only from owner imports.
- **How a job runs:** the API inserts a `refresh_job` row (`queued`), then signals worker-http in the background (`POST {WORKER_BASE_URL}/run {"job_id":N}`, `X-Timestamp` unix seconds, `X-Signature` HMAC with `WORKER_HMAC_KEY`, through `internal/egress` only). The worker answers 202 and updates the row; the UI polls `GET /jobs/{id}`.
- **Job stays `queued`?** The signal failed (worker asleep on Render free, 409 `BUSY`, wrong key or clock skew over 120 s). The API log line is `worker signal failed; job stays queued` with the job id (never the key). Nothing is lost: the daily `process_queued_jobs` run picks up rows queued for more than 15 minutes. To retry now, open the Render worker URL `/health` to wake it, then click again (an active job is returned, not duplicated) or run `python -m worker run process_queued_jobs`.
- **401 from the worker in the log:** `WORKER_HMAC_KEY` differs between API and worker, or the host clocks differ by more than 120 s.
- **Limits:** `REFRESH_COOLDOWN_MIN` (default 15) per target, `REFRESH_GLOBAL_PER_HOUR` (default 30) across `mf_refresh`/`stock_*`. `post_import` is exempt from both and deduped by the unique active-job index `(kind, target)`.
- **Stuck `running` row** (worker crashed): set it to `failed` by hand (`UPDATE refresh_job SET status='failed', finished_at=now(), error='manual' WHERE id=N;`), after which the API can enqueue again.
- **For other API tasks:** call `jobs.Service.EnqueuePostImport(ctx, batchID, symbols)` (B06) or `EnqueuePostImportTarget(ctx, "action:<id>", symbols)` (B07) after the data transaction commits.


## 14. Alerts and Telegram link (B12)
- **Scope:** the API stores alerts, link codes and the chat id, and receives the Telegram webhook. It never evaluates alerts or sends alert messages (D06, worker). The API sends only the `/start` confirmation and the test message, through `internal/egress` (allow-list: `api.telegram.org` only).
- **Variables (Render, API service):** `TELEGRAM_BOT_TOKEN` (from BotFather), `TELEGRAM_WEBHOOK_SECRET` (random string, required when the token is set), `TELEGRAM_BOT_USERNAME` (without `@`; optional, only for the deep link). All three are empty until the owner creates the bot (D-9); the app works without them (link-code returns null bot fields, test message is 503, the webhook refuses everything).
- **Owner setup (once, after creating the bot):** set the three variables, redeploy, then register the webhook (the secret goes in the request body, never in a URL you share): `curl -sS "https://api.telegram.org/bot<TOKEN>/setWebhook" -d "url=https://<api-host>/api/v1/telegram/webhook" -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"`. Check with `getWebhookInfo` (`last_error_message` empty). Then Settings -> Telegram -> create a link code and send `/start <code>` to the bot within 15 minutes.
- **Symptoms:** webhook 401 in the logs (`telegram webhook: secret header rejected`) = the secret in Telegram (`setWebhook`) differs from `TELEGRAM_WEBHOOK_SECRET`; re-run `setWebhook`. "Code invalid, expired or already used" = codes live 15 minutes and work once; make a new one. No reply from the bot after `/start` on a sleeping free-tier API = the first update waits for the wake-up (about 1 minute, S12); Telegram retries for up to 24 hours. Test message 503 = token not set or Telegram refused (the log line carries the Telegram description, never the token); 429 = one per minute.
- **Reset the link:** Settings -> Unlink (`DELETE /telegram/link`) or `UPDATE app_user SET telegram_chat_id = NULL;`. Link codes: `SELECT expires_at, used_at FROM telegram_link_code;` (only sha256 values are stored). Rotate a leaked secret: change `TELEGRAM_WEBHOOK_SECRET`, redeploy, re-run `setWebhook`; rotate a leaked token in BotFather (`/revoke`), update the variable.
- **Limits:** 200 active alerts (409 beyond); test message 1/min per process; webhook body 64 KiB. Pending alert events for an unlinked chat are D06's concern (sent when linked if younger than 24 h).

## 15. Stock list, search and profile (B03)
- **Empty app:** with zero instruments `GET /stocks` and `/stocks/index` answer an empty list (`count: 0`); the UI says "No stocks yet. Import instruments.csv or add a stock." Instruments come only from the owner (`instruments.csv` or Add stock, B06a).
- **Opening a stock** (`GET /stocks/{symbol}`) stamps `last_opened_at` and, if the stock was not tracked, sets `is_tracked=true, tracked_reason='opened'`. It never enqueues a job in manual price mode. To list what opening has tracked: `SELECT symbol, last_opened_at FROM instrument WHERE tracked_reason = 'opened' ORDER BY last_opened_at;` (the LRU cap of 150 is enforced by D08 housekeeping).
- **"Prices stale" chip wrong?** The rule needs `market_holiday` rows for the current year: without them (`holidays_missing: true`) it only fires after 4 calendar days. Fix by importing the `holidays` file or adding the year to `config/market_holidays.json` and re-running the seed. Today's bar is expected only after 18:00 IST.
- **Search misses a stock:** search is symbol exact/prefix, name prefix, then trigram similarity >= 0.3 on the name, and by default only `kind=equity`, `status=active`; ETFs, delisted or suspended stocks need `kind=` / `status=`. The client index (`/stocks/index`) excludes nothing; the UI filters by flags. The index is cached for 1 hour (`ETag`); a hard refresh gets a new one.
- **Symbol aliases:** an old symbol (`symbol_alias.old_symbol`) answers `{"redirect_symbol":"NEW"}`; a live symbol with the same text wins over an alias.
- **Local tests:** `go test ./internal/instruments ./internal/httpx` (needs Docker or `TEST_DATABASE_URL`).

## 16. Analysis engine: indicators and returns (D05a)
- **What runs:** `compute_analysis` (docs/04 3.7, price-derived half) is a `post_import` hook: per symbol, after re-adjust and detection, it builds `analysis_snapshot.indicators` from valid (non-suspect) `adj_close` bars; after the last symbol it rewrites the price metrics of `screener_row` for the batch. Fundamentals and scores (the `scores` column and the fundamental screener keys) arrive with D05b; until then `scores` is `{}`.
- **By hand:** `python -m worker run compute_analysis [--symbols A,B] [--dry-run]` (default every tracked stock, 10-minute limit, per-symbol isolation) recomputes snapshots and the screener price metrics. Safe to repeat: one row per `(instrument, as_of)`.
- **Inputs:** `price_daily` (owner imports), `market_series` code `NIFTY50` for beta/correlation (no benchmark -> beta null with reason `no_benchmark`), `app_setting.RISK_FREE_RATE` (fraction, default 0.065).
- **Retention and size:** latest 30 snapshots per stock; only the newest keeps the columnar `series`/`analysis` arrays (about 170 KB JSON for 4 years of bars before Postgres compression, so 500 stocks stay under about 85 MB). A trim or delete that leaves fewer than 60 valid bars removes the stock's snapshots and price metrics; snapshots newer than the last valid bar are removed.
- **Symptoms:** a stock with null indicators and `null_reasons.* = insufficient_history` simply has too few bars (SMA200 needs 200, the 52-week range 252, beta 120 aligned returns). Beta null with `insufficient_overlap`: the imported `NIFTY50` series does not cover the stock's dates. A stock missing from the screener's price columns has fewer than 60 valid bars or no snapshot yet; run the CLI job for it.
- **Performance:** about 3.5 s for a stock with 20 years of bars and a benchmark (numpy plus Python loops), well under a second for 3-5 years; a long batch uses the resumable 3.5-minute `post_import` stop.

## 17. Prices and indicators read APIs (B04)
- **Routes:** `GET /stocks/{symbol}/prices` and `GET /stocks/{symbol}/indicators` (read-only; the delete/trim routes stay 501 until the import tasks).
- **Empty states:** 404 `DATA_UNAVAILABLE` with `details.reason` `no_prices_imported` (nothing imported) or, for indicators, `no_history` (fewer than 60 valid bars, or `compute_analysis` has not run: run `python -m worker run compute_analysis --symbols X`).
- **Size budget:** at most 2,000 points. More than 2,000 daily bars become weekly candles (`meta.interval` = `1w`); a 26-year MAX range is about 1,350 candles. Suspect bars are never served.
- **Series shape:** the worker stores the series columnar; the API expands them to `[[date, value]]` pairs (B04-7). If the Analysis tab shows empty charts, check that the newest `analysis_snapshot` row has `indicators.series` (older snapshots keep none, RUNBOOK 16).
- **Warnings:** `UNCONFIRMED_ACTION` appears while a detected split is not confirmed; confirm or reject it in the corporate-actions screen. Adjusted prices ignore unconfirmed actions.

## 18. Owner-data read APIs: fundamentals, shareholding, events, links (B05)
- **What it serves:** `GET /stocks/{symbol}/fundamentals|shareholding|events|links`. Read-only; the API never writes these tables here (B06) and never computes derived metrics (worker D05b). Nothing is fetched from any website: links are strings rendered from `research_links.json`.
- **`CONFIG_DIR`** (default `config`): the API reads `research_links.json` from it at start and refuses to start if the file is missing or invalid (https URLs only, placeholders `{symbol}` and `{name}` only). Restart after editing the file.
- **Derived values:** read from `analysis_snapshot.indicators.fundamentals.<basis>.<Q|A>` (shape in OPEN_QUESTIONS B05-4). Until D05b writes it, `derived`, `ratios` and `valuation` are null with reason `not_computed`; with no owner data at all the reason is `no_data_entered`.
- **Symptoms:** a stock shows standalone figures with a note: no consolidated rows exist for that period type (auto picks consolidated when present). A warning `BASIS_NOT_MIXED` says how many periods of the other basis are hidden. `meta.stale=true` means no successful fundamentals fetch for 120 days (shareholding: latest quarter end older than 135 days). `last_updated` / `last_updated_source` is the per-stock stamp of decision D-R (newest entry among the values shown).

## 19. Mutual fund APIs (B10)
- **Read-only from the database.** `/mf/*` never calls mfapi.in or AMFI; if data looks old, check `ingestion_run` for `ingest_mf_navs` / `sync_mf_schemes` (section 12). A scheme with no NAV rows enqueues one `mf_refresh` when opened (`backfill` block in the response; the per-target cooldown `REFRESH_COOLDOWN_MIN` of section 13 applies and shows `status: none`).
- **Scheme search slow or sequential (MF-12, S10).** The API pool sets `random_page_cost=1.1`. After a bulk insert into `mf_scheme` (first `sync_mf_schemes` run: about 38k rows) the GIN trigram index keeps new entries in a pending list; scans must read it and the planner avoids the index until it is flushed (autovacuum does this). If search is slow right after a big sync run `VACUUM mf_scheme;` or `SELECT gin_clean_pending_list('mf_scheme_name_trgm');`, then `EXPLAIN` the query and expect `Bitmap Index Scan on mf_scheme_name_trgm`. Local measurement (10,000 synthetic schemes, Postgres 16 and 18): 10-65 ms per search, plan on the index; Neon still to be measured by the owner (S10).
- **Returns show "not computed".** `METRICS_PENDING` means no `mf_return_cache` row yet: run `ingest_mf_navs` for the scheme (section 12, it rebuilds `mf_return_cache`) or wait for the nightly run. Null returns carry `return_reasons` (`insufficient_history`, `n/m`, `weekly_nav`).
- **SIP or compare says 404 `DATA_UNAVAILABLE`.** The scheme exists but has no NAV rows; open its page to queue a refresh.
- **Local tests:** `go test ./internal/finmath ./internal/mf ./internal/httpx` (Docker or `TEST_DATABASE_URL`).

## 20. Prices and instruments imports, delete and trim (B06a)
- **Flow:** `POST /imports/{kind}/validate` (multipart field `file`, optional `upload_group`) stores the file in `import_upload` (UNLOGGED, 1 h) and returns the preview; `POST /imports/{kind}/commit` re-validates against the current database, then writes in 5,000-row chunks inside **one** transaction (claim of the upload rows, writes, `import_batch`: all or nothing) and queues `post_import` for the affected stocks. Kinds built: `prices`, `instruments`; the other contract kinds answer 501 until B06b.
- **Limits:** 5 MB / 50,000 rows per file. `IMPORT_PRICES_LARGE_ENABLED=true` raises `prices` to 25 MB / 300,000 rows; set it only after spike S9 passed (`docs/SPIKE_RESULTS.md`). Files are parsed as a stream (memory is bounded by the file bytes, not by row structs; the 300,000-row test peaks below 100 MB of heap growth).
- **Required choice before the first prices commit:** `GET/PUT /settings/prices-adjustment` (`false` = raw, `true` = already adjusted). While it is unset, commit answers `422 PRICES_ADJUSTMENT_UNSET`. Changing it later needs `confirm: true`; stored bars keep their `src_adjusted`. `POST /imports/prices/adjustment-check` reads only the validated upload.
- **Size guard:** `DB_SOFT_LIMIT_MB` (default 380). Commit answers `422 DB_SIZE_LIMIT` when current size plus rows x 130 B would exceed it, and always when the database is already at the limit. Free space only with the owner actions: `DELETE /stocks/{symbol}/prices?from=&to=` (body `{"confirm":true}`, preview via `POST /stocks/{symbol}/prices/delete-preview`) or `POST /prices/trim` (preview via `/prices/trim/preview`). Both write an `import_batch` audit row (`manual_form`) and queue `post_import` (`batch:<id>`).
- **Symptoms:** "upload not found or expired" (404) = more than 1 h passed or Postgres crashed (the table is UNLOGGED and is truncated): validate the file again. A commit that answers 422 with `error_count` although validate was clean means the data changed in between (for example a stock was removed): validate again. `POST_IMPORT_NOT_QUEUED` in a commit response: the data is saved, analytics were not queued; import any file again or enqueue by hand. Bars flagged `suspect` (a move over 50% without a confirmed action, or inconsistent OHLC) are excluded from analytics; confirm the split/bonus or correct the file and re-import.
- **Never:** prices and instruments batches cannot be undone (409). Instruments imports never delete instruments and never overwrite sector, industry or company_type.

## 21. Client IP and proxy hops (B01/B02 review)
- `TRUSTED_PROXY_HOPS` (default 0) decides which `X-Forwarded-For` entry is the caller address used for the login (10/min) and general (120/min) rate limits and for `session.ip`. At 0 the header is ignored (a client cannot rotate it to dodge SEC-10) but behind a proxy every caller then shares the proxy address. Render puts the API behind one proxy, so the deployed value is expected to be **1**; a Vercel rewrite in front may add another hop (2). Valid range 0-5; anything else stops start-up.
- To determine it: log in, then compare your real public address (any "what is my IP" page) with the `ip` column of your newest `session` row. Start at 1, log in again after each change, and use the smallest value for which the stored address equals your real one (if it is a proxy address, the value is too low). Owner check B02-R3 in `docs/OPEN_QUESTIONS.md`.
- Sessions: when the sliding expiry moves (at most hourly) the `session` cookie is re-issued with the new expiry. Change-password guesses are throttled per session and per IP (5 failures, 5 min block doubling to 1 h, in memory); login keeps its own DB lockout.

## 22. Frontend design system and ChartFrame (F02)

- Components live in `apps/web/src/components/ui` and `components/charts`. Charts must go through `ChartFrame` (SVG renderer, `charts/echarts-core.ts` registers only the chart types in use; add a type there when a screen needs it).
- Check commands in `apps/web`: `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm test`, `npm run build`, `npm run build-storybook`, then `npx playwright test` (needs a system Chrome or Edge; it serves `.next` and `storybook-static`, so build both first). Run `VISUAL=1 npx playwright test stories --update-snapshots` to refresh screenshot baselines (win32 only so far, see OPEN_QUESTIONS F02-6).
- Failure mode: if the Playwright web server fails with "already used", a previous run left `next start` (port 3100) or `scripts/serve-static.mjs` (port 6100) running; stop that process and re-run.
- Failure mode: a chart shows a red "could not be drawn" banner when ECharts throws on an option; the data table (Show data) and CSV still work, so no data is lost while it is fixed.
- Licences checked for S15: echarts 6.1.0 Apache-2.0, zrender BSD-3-Clause, lucide-react ISC, Inter OFL-1.1, @tanstack/react-table and react-virtual MIT.

## 23. Import review fixes (B06a review)

- Upload store: at most 10 unexpired `import_upload` rows and 100 MB; a further validate answers 429 `RATE_LIMITED` with `Retry-After` (seconds to the oldest expiry). Expired rows are purged on every validate. Failure mode: if the owner is blocked, commit the waiting uploads or wait; `DELETE FROM import_upload` clears them by hand.
- A commit takes at most 10 uploads and 50 MB in total (422 on `upload_ids`); parts are still loaded in memory together (up to 50 MB).
- `DB_SIZE_LIMIT` now counts only NEW (symbol, date) rows x 130 B and excludes the commit's own upload bytes, so re-importing the same file near the limit works. Validate shows the same figure in `estimated_growth_mb`.
- Contradictory duplicates are detected across the parts of one group (commit error count); dates before 1990-01-01 are row errors; symbols are ASCII-only (`ınfy` is an error, not INFY).
- `refresh_job` enqueue (cooldown, global hourly limit, insert) runs in one transaction under one transaction-scoped advisory lock (see section 25); post_import is unaffected.
- Lone-CR files are refused with a plain message (save as CSV with normal line endings). The API has no CSV export yet; any future export must pass text cells through `importers.SafeCSVCell`.

## 24. Other imports, manual entry, holidays and undo (B06b)
- **Kinds:** `results_quarterly`, `results_annual`, `balance_cashflow`, `fundamentals_long`, `shareholding`, `corporate_actions`, `instrument_meta`, `holidays` use the same validate -> preview -> commit flow as section 20 (5 MB / 50,000 rows, one transaction, chunks of 5,000, the commit re-validates). Templates: `GET /imports/templates/{kind}` (the holidays template is the header only). Screener import is not built (D-5).
- **Holidays:** `holidays.csv` (`date`, optional `description`, `segment`) **replaces every stored holiday of each year present in the file** (any segment, seed or earlier import), so re-importing a corrected file fixes mistakes. Years 2000 to current year + 1. Not undoable. The seed loader leaves years that already have rows alone and the shipped 2026 list is empty: until you import a year, only weekends are non-trading and the app shows the "holiday list missing" notice. Type the dates from the exchange circular yourself; the app never fetches them.
- **Undo:** `POST /imports/batches/{id}/undo` (30 days) deletes the rows tagged with the batch for results, balance/cash-flow, fundamentals-long, shareholding and corporate-action batches. Values the batch overwrote are NOT restored (restore by re-importing the older file). 409 for prices, instruments, holidays, instrument_meta and manual-entry batches, for an already-undone batch and after 30 days. Undo, every commit of these kinds and every manual entry queue `post_import` for the affected stocks.
- **Manual entry:** `POST /stocks/{symbol}/results|shareholding|actions` and `DELETE /stocks/{symbol}/results?period_type=&period_end=&basis=` use the CSV validators; rows are `source=manual` (they win over `csv_import` values for the same period) and each call leaves an `import_batch` of kind `manual_form` with the note ("as per filing dated ..."). Delete removes manual values only.
- **Symptoms:** a row error "renamed to NEW" means the file uses an old symbol; "is delisted" means the instrument status is `delisted` (change it with `instruments.csv` first if that is wrong); a commit that answers 422 although validate was clean means the data changed in between. A corporate action imported on the ex-date of a detected `split_or_bonus` row leaves the detected row open: reject it in the Data tab (B07) so it is not confirmed twice.
- **Never:** no automatic corporate-action application beyond what the owner confirms (an imported or manually entered action counts as confirmed), no fetching of results, holidays or shareholding from any site.

## 25. Refresh jobs, post_import and worker-http hardening (B09/D03 review)
- **Reaper:** `process_queued_jobs` (19:00 IST) first marks `refresh_job` rows `running` for more than 40 minutes as `failed` (`error` starts with `reaped:`); a `post_import` with symbols left becomes `partial` and is resumed. Check: `SELECT id, kind, target, status, error FROM refresh_job WHERE error LIKE 'reaped:%';`. A `running` row stuck for less than 40 minutes blocks new jobs for that target until then; do not edit it by hand unless the worker is known to be down.
- **Stale queued rows of every kind** (an `mf_refresh` that got `409 BUSY` or met a worker outage) are run by the 19:00 job once they are older than 15 minutes; until then `GET /jobs/{id}` shows `queued` and a new click returns that same job.
- **UX note (409 BUSY):** worker-http runs one job at a time. A `post_import` that meets `409 BUSY` (another job running) is not retried by the API; it waits for the 19:00 `process_queued_jobs` run, so imported prices show their analysis up to a day late. Re-trigger sooner by running `python -m worker run process_queued_jobs` (rows must be older than 15 minutes).
- **Hard cap (4 min):** progress is checkpointed after every symbol; a capped `post_import` is `partial` with `error='hard_timeout'` and keeps `remaining`; the 19:00 job continues it. Other kinds become `failed` and keep their stored result.
- **Detected-action note:** sent from worker-http and `process_queued_jobs` through `worker.notify.TelegramNotifier` (egress allow-list, `api.telegram.org`). Without `TELEGRAM_BOT_TOKEN` or a linked chat the note is skipped (log line "owner notification skipped"); the job still succeeds.
- **worker-http:** bodies over 4 KiB are `413` before authentication. The replay guard is in memory: a restart reopens the 120 s window for a captured request; the queued-status check (a replayed job is no longer `queued`) bounds the impact.
- **Refresh limits:** cooldown, global hourly limit and insert run in one transaction under an advisory lock, so parallel clicks on different targets cannot exceed `REFRESH_GLOBAL_PER_HOUR`.
- **Detector:** suspect bars are excluded from the 20-bar volume average; candidates whose compared bars are more than 14 calendar days apart appear under `low_confidence` in the `detect_actions` summary (interim, OPEN_QUESTIONS D03R-1).

## 26. Alerts evaluator and Telegram sender (D06)

- **Evaluation (manual price mode):** per symbol at the end of `post_import` (hook `evaluate_alerts`) and for all active alerts in the EOD job `python -m worker run evaluate_alerts` (19:30 IST Mon-Fri, 8 min; not scheduled by any workflow yet, D06-13). Each alert runs in its own transaction under a row lock; events are inserted with `ON CONFLICT (alert_id, dedupe_key) DO NOTHING`, the key carries the bar date, so reruns and concurrent runs never duplicate. Only bars newer than `alert.last_state.last_bar_date` can fire.
- **Delivery:** after the last symbol of a `post_import` job (after the screener recompute) and at the end of the EOD job. Order of checks: no linked chat (events stay `pending`, `last_error=not_linked`, failed after 24 h) -> no bot token (stay `pending`, `last_error=bot_not_configured`) -> quiet hours (`app_user.quiet_hours`, held) -> send. More than 10 events in a pass become digest messages; sends are 1.1 s apart; a failure is retried every 15 minutes up to 5 times (6 attempts) then `failed`; a Telegram 429 stops the pass.
- **Telegram is not set up yet (D-9):** everything above works without `TELEGRAM_BOT_TOKEN`; alerts fire and wait. Owner steps when ready: create the bot with BotFather, set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET` (worker and API), register the webhook, link the chat from Settings. Pending events younger than 24 h are then delivered by the next run; older ones are already `failed (not_linked)`.
- **Failure modes:** a pending pile with `last_error=bot_not_configured` means the token is missing in the worker environment; repeated `telegram_http_4xx` in `alert_event.last_error` means a blocked bot or a bad chat id (re-link); `telegram_http_400 ... parse entities` would be a message-escaping bug (report it, add a test row). Errors never contain the token (the URL carries it; only status and Telegram's description are stored). The sender uses `worker/egress.py` only; `api.telegram.org` is on the allow-list.
- **Tests:** `tests/test_alerts_eval.py`, `tests/test_alerts_delivery.py` (fixtures in `fixtures/telegram/`, synthetic Bot API shapes, no token), `tests/test_alerts_db.py` (needs `TEST_DATABASE_URL`).

## 27. Read-API review fixes (B03, B04, B05, B10)
- **Profile says no prices but the owner imported some.** The profile counts valid bars only (the rows `/prices` serves). Bars flagged `suspect` by the import checks are hidden everywhere (BRK-08); fix or re-import them (section 20).
- **Fundamentals show old ratios.** `data.derived_as_of` is the date of the `analysis_snapshot` behind derived values, ratios and valuation. The warning `DERIVED_STALE` means values were entered after that snapshot: run `compute_analysis` (worker) or wait for the nightly run. `MIXED_SOURCES` only informs that a metric mixes manual and imported periods.
- **MF search shows an older NAV than the detail page.** Search takes the NAV and its date from `mf_return_cache`; after `ingest_mf_navs` the cache is rebuilt and both move together. A scheme without a cache row shows no NAV in search.
- **A request with `%00` or invalid UTF-8 returns 422 or 404.** This is intended: Postgres cannot store NUL bytes. A 500 for such input would be a regression (tests `TestNulAndInvalidUTF8AreRejected`, `TestMFParamsRejectNulAndInvalidUTF8`).
- **SIP shows fewer installments than months.** Installments dated before the first NAV, or whose next NAV is after `end`, are skipped and counted (`skipped_installments`).
- **XIRR is null with `no_solution`.** All flows on one date summing to zero, no sign change in [-0.9999, 100], or no convergence in 200 iterations; never a made-up rate.
- **Local tests:** `go test ./internal/finmath ./internal/mf ./internal/prices ./internal/ownerdata ./internal/httpx -race` (Docker or `TEST_DATABASE_URL`).

## 28. Watchlist and portfolio (B11)

- Routes: `/watchlist` and `/portfolio/*` (docs/03 sections 11-12). Everything is computed on request from `portfolio_txn`, confirmed `corporate_action` rows, `portfolio_adjustment` overrides and `price_daily`; nothing is cached, so a prices import or an action confirmation shows on the next summary call.
- Writes lock the instrument with `pg_advisory_xact_lock(7011, instrument_id)` and replay the whole symbol sequence before commit; a rejected edit changes nothing.
- Idempotency: table `idempotency_key` keeps the response for 24 h; expired rows are purged on the next claim. A lost response is safe to retry with the same key.
- Failure mode `HOLDINGS_INCONSISTENT` warning in the summary: stored transactions no longer pass the holdings check (for example a confirmed split was edited or removed after a sell). The symbol is excluded from totals; fix the action (or add an override) or the transactions.
- Failure mode: totals show a null market value with `missing_price: SYM`: import a `prices.csv` containing that symbol.
- Owner action: review warnings `REVIEW_NEEDED` (rights, buyback, merger, demerger, split_or_bonus) and `UNCONFIRMED_ACTION`; these are never applied to quantities automatically.

## 29. Formatters, definitions and search palette (F03)

- All text for numbers, dates and labels comes from `apps/web/src/lib/format` (every formatter returns `{ text, reason, direction }`; unknown gives an em dash plus the reason). Do not call `toFixed`, `toLocaleString` or `Intl` in components. The chart and table defaults now use `formatNumber`.
- `src/lib/definitions.ts` is generated from `docs/05-analytics-spec.md` by `npm run gen:definitions` (in `apps/web`). Run it after editing a formula line in docs/05; a unit test fails when the file is stale, and generation fails (names the key) when a spec line the generator anchors on was reworded. Add a new definition by adding a row to `ENTRIES` in `scripts/gen-definitions.mjs`.
- Search palette (`components/search/SearchPalette.tsx`, mounted in the top bar): the stock index (`GET /stocks/index`) is cached in IndexedDB (`analyzer-search`, key `stocks-index`) and recent picks in `localStorage` (`analyzer-recent-searches`). Failure mode: if the list looks old after an import, clear site data for the app or wait for the 1 h background revalidation; if `/stocks/index` fails the palette shows a notice and uses `GET /stocks?q=`; if `/mf/schemes` fails it shows "Fund search is unavailable right now." and stocks still work.
- No new npm dependency (tests inject `fetch`; no MSW). Browser requests go only to same-origin `/api/v1/*`.

## 30. Import center, storage and manual deletes (F13a)
- Page `/imports` (tabs Upload, Templates, Manual forms, Storage). The browser only calls `/api/v1` (same origin, CSRF header on every non-GET). Uploads are multipart through the Next rewrite, so the host's request-body limit applies (spike S9). If a few-MB prices file fails with a 413 from the proxy, record it in `docs/SPIKE_RESULTS.md` S9 and decide on the browser-split fallback (D-G).
- Prices wizard: choose the file, read the errors (row and column), choose raw / already adjusted (required once; "I don't know" runs the Adjustment check), read the growth estimate, commit. Prices and instruments batches cannot be undone: fix by re-importing, Trim history or Delete prices.
- Storage tab: meter against 380 MB (marks 70/85/95%). It needs `GET /admin/status`; while that returns 501 the meter shows "not available" and the server still blocks at the limit. Trim history and Delete prices ask for a preview and a confirmation; both enqueue `post_import` for the affected stocks.
- Failure mode: "This upload expired" after a long pause (uploads live 1 hour): upload the file again. "Choose whether the prices are raw or adjusted": set the choice on the review step.
- Failure mode: `npm run build` in `apps/web` exits 1 with a Next.js security advisory message after a successful compile (F13a-10): upgrade `next`.
- Checks: `npm test` (unit; mocks in `tests/mocks`); `npx playwright test tests/e2e/imports.spec.ts` after `npm run build` (port 3100 must be free).

## 31. Frontend review fixes for F01/F02

- Touch targets: the root font size is 14 px, so Tailwind rem classes are 12.5 percent smaller than their names (`h-11` is 38.5 px). Use the `touch-target` utility (`globals.css`, 44 px minimum below 1024 px and on coarse pointers) on every new button or link; the Playwright test `UI-26` fails for any `button[data-testid]` or `a[data-testid]` under 44 px at 375 px (the visually hidden skip link is the only exclusion).
- Dialogs and drawers (`ui/overlays.tsx`): the `open` prop is the source of truth. If a browser closes a modal natively while the parent still says open (second Escape without user activation), `onClose` is called and the dialog is re-opened. Backdrop click intentionally does nothing.
- Login redirect (`middleware.ts`) clones `request.nextUrl`. A relative `Location` header was tried and rejected: Next's middleware adapter throws `Invalid URL` (HTTP 500) on it. Behind Render the public `Host` header must be forwarded so the redirect stays on the public origin.
- External links must use `ui/ExternalLink` (adds `rel="noopener noreferrer"`); `tests/unit/repo-guards.test.ts` fails on any other `target="_blank"`.
- `npm run build` in `apps/web` currently ends with `SecurityFatalError` (the installed Next.js 16.4.0 is flagged by the advisory service); the compile and page generation steps pass and the output serves. Upgrading Next is a separate task.

## 32. Next.js security bump and the advisory gate

- Next.js was bumped from 16.4.0 to 16.4.1 (owner approved) because `next build` failed with `SecurityFatalError`: 16.0.0 to 16.4.0 are affected by GHSA-2464-fhr4-w9xw, GHSA-p3m5-59mp-jv5r and GHSA-673q-mjm6-r5xr. `eslint-config-next` moved to the same version.
- The advisory gate runs inside `next build` (it queries the npm advisory service). Any future advisory against the installed Next.js version will fail the web CI job until it is bumped, so merge Renovate PRs for `next` promptly.

## 33. Import undo and manual-entry review fixes (T02, B06b, B08)

- **Undo refused with 409 `UNDO_HAS_DEPENDENTS`:** an imported corporate action is used by a portfolio adjustment (B11). Nothing was changed. Open the portfolio, remove the adjustment for that action, then undo again. The undo never deletes portfolio data.
- **Undo warnings:** `UNDO_REMOVES_EARLIER_IMPORT` means the same file had been imported before and a re-import re-tags the rows, so the undo also removed values that existed before this batch; overwritten values are never restored, so import the correct file again. `UNDO_REMOVED_NOTHING` means a later import took the rows over; undo the newest batch instead. `POST_IMPORT_NOT_QUEUED` (also on manual entries and manual deletes) means the data is saved but analytics were not queued: import any file again or enqueue by hand.
- **Numbers:** exponent notation such as `1e5` is rejected on purpose ("exponent notation not accepted"); write 100000. Manual `values` keys that differ only by case are a 422.
- **Holidays:** a year with only `clearing` holiday rows counts as having no holidays (calendar reads use the `trading` segment), so the seed fills it and `holidays_missing` is true until trading holidays exist.

## 34. D01/D04/D05a review fixes (apps/worker)

- **AMFI status floor.** `sync_mf_schemes` refuses status changes when the AMFI file has under 5,000 rows or under 50% of the previous applied file. The run ends `partial` with `details.status_skipped` (for example `amfi_rows_below_floor: 1 < 5000 (previous 38000)`); rows are still upserted. Check `details.amfi_rows`, `amfi_rejected`, `amfi_reject_reasons` and `amfi_duplicates`. After a legitimate large AMFI change (for example a merger wave) run it twice: the second run still compares with the last applied file, so lower `AMFI_MIN_FRACTION` temporarily only on the owner's instruction.
- **Size caps.** A response over the cap (AMFI 10 MB, mfapi list page 30 MB, history 8 MB) fails the item with `SchemaError: ... response too large`. It is not retried and does not trip the breaker. If AMFI really grows past 10 MB, raise `adapters/amfi.MAX_BYTES` and record it here.
- **Breaker.** `source_health` is updated under a row lock; concurrent jobs no longer lose failures. The probe-success counter is in memory: after a worker restart a half-open source needs 3 fresh successes (D01-A1).
- **Incremental NAV fetch** now re-fetches the last stored date, so a corrected NAV is picked up on the next `ingest_mf_navs` (D04R-2).
- **Snapshots.** Rows with a zero, negative or non-finite price are dropped with a warning in `analysis_snapshot.indicators.warnings`; investigate the import if `dropped N bar(s)` appears. A NaN volume only nulls volume-based metrics. The snapshot and cache writers raise on NaN/Infinity instead of storing it.
- Tests for all of this are in `apps/worker/tests/test_review_d01_d04_d05a.py` (MF-110..118, SYS-33..35, IND-93, RET-94..96).

## 35. Review fixes for B11, B12 and D06

- Delivery: every pass first expires never-attempted `pending` events older than 24 h as `failed(not_linked)`, linked or not, so linking late never floods old alerts. `expired` is part of the job summary.
- `results_declared` / `holding_change`: the baseline of a first evaluation is the data present at alert creation (`fetched_at <= created_at`). If a re-imported old quarter fires unexpectedly, that is why (D06-14).
- Telegram link: a second chat cannot take over while one is linked. To move to a new chat, call `DELETE /telegram/link` (Settings, Telegram), create a new code and send `/start <code>` from the new chat. After 10 failed `/start` attempts in 15 minutes the API ignores `/start` silently until the window passes (restart clears it). `POST /telegram/webhook` is limited to 60/min per IP; rejected secrets log at Debug and a Warn every 100th (`rejected_total`).
- Portfolio: the benchmark XIRR may use negative NIFTY units (B11-10); a closed position uses first-to-last-flow for the 30-day rule; a buy is accepted on a stock whose sequence already reports `HOLDINGS_INCONSISTENT` (fix it with an override or by editing the offending sell); `POST /portfolio/adjustments` rejects an override that breaks the sequence.

## 36. Corporate action confirm/reject (B07)

- `PATCH /stocks/{symbol}/actions/{id}` confirms or rejects a `detected` split/bonus candidate. Confirm needs `action_type` (split or bonus) and `ratio_num`/`ratio_den` (docs/05 8.2 conventions) and takes a row lock, so concurrent confirms change the row once. The response carries `multiplier` and a warning when it differs more than 3% from the detected 1/r.
- After the commit the API queues `post_import` (target `action:<id>`, symbol in `result.remaining`) through the signed worker caller; the worker re-adjusts `adj_close` (confirmed actions with ex_date <= today IST, `src_adjusted=false` bars only) and recomputes analysis. A reject also queues it so the UNCONFIRMED_ACTION warning clears.
- Failure modes: `POST_IMPORT_NOT_QUEUED` warning (decision saved; repeat the PATCH to retry, or run `python -m worker run readjust_prices --symbols X`); 409 "would adjust the history twice" means a manual or CSV split/bonus already sits on that ex-date: reject the detected candidate. A rejected date is never re-detected; to apply it anyway, enter the action manually.

## 37. F03/F13a review fixes in apps/web

- Confirmations that start a write (Commit import, Trim history, Delete prices, Change setting) go through `ConfirmDialog` with `busy` and the `useSingleFlight` guard (`lib/imports/single-flight.ts`). If a commit ever shows "expired, upload again" right after a success, check the browser network log for two POSTs to `/imports/{kind}/commit` before suspecting the 1 hour upload TTL.
- The Import center formats numbers and dates only through `lib/format` (`lib/imports/local-format.ts` is gone; a repo test keeps it gone). Unknown values show a dash with the reason as a tooltip (`components/imports/Fmt.tsx`).
- The stock index cache treats a future `fetchedAt` (system clock moved back) as stale. If the palette seems to show an old list, clear the `analyzer-search` IndexedDB database in the browser.
- Local e2e: `npm run build` bakes `API_BASE_URL` into the rewrites. Build with `API_BASE_URL=http://127.0.0.1:9` (as CI's closed-port intent) when another process answers on `localhost:8080`, otherwise the shell tests get a 401 from that process and are redirected to `/login`. Ports 3100 and 6100 are fixed in `playwright.config.ts`; two parallel runs on one machine collide.

## 38. Login and dashboard (F04)

- `/login` posts `{password}` to `/api/v1/auth/login` with the CSRF header, then does a full navigation to the validated `next` (`safeNext`); the session cookie is httpOnly and never read in JS. A wrong password and a lockout show the same message. There is no recovery link: reset the password with the CLI described in the password section of this runbook.
- The dashboard calls `/watchlist`, `/portfolio/summary`, `/alerts/events`, `/broker/status`, `/market/overview`, `/admin/status` and `/stocks/{symbol}/events`. `501 NOT_IMPLEMENTED` and `404 DATA_UNAVAILABLE` render an empty card with the reason; other failures render an error card with Retry and the request id. If a card shows an error, quote the request id and search the API logs for it.
- Index tiles stay empty with a reason until `NIFTY50` and `INDIAVIX` rows are imported through `prices.csv` (IMP-21) and the market overview endpoint exists.
- The "stale" chip on the last price import counts weekends only; it can say stale after a trading holiday (F04-4).
- E2E: `tests/e2e/f04-login-dashboard.spec.ts` mocks the API with Playwright routes; no backend is needed.

## 39. Stock page: header and Overview (F05)

- Route `/stocks/{symbol}?tab=overview|chart|analysis|fundamentals|ownership|peers|prediction|events|data`. Only Overview is built; the other tabs say so. An alias symbol redirects with `router.replace` and a toast; an unknown symbol shows "No stock with the symbol X" with search advice.
- Data: `GET /stocks/{symbol}` (60 s), `/prices?range=1Y&adjusted=true` (5 min), `/indicators` (10 min), `/events`, `/links`, `/fundamentals` (KPI ratios). Browser calls go only to same-origin `/api/v1`; research links are plain `ExternalLink` anchors that the app never fetches.
- Manual price mode (current): no Refresh button; chip "Last price import: {date}" (amber with the word "stale" from `freshness.prices_stale`), "Import prices" link, "Holiday list missing" chip from `freshness.holidays_missing`, manual-mode banner. Header price is the last imported close (assumption F05-1).
- Failure modes: KPI, gauges and scores show a dash with `not computed yet` until D05b writes the snapshot (not a bug). A card that errors shows Retry; the rest of the page stays. `DATA_UNAVAILABLE` (`no_prices_imported`, `no_history`) shows the reason, never 0.
- Notices that wait for B07: Confirm / Reject on the UNCONFIRMED_ACTION banner and Dismiss on the soft-flag notice are disabled with a reason; the soft flag is derived in the browser (20% one-day drop, assumption F05-5). When B07 ships, fill `apps/web/src/lib/stock/soft-flag-adapter.ts`.
- Tests: `npm test` (`stock-page.test.tsx`, `stock-derive.test.ts` incl. the UI-09 field map in `docs/field-map.json`); `npx playwright test tests/e2e/stock.spec.ts` after `npm run build` (port 3100 must be free).

## 40. Playwright ports and the e2e build

- `playwright.config.ts` serves the production build on port 3100 and Storybook on 6100. If another process holds them, set `PW_PORT` / `PW_STORY_PORT` (defaults unchanged); the specs read the same variables through `apps/web/tests/e2e/ports.ts`.
- The `/api` rewrite is baked in at `next build`. Locally use `npm run build:e2e` (builds with `API_BASE_URL=http://127.0.0.1:9`) so a Go API on localhost:8080 cannot answer e2e requests. CI has no API running, so plain `npm run build` is fine there.

## 41. Stock page review fixes (F05R)

- The UNCONFIRMED_ACTION sentence takes its percentage from the served bars, else from the detected action's ratio (`ratio_num/ratio_den - 1`, from `/events`); without either the clause is left out. If a banner lacks "price changed", check that `/events` returned the detected action with a ratio before suspecting the bars.
- The soft flag comes only from `lib/stock/soft-flag-adapter.ts` (`getSoftFlags`, `getSoftFlagCoverage`). When the server flag arrives (D-W 3) replace those two bodies; nothing else changes.
- Disabled actions show their reason as visible text (`aria-describedby`), never only a tooltip.
- The watchlist star reads `GET /watchlist` (profile `tracked` is also set by opening a stock, so it is not membership). `docs/field-map.json` entries may be `conditional:<testid>|<condition>` or `not-rendered|<reason>`; the UI-09 test enforces both forms.
- A symbol outside the API charset shows not-found with no request. Fundamentals and links load together with the other four calls.
- Playwright UI-40 now measures every interactive element inside the stock page at 375 px (44 px). If it fails, add `touch-target` and a 44 px height to the control.
