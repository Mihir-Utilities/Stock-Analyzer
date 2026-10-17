# D01 - Worker scaffold, limiter, circuit breaker, job runner

| Field | Value |
|---|---|
| Track | data |
| Depends on | T00, T02 |
| Size | M (S < 0.5 day, M 0.5-1.5 days, L 1.5-4 days of focused work) |

## Read first
- docs/04-worker-jobs.md sections 1, 4, 5
- docs/01-data-sources.md section 1
- `CLAUDE.md` (rules), `docs/00-legal-and-safety.md` (Safe Edition guards)

## Goal
Build the shared worker foundation: CLI, HTTP service, locks, throttling, circuit breakers, logging.

## In scope
- `python -m worker run <job>` CLI and `uvicorn worker.http:app` with HMAC auth
- `ingestion_run` lock/unlock helper, per-item isolation helper, structured logging with scrubber
- Async rate limiter with jitter, retry/backoff helper, circuit breaker backed by `source_health`
- Deny-list unit test (SAF-01) for worker imports
- **Egress allow-list (D-N):** one shared `httpx` client factory whose transport refuses any host outside `config/allowed_hosts.json` (`mfapi.in`, `www.amfiindia.com`, `api.telegram.org`; docs/00 section 1.1), checked on every request and every redirect hop, https only, no proxies from the environment. ruff `flake8-tidy-imports.banned-api` forbids `requests`, `urllib.request`, `urllib3`, `http.client`, `aiohttp` everywhere and `httpx` outside the factory module. Tests run with sockets disabled (pytest fixture) so no test can reach the network
- Fixture recorder/loader utilities

## Out of scope (do not do in this task)
- Any source adapter

## Deliverables
- `apps/worker/{cli,http,runner,limiter,breaker,db,fixtures}`
- tests

## Steps
1. Implement runner contract (lock, timeout, partial status)
2. Implement HMAC verification exactly as spec
3. Test limiter spacing and breaker transitions with a fake clock

## Acceptance criteria (all must be true)
- [x] SYS-05 and SEC-07 tests pass (`test_runner.py::test_sys05_*`, `test_db_integration.py::test_sys05_*` on Postgres 16, `test_http.py::test_sec07_*`)
- [x] Breaker opens after 5 failures and recovers after 3 successes (`test_limiter_retry_breaker.py::test_breaker_opens_after_five_failures`, `test_breaker_half_open_then_closes_after_three_successes`, DB-backed `test_breaker_persists_in_source_health`)
- [x] Runner marks `partial` on timeout (`test_runner.py::test_timeout_marks_partial_after_finishing_current_item`)
- [x] A request to any host outside the allow-list (including via redirect, a host read from an environment variable, or an IP literal) raises before any socket is opened; test `SAF-13` (`test_egress.py`: 16 URL variants, env-var host, redirect hops, real transport never reaches a socket, lint-ban tests)

## Required tests (from `docs/07-edge-cases-tests.md`)
- `SYS-05` (see `docs/07-edge-cases-tests.md`)
- `SEC-07` (see `docs/07-edge-cases-tests.md`)
- `SEC-08` (see `docs/07-edge-cases-tests.md`)
- `SAF-01` (see `docs/07-edge-cases-tests.md`)
- `SYS-09` (see `docs/07-edge-cases-tests.md`)
- `SAF-13` (added in the T00 review, see `docs/07-edge-cases-tests.md`)

## Definition of done
- [x] Behavior matches the cited spec sections exactly (note section numbers in the PR description).
- [x] Tests above exist, run in CI and pass; new edge cases discovered are added to `docs/07-edge-cases-tests.md`.
- [x] Loading/empty/partial/stale/error states implemented for any UI work.
- [x] No secrets or personal data in code, logs or fixtures; deny-list check passes.
- [x] `docs/RUNBOOK.md` updated for any new variable, job or failure mode.
- [x] Questions or spec conflicts recorded in `docs/OPEN_QUESTIONS.md` instead of guessed.
