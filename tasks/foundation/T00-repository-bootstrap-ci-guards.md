# T00 - Repository bootstrap, CI, guards

| Field | Value |
|---|---|
| Track | foundation |
| Depends on | none |
| Size | M (S < 0.5 day, M 0.5-1.5 days, L 1.5-4 days of focused work) |

## Read first
- PLAN: MASTER_PLAN.md sections 3-5
- docs/00-legal-and-safety.md section 1
- CLAUDE.md
- `CLAUDE.md` (rules), `docs/00-legal-and-safety.md` (Safe Edition guards)

## Goal
Create the monorepo, tooling, CI and the automated safety guards so every later task builds on a clean base.

## In scope
- Monorepo layout (`apps/web`, `apps/api`, `apps/worker`, `db/migrations`, `docs`, `fixtures`, `config`, `.github/workflows`)
- Go module, Python project (uv), Next.js app skeletons that build and run a hello-world
- Lint/format/type-check configs (golangci-lint, ruff, mypy strict on worker adapters/analytics, ESLint, Prettier, TypeScript strict)
- CI workflow: lint, type-check, unit tests, build for all three apps; Postgres service for integration tests
- `.env.example` with every variable named in the specs, no values
- Deny-list test (SAF-01/02) scanning code and dependencies for forbidden libraries/hostnames (scan source code and lockfiles only; `config/research_links.json` is exempt because it contains plain hyperlinks the app never requests)
- Licence scan (SAF-04) and `THIRD_PARTY_NOTICES.md` generation
- `docs/RUNBOOK.md`, `docs/SPIKE_RESULTS.md`, `docs/OPEN_QUESTIONS.md`, `docs/TERMS_NOTES.md` skeletons; `config/market_holidays.json` and `config/research_links.json` skeletons

## Out of scope (do not do in this task)
- Any business logic
- Any database schema (T02)

## Deliverables
- Repository tree as in CLAUDE.md section 1
- `.github/workflows/ci.yml`
- `apps/*` skeleton projects
- `scripts/deny_list_check.*`, `scripts/license_scan.*`

## Steps
1. Initialise git, create folders, add toolchains and pinned lockfiles
2. Write CI with matrix per app and a Postgres service
3. Implement the deny-list check (forbidden: yfinance, nsepython, nseindia.com, finance.yahoo, screener.in fetch code paths, news RSS libs) and wire it into CI
4. Implement licence scanning for Go, Python, npm; fail on GPL/AGPL/unknown
5. Add the doc skeletons and config skeletons
6. Make `main` branch protected by CI in the repo notes

## Acceptance criteria (all must be true)
- [ ] CI is green on an empty project
- [ ] Deny-list check fails when a forbidden package is added (demonstrate with a throwaway branch)
- [ ] Licence scan produces `THIRD_PARTY_NOTICES.md`
- [ ] `.env.example` lists all variables from the specs

## Required tests (from `docs/07-edge-cases-tests.md`)
- `SAF-01` (see `docs/07-edge-cases-tests.md`)
- `SAF-02` (see `docs/07-edge-cases-tests.md`)
- `SAF-04` (see `docs/07-edge-cases-tests.md`)
- `SYS-11` (see `docs/07-edge-cases-tests.md`)
- `SAF-07`, `SAF-08` (added during T00, see `docs/07-edge-cases-tests.md`)

## Definition of done
- [ ] Behavior matches the cited spec sections exactly (note section numbers in the PR description).
- [ ] Tests above exist, run in CI and pass; new edge cases discovered are added to `docs/07-edge-cases-tests.md`.
- [ ] Loading/empty/partial/stale/error states implemented for any UI work.
- [ ] No secrets or personal data in code, logs or fixtures; deny-list check passes.
- [ ] `docs/RUNBOOK.md` updated for any new variable, job or failure mode.
- [ ] Questions or spec conflicts recorded in `docs/OPEN_QUESTIONS.md` instead of guessed.
