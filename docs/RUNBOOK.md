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
(cd apps/web && npm ci --ignore-scripts && npm run lint && npm run format:check && npm run typecheck && npm test && npm run build)
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
