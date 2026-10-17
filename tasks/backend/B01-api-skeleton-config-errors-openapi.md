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
- **Egress allow-list (D-N):** the Go API never calls third-party sites (CLAUDE.md section 7). The only outbound HTTP client is `internal/egress`, whose transport allows only the host of `WORKER_BASE_URL` (plus `api.telegram.org` once B12 needs it), https/http as configured, no redirects to other hosts. golangci `forbidigo`/`depguard` forbid `http.Get`, `http.Post`, `http.DefaultClient` and `http.Client{}` outside that package

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
- [x] `/healthz` returns `{ok:true}` without touching the DB (`TestHealthzDoesNotTouchDatabase`: pinger never called; live smoke run returned `{"ok":true}`)
- [x] Unknown route returns the error envelope (`TestUnknownRouteAndMethodReturnEnvelope`, `TestNotFoundErrorShape` = API-01)
- [x] OpenAPI validates; TS types compile (`TestOpenAPIValidates` with kin-openapi, `TestRoutesMatchOpenAPI`; `npm run generate` and `npm run typecheck` in `packages/api-types` clean; CI job `api-types`)
- [x] Scrubber test passes (SEC-08) (`TestScrubberRedactsSecretPatterns` 13 cases, `TestLoggerEmitsScrubbedJSON`)
- [x] An outbound request to any non-allowed host (including a redirect hop) fails before dialing; `golangci-lint` rejects a direct `http.Get`; test `SAF-13` (`TestDisallowedDestinationsRejectedBeforeDial` and `TestRedirectToOtherHostRejected` assert the other server saw 0 requests; `TestLintRejectsDirectHTTPUse` runs golangci-lint on probes using http.Get, http.Post, http.DefaultClient, an http.Client literal and http.DefaultTransport)

## Required tests (from `docs/07-edge-cases-tests.md`)
- `SEC-08` (see `docs/07-edge-cases-tests.md`)
- `SEC-10` (see `docs/07-edge-cases-tests.md`)
- `API-01` (see `docs/07-edge-cases-tests.md`)
- `SYS-01` (see `docs/07-edge-cases-tests.md`)
- `SAF-13` (added in the T00 review, see `docs/07-edge-cases-tests.md`)

## Definition of done
- [x] Behavior matches the cited spec sections exactly (docs/03 sections 1, 15, 16; choices in docs/OPEN_QUESTIONS.md B01-1..B01-7).
- [x] Tests above exist, run in CI and pass; new edge cases discovered are added to `docs/07-edge-cases-tests.md` (SEC-13, SEC-14, API-07 to API-10; SEC-10 `TestLoginRateLimit`, SYS-01 `TestReadyzRetriesOnce`).
- [x] Loading/empty/partial/stale/error states implemented for any UI work (no UI in this task).
- [x] No secrets or personal data in code, logs or fixtures; deny-list check passes (`python scripts/deny_list_check.py` passed).
- [x] `docs/RUNBOOK.md` updated for any new variable, job or failure mode (section 8).
- [x] Questions or spec conflicts recorded in `docs/OPEN_QUESTIONS.md` instead of guessed (B01-1 to B01-7).
