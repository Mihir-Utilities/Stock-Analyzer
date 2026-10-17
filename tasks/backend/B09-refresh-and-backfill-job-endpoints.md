# B09 - Refresh and backfill job endpoints

| Field | Value |
|---|---|
| Track | backend |
| Depends on | D01 |
| Size | M (S < 0.5 day, M 0.5-1.5 days, L 1.5-4 days of focused work) |

## Amendment: manual price mode (decisions D-1, D-2 and follow-ups, 2026-10-10)
Source of truth: `docs/OPEN_QUESTIONS.md` Decisions; updated specs: `docs/01` 7.0/7.1, `docs/03` 3, 4, 14, `docs/04` 3.9-3.13. Where this block conflicts with the sections below, **this block wins**.
- Depends on **D01 only** (not B08).
- Scope: `refresh_job` plumbing, HMAC-signed fire-and-forget call to worker-http, `GET /jobs/{id}`, unique-active-job dedupe, **`post_import` enqueue** (target `batch:<id>`, result fields `symbols_total/symbols_done/remaining`), cooldown/global limits for `mf_refresh`. `stock_refresh` and `stock_backfill` return `422 PRICE_MODE_MANUAL`; no `broker_session_missing` handling.

## Read first
- docs/03-api-spec.md section 7
- docs/04-worker-jobs.md section 4
- docs/07-edge-cases-tests.md API-06, BRK-12
- `CLAUDE.md` (rules), `docs/00-legal-and-safety.md` (Safe Edition guards)

## Goal
Let the UI queue on-demand price refresh/backfill jobs executed by the worker-http service.

## In scope
- POST refresh/backfill endpoints, GET jobs, cooldown and global limits, unique-active-job dedupe
- HMAC-signed fire-and-forget call to worker-http; row stays `queued` if the call fails
- `PRICE_MODE_MANUAL` and `broker_session_missing` handling
- The Go caller of worker-http signs and polls exactly as written in `docs/04` section 4 (D01-A3): `X-Timestamp` in unix seconds, `POST /run` returns 202 and runs in the background, a signature is single-use inside the 120 s window; the call goes through `internal/egress` (D-N)

## Out of scope (do not do in this task)
- Executing the job (worker D02/D03)

## Deliverables
- handlers, signer, tests with a fake worker

## Steps
1. Implement HMAC signing exactly as the jobs spec
2. Implement rate/cooldown logic
3. Write concurrent-click test

## Acceptance criteria (all must be true)
- [x] API-06 passes (one job for concurrent clicks) - `TestConcurrentRefreshSingleJob`: 25 parallel clicks, 1 row, 1 worker call
- [x] 429 includes `retry_after_seconds` - `TestCooldown429`, `TestGlobalHourlyLimit429` (also `Retry-After` header)
- [x] Signature verified by a test worker - fake worker mirroring `worker/http.py` (`TestWorkerHMACReplayAndSkew`) and Python golden vector (`TestSignMatchesWorkerGoldenVector`)

## Required tests (from `docs/07-edge-cases-tests.md`)
- `API-06` (see `docs/07-edge-cases-tests.md`)
- `BRK-12` (see `docs/07-edge-cases-tests.md`)
- `SEC-07` (see `docs/07-edge-cases-tests.md`)

## Definition of done
- [x] Behavior matches the cited spec sections exactly (note section numbers in the PR description).
- [x] Tests above exist, run in CI and pass; new edge cases discovered are added to `docs/07-edge-cases-tests.md`.
- [x] Loading/empty/partial/stale/error states implemented for any UI work. (no UI work in this task)
- [x] No secrets or personal data in code, logs or fixtures; deny-list check passes.
- [x] `docs/RUNBOOK.md` updated for any new variable, job or failure mode.
- [x] Questions or spec conflicts recorded in `docs/OPEN_QUESTIONS.md` instead of guessed.
