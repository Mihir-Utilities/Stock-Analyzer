# CLAUDE.md: Rules for implementing the India Stock & MF Analyzer (Safe Edition)

You are implementing a single-user, private research app. The specification is the source of truth. At the start of every session read `MASTER_PLAN.md`, `docs/00-legal-and-safety.md` and `tasks/README.md`; for each task read the task file and **only** the spec sections it cites (plus anything it links to).

## 0. Prime directives
1. **Safe Edition guards are non-negotiable.** Automated fetching only from: mfapi.in, the AMFI NAV file, the owner's own broker API (read-only, owner performs login), Telegram Bot API. Never implement or call NSE/BSE websites or endpoints (including `nsepython`), Yahoo Finance/`yfinance`, Screener scraping, news scraping or any site whose terms prohibit automated access. No order placement code or order scopes anywhere. The CI deny-list must fail if any appear.
2. **Do not guess.** If a spec is silent, ambiguous or conflicting, stop and write the question to `docs/OPEN_QUESTIONS.md` (and ask the owner). Never invent endpoints, columns, formulas, thresholds, broker behaviors or copy.
3. **Spikes before code.** Anything marked `U`/unverified in the specs must have a GO verdict in `docs/SPIKE_RESULTS.md` before you build on it. If a spike is NO-GO, amend the specs, tell the owner, and wait.
4. **Every spec row gets a test.** Each row in `docs/07-edge-cases-tests.md` assigned to your task and each formula in `docs/05-analytics-spec.md` must have an automated test before the task is done. Add new rows when you find new edge cases.
5. **Honesty in the UI.** Every number shows unit, source and as-of (or a reason when null). Forecasts always carry the experimental banner and never show a single target price. Never show `0`, `NaN` or `Infinity` for unknown values.
6. **Be a polite client.** Respect throttles, backoff and circuit breakers (`docs/01-data-sources.md` section 1). Never automate the owner's broker login or store their broker password/TOTP secret.
7. **No secrets in code, logs, fixtures or backups.** Environment variables only; broker tokens encrypted at rest; scrub logs.
8. **Small and boring.** No extra frameworks or features beyond the spec; no premature abstraction beyond the documented interfaces.

## 1. Repository layout (create exactly)
```
apps/web  apps/api  apps/worker  db/migrations  docs/  fixtures/  config/  tasks/  .github/workflows
MASTER_PLAN.md  CLAUDE.md  README.md  PROMPT_FOR_CLAUDE_CODE.md  .env.example
```
Also maintain: `docs/RUNBOOK.md`, `docs/SPIKE_RESULTS.md`, `docs/BROKER_DECISION.md`, `docs/OPEN_QUESTIONS.md`, `docs/TERMS_NOTES.md`, `docs/field-map.json`, `THIRD_PARTY_NOTICES.md`, `openapi.yaml`.

## 2. How to work
- One task file at a time from `tasks/` in the order of `tasks/README.md`. Do not start a task whose dependencies are not done.
- Before coding: restate the task's scope, out-of-scope and acceptance criteria in 5-10 lines and list the files you will create/change. After coding: run the full test suite, tick the acceptance checklist, summarize what changed and what remains.
- Contract-first: `docs/03-api-spec.md` -> `openapi.yaml` -> generated types. Changing a contract means updating the spec, OpenAPI and `docs/field-map.json` together.
- Commit per task with a conventional message; CI must pass.

## 3. Conventions
**Go (apps/api):** Go 1.22+, chi, pgx, sqlc, goose, zerolog JSON logs, `context` everywhere, thin handlers, validation layer, errors mapped to the envelope in `docs/03-api-spec.md`, decimals via `shopspring/decimal` for money. Table-driven tests; integration tests with testcontainers.
**Python (apps/worker):** 3.11+, uv, type hints with `mypy --strict` on adapters/analytics, ruff, pydantic v2 for validation, `httpx` async with the shared limiter/breaker, pandas/numpy, pytest with recorded fixtures (no live network in tests), `Decimal` for portfolio math.
**TypeScript (apps/web):** strict, ESLint + Prettier, no `any`, zod-validated API data, all formatting via `format.ts`, tokens only (no ad-hoc colors), ECharts via `ChartFrame` only, every interactive element has `data-testid`.
**SQL:** forward-only goose migrations; never edit applied ones; `INSERT ... ON CONFLICT` for ingestion; parameterised queries only.
**Data/time:** market dates are IST `DATE`; timestamps UTC; expected trading date from the holidays file + weekends; use `adj_close` for returns (price return, dividends excluded); percent API fields are percent numbers (12.34 = 12.34%); ML probabilities and band returns are fractions.

## 4. Security checklist (verify in every PR touching these areas)
argon2id + hashed session tokens + lockout; CSRF header on non-GET; input validation and whitelists (screener metrics); no SQL concatenation; HMAC (timestamp window) on worker endpoints; secret-header check on the Telegram webhook; CSP and security headers; `rel="noopener noreferrer"` on external links; HTML-escape dynamic text (UI and Telegram); upload size/type limits and read-only parsing; CSV-injection-safe exports; broker token encryption (AES-256-GCM).

## 5. Definition of done (per task)
Matches the cited spec sections exactly; tests added/updated and passing; edge-case rows covered; UI states (loading/empty/partial/stale/error) implemented; structured logs, no secrets; `docs/RUNBOOK.md` updated for operational changes; performance budgets not regressed; open questions recorded.

## 6. When a data source or parser breaks
Reproduce with a fixture -> add a failing test -> fix the adapter -> keep the last good data -> do not widen scraping or add forbidden sources to compensate -> record the incident in `docs/RUNBOOK.md`.

## 7. Never
Add multi-user features, public pages or sharing of forecasts; call third-party sites from the browser or the Go API; embed iframes of other sites; store plaintext secrets; auto-apply corporate actions that the owner has not confirmed; present estimates or model output as fact; exceed free-tier budgets knowingly.
