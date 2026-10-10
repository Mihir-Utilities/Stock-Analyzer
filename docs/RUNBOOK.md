# RUNBOOK (kept up to date by every task)

## 1. Daily routine
- Manual price mode (current): after market close, upload the day's `prices.csv` in Import center. Alerts and analytics run automatically right after the import (`post_import`) and at 19:30 IST (EOD). Alerts say "as of the last price import".
- First setup: import `instruments.csv` (or use Add stock), then `prices.csv`.
- Watch DB size (Import center > Storage). Notices at 70/85/95% of 380 MB; at 380 MB price imports are refused. Nothing is deleted automatically: free space with Trim history or Delete prices.
- Broker reconnect is not applicable (broker mode dormant).
## 2. Deploy
(Fill during T00/T02/B01/F01: Neon setup, Render services (API + worker-http), Vercel project, GitHub secrets, environment variables from .env.example.)
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
(cd apps/web && npm ci && npm run lint && npm run format:check && npm run typecheck && npm test && npm run build)
```
Adding a dependency: run `python scripts/license_scan.py --write` and commit the regenerated `THIRD_PARTY_NOTICES.md`. The scan fails on GPL/AGPL and unknown licences; MPL-2.0 and LGPL packages are listed as **Review** (OQ-8).
The deny-list scans code, manifests and lockfiles only (not `docs/`, `tasks/`, `*.md`); `config/research_links.json` is exempt (plain hyperlinks the app never requests).
## 4. Failure modes and responses
| Symptom | Likely cause | Action |
|---|---|---|
## 5. Backup and restore drill
(Fill in D08.)
## 5a. Repository settings (owner, once, on GitHub)
Branch protection for `main` (Settings > Branches): require a pull request, require the status checks **guards**, **api**, **worker** and **web** to pass and be up to date, block force pushes and deletion. The repository is public: secrets live only in GitHub Actions secrets and host environment variables; never commit `.env` or real data. Install the Renovate GitHub app (or use the hosted one) so `.github/renovate.json` takes effect.
## 6. Plan B
- Render free hours exhausted; broker blocks cloud IP; Neon limit reached; GitHub schedule disabled.
## 7. Incident log
(none yet)
