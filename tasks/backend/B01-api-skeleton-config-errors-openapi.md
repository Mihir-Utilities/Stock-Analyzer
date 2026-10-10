# B01 - API skeleton, config, errors, OpenAPI

| Field | Value |
|---|---|
| Track | backend |
| Depends on | T00, T02 |
| Size | M (S < 0.5 day, M 0.5-1.5 days, L 1.5-4 days of focused work) |

## Read first
- docs/03-api-spec.md sections 1, 15, 16
- CLAUDE.md sections 3-5
- `CLAUDE.md` (rules), `docs/00-legal-and-safety.md` (Safe Edition guards)

## Goal
Create the Go API foundation: config, logging, routing, error envelope, health, OpenAPI and generated TypeScript types.

## In scope
- chi router, config from env with validation, zerolog JSON logs with request ids and a secret scrubber
- Success/error envelope helpers, `meta` and `warnings` support, pagination helpers (keyset cursors)
- `/healthz` (no DB) and `/readyz` (auth, DB ping)
- `openapi.yaml` generated from the spec and kept in sync; generated Go server types and TS client types
- Security headers middleware, request size limits, timeouts
- Rate-limit middleware (in-memory token bucket) with `Retry-After`

## Out of scope (do not do in this task)
- Auth (B02)
- Any business endpoint

## Deliverables
- `apps/api/cmd/api`, `internal/{config,httpx,logx,pagination}`
- `openapi.yaml`
- `packages/api-types` (generated TS)

## Steps
1. Implement config + validation (fail fast on missing secrets)
2. Implement envelope/error mapping exactly as the spec
3. Write OpenAPI covering all endpoints in the spec as stubs returning 501 with the error envelope
4. Generate TS types and publish to the monorepo workspace
5. Add log scrubber unit tests for cookie/token/password patterns

## Acceptance criteria (all must be true)
- [ ] `/healthz` returns `{ok:true}` without touching the DB
- [ ] Unknown route returns the error envelope
- [ ] OpenAPI validates; TS types compile
- [ ] Scrubber test passes (SEC-08)

## Required tests (from `docs/07-edge-cases-tests.md`)
- `SEC-08` (see `docs/07-edge-cases-tests.md`)
- `SEC-10` (see `docs/07-edge-cases-tests.md`)
- `API-01` (see `docs/07-edge-cases-tests.md`)
- `SYS-01` (see `docs/07-edge-cases-tests.md`)

## Definition of done
- [ ] Behavior matches the cited spec sections exactly (note section numbers in the PR description).
- [ ] Tests above exist, run in CI and pass; new edge cases discovered are added to `docs/07-edge-cases-tests.md`.
- [ ] Loading/empty/partial/stale/error states implemented for any UI work.
- [ ] No secrets or personal data in code, logs or fixtures; deny-list check passes.
- [ ] `docs/RUNBOOK.md` updated for any new variable, job or failure mode.
- [ ] Questions or spec conflicts recorded in `docs/OPEN_QUESTIONS.md` instead of guessed.
