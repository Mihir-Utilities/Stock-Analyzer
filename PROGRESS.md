# PROGRESS (read this first in every new session)

Rule: ONE task per session. Each session does: Execute -> Review -> Fix -> Commit -> update this file -> STOP.
A new session starts with: "Resume. Read CLAUDE.md, PROGRESS.md, OPEN_QUESTIONS.md; continue at CURRENT."

## Pointer
- LAST UPDATED: 2026-10-24. `main` = ee280f9, GitHub CI green on every job (guards, api, worker, web, api-types).
- CURRENT: no task in progress. The backend/worker foundation is built; the design-system and screens work (F02+) and the product APIs (B04..B07) are next. **D05b is deliberately NOT started (owner instruction 2026-10-17: "don't start 5b").**
- MODE: manual price mode (no broker). Each affected task file starts with an "Amendment: manual price mode" block that overrides the text below it.
- WHAT "DONE" MEANS TODAY: tasks marked DONE below completed phases 1 EXEC and 4 COMMIT (merged, CI green). **None except T00 has had phase 2 REVIEW (Prompt 3) or 3 FIX yet.** Recommended: run Prompt 3 on a batch (B01+B02 security first, then D01, D03, B09, B12) before building more on top.
- HOW WORK WAS RUN: each task by a separate agent in its own git worktree, merged by the coordinator one at a time (resolve shared docs, renumber RUNBOOK sections and docs/07 row ids, regenerate THIRD_PARTY_NOTICES.md and packages/api-types, run guards and tests against a real Postgres 16, push, confirm CI). Reusable lessons are at the end of this file.
- COUNTS: 39 active task files; 42 tracked work items (D05, B06, F13 each split in two; D02 REMOVED).

### Next tasks that are unblocked (pick any; they touch different areas)
- B04 prices/indicators read APIs (needs B03 + D05a; must expand the columnar `series` into `[[date,value]]` pairs, D05a-A6)
- B05 fundamentals/ownership/events read APIs (needs B03)
- B10 mutual-fund APIs (needs B02 + D04)
- B08 reduced to `GET /broker/status` (needs B02; tiny)
- F02 design-system components + ChartFrame (needs F01; must add a second encoding so chart colour is never the only signal, OQ-16)
- B06a prices/instruments importers (needs B03 + B09; must call `EnqueuePostImport` after commit)
- Held by owner: D05b.

### BLOCKED ON OWNER (nothing blocks coding; these block closing tasks)
1. T01 owner spikes: S4 adjusted-vs-raw check (needs your price files), S8 real-data detector tuning (30+ stocks, 10+ known events), S9 hosting (Render/Neon/Vercel; rescoped to about 40k rows plus Vercel's current body limit, D-S), S12 Telegram after idle, S14 read the terms (docs/TERMS_NOTES.md), S16 real ratio comparison, S17 effort timing (after F13b). Checklists: docs/SPIKE_RESULTS.md.
2. GitHub: enable branch protection on `main` and add the required checks guards, api, worker, web and "Generated API types (openapi.yaml)" (RUNBOOK 5a).
3. Vercel: set `API_BASE_URL` for the build (changing it needs a redeploy); run Lighthouse mobile on `/` once and record the a11y score in docs/SPIKE_RESULTS.md (F01 criterion, RUNBOOK 11).
4. Telegram (D-9, not blocking): create the bot in BotFather, set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` (+ optional username), run `setWebhook` with `secret_token` (RUNBOOK 14).
5. Live smoke check nobody has run: `python -m worker run sync_mf_schemes --dry-run` (D04; expect amfi_rows above 10,000 and about 38,000 mfapi schemes).
6. Data: provide the 2026 holiday list (or import holidays.csv) and the raw/adjusted answer in the S4 check; set `INITIAL_PASSWORD_HASH` and run the seed before any login works (RUNBOOK 2a).
7. Same `WORKER_HMAC_KEY` on API and worker; host clocks within 120 s.

### Owner decisions pending (interim assumptions in force; none blocks work). Details in docs/OPEN_QUESTIONS.md
- OQ-16 light-theme contrast of the spec hex colours (some text pairs under 4.5:1; chart colours under 3:1): approve the proposed fix or keep the spec values.
- D04-A1 (`api.mfapi.in` added to the egress allow-list: confirm), D04-A2..A9.
- D01-A1..A4, B01-1..B01-7, B02-1..B02-7, B03-1..B03-7, B09-1..B09-6, B12-1..B12-10, D03-A1..A9, D05a-A1..A8, F01-1..F01-5.

### Housekeeping notes
- `.gitignore` has an UNCOMMITTED stray line 59 (`claude --resume ...`, pasted by accident). Remove it or leave it; it is the only uncommitted change.
- Old agent worktrees are still under `.claude/worktrees/` (gitignored, safe to delete with `git worktree remove -f -f <path>`). The deny-list skips `.claude/worktrees/`.
- npm in the repo's `apps/web/node_modules` was locked by another process on Windows (likely the editor's TypeScript server); web checks were run in a clean `git checkout-index` export instead.
- The temporary Docker Postgres used for tests was removed. To run the DB tests locally start `postgres:16` (user analyzer, password ci-only-password, db analyzer_test) and set `TEST_DATABASE_URL` (RUNBOOK 3b).

## Per-task phases (tick each; a task is DONE only when all five are ticked)
1 EXEC   = Prompt 2 (plan, tests first, implement, tick acceptance criteria)
2 REVIEW = Prompt 3 (strict review, findings listed, no code changes)
3 FIX    = Prompt 4 (fix blocker + should-fix, add a test per fix, re-run checks)
4 COMMIT = conventional commit, CI/tests green
5 LOGGED = this file updated (status, commit hash, notes, owner actions)

Status values: TODO | IN-PROGRESS (phase n) | BLOCKED (reason) | DONE

## Task list (order from tasks/README.md waves)
| Wave | Task | Status | Phase reached | Commit | Notes / owner action needed |
|---|---|---|---|---|---|
| 0 | T00 | DONE (review done, fixes applied) | | f55371c + review fixes | all five phases; CI green |
| 0 | T01 | IN-PROGRESS (automated spikes done; owner spikes pending) | | merged (docs, fixtures, spikes) | S1 manual mode, S2/S3/S5 N/A, S6 GO, S7 GO-WITH-CHANGES, S8/S10/S11/S13/S15/S16 on synthetic/local data; S4, S9, S12, S14, S17 and real-data S8/S16 are owner items (see Pointer) |
| 0 | T02 | DONE (review pending) | | ad5f108 / merge c87b100 | migrations 0001-0011, seed, sqlc; CI green |
| 1 | B01 | DONE (review pending) | | 088b627 / merge 43fd496 | 77 route stubs, openapi.yaml, api-types, egress; CI green |
| 1 | D01 | DONE (review pending) | | 345fbbd | worker scaffold, egress allow-list, worker-http HMAC; CI green |
| 1 | F01 | DONE (review pending); Lighthouse a11y run is an owner item | | 8a108c6 / merge db1e19c | OQ-16 contrast open; set API_BASE_URL on Vercel; CI green |
| 1 | B02 | DONE (review pending) | | 26d90fc | auth, sessions, CSRF; CI green; owner must run the seed |
| 1 | F02 | DONE (review pending) | | merge ee280f9 | components + ChartFrame, OQ-16 second encoding; F02-1..8; contrast fix awaits owner |
| 2 | B03 | DONE (review pending) | | 2d738f5 / merge 5b66efc | stock index/search/profile; CI green |
| 2 | F03 | TODO | | | |
| 2 | D02 | REMOVED | | | manual price mode (D-1, D-2); stub file kept |
| 3 | D03 | DONE except S8 real-data criterion (review pending) | | 349fc5d / merge 3e89353 | detector, post_import, flag_dismissals 0011; needs owner price files for S8 |
| 1 | B08 (reduced) | DONE (review pending) | | 65c1c43 | GET /broker/status only |
| 3 | B09 | DONE (review pending) | | 2dcb811 / merge 53390e7 | job endpoints + signed worker caller; B06/B07 must call EnqueuePostImport after commit |
| 3 | B04 | DONE (review pending) | | merge 0f3ce35 | prices + indicators read APIs; assumptions B04-1..8; CI green |
| 3 | B06a | DONE (review pending) | | merge 0f3ce35 | instruments+prices importers, trim/delete; IMPORT_PRICES_LARGE_ENABLED off until S9; B06a-1..17 |
| 4 | D05a (indicators/returns) | DONE (review pending) | | 345559f / merge 388284f | compute_analysis hook live; B04 must expand columnar series (D05a-A6) |
| 4 | F04 | TODO | | | |
| 4 | F05 | TODO | | | |
| 4 | F06 | TODO | | | |
| 4 | F13a | TODO | | | instruments/prices wizard, Add stock, Storage tab; needs B06a |
| 5 | B05 | DONE (review pending) | | merge 0f3ce35 | fundamentals/shareholding/events/links reads; derived metrics null until D05b; B05-1..9 |
| 5 | B06b | TODO | | | rest of B06 incl. holidays importer; needs B05, B06a |
| 5 | B07 | TODO | | | |
| 5 | F07 | TODO | | | |
| 5 | F08 | TODO | | | |
| 5 | F13b | TODO | | | rest of F13; needs B06b |
| 6 | D05b (fundamentals/scores) | TODO (HELD by owner: do not start) | |  | owner instruction 2026-10-17 |
| 6 | B13 | TODO | | | |
| 6 | F10 | TODO | | | |
| 7 | D04 | DONE except live smoke check (review pending) | | 8d38fea / merge ae7ad5c | owner: confirm api.mfapi.in (D04-A1); run sync_mf_schemes --dry-run |
| 7 | B10 | DONE (review pending) | | merge 0f3ce35 | 6 /mf routes, XIRR; scheme search index note in RUNBOOK 19; B10-1..9 |
| 7 | F14 | TODO | | | |
| 8 | B11 | TODO | | | |
| 8 | B12 | DONE (review pending) | | bc54d1d / merge 542b4f6 | owner: Telegram bot (D-9); D06 treats alert.last_state NULL as no bar evaluated |
| 8 | D06 | TODO | | | |
| 8 | F11 | TODO | | | |
| 8 | F12 | TODO | | | no Broker card |
| 9 | D07 | TODO | | | forecasts deferred; insufficient_universe path unless >= 20 eligible stocks |
| 9 | B14 | TODO | | | |
| 9 | F09 | TODO | | | |
| 10 | D08 | TODO | | | |
| 10 | F15 | TODO | | | |

## Parallel work (only after B01 is DONE)
Frontend and backend tasks may run in separate git worktrees/sessions. Frontend uses the MSW mock server from openapi.yaml until the backend task lands. Each parallel session updates only its own row here; resolve merge conflicts in this file by keeping both rows' updates.

## Session log (append newest at bottom)
- 2026-10-10: Kickoff review done. Owner answered; decisions recorded; files moved to documented layout (from extracted zip, content verified identical); .gitignore added; first commit made. Awaiting "begin T00".
- 2026-10-10: Owner decision D-2 and follow-ups (D-B..D-I) applied to specs (docs/01-08), tasks and MASTER_PLAN; B06/F13 split and D02 removal proposed by Claude (D-J) for owner review. Added edge-case rows IMP-20..24, INS-14, PRC-21, ALR-18, SYS-12. Awaiting "begin T00".
- 2026-10-10: Owner approved split (D-J) and decided OQ-5/6/7 (D-K, D-L, D-M); applied to docs/01-08, tasks, config, .env.example. New rows IMP-25..27, ACT-11/12, SYS-13/14. Awaiting approval of the summary before T00.
- 2026-10-10: T00 executed and committed (f55371c): API/worker/web skeletons, CI, deny-list, licence scan + notices, lockfile and .env.example checks, RUNBOOK 3a/5a. All CI steps pass locally; GitHub run and branch protection need the owner (push repo, enable protection). OQ-8 opened. Next session: review T00 (Prompt 3).
- 2026-10-10: T00 strict review (Prompt 3) done; owner approved all fixes. Fixed: CI licence-scan failure (lockfile-driven Python list, SAF-12), deny-list bypasses (SAF-09), .gitignore (SAF-10), workflow hardening and CODEOWNERS (SAF-11), Go collector fail-closed, BSD-4/Apache-1.1 not permissive, npm ci --ignore-scripts. D-OQ8 and D-N recorded. Egress allow-list (SAF-13) assigned to D01/B01. Next: confirm GitHub run is green, tick the CI box, then T01/T02.
- 2026-10-10: GitHub CI green on 16fa978 (run 38034743068); T00 acceptance box ticked. Owner still to enable branch protection (RUNBOOK 5a). Next: T01/T02.
- 2026-10-10: T01 automated spikes done (merged): S1 manual mode, S2/S3/S5 N/A, S6 GO, S7 GO-WITH-CHANGES, S8/S10/S11/S13/S15/S16 done on synthetic/local data; S4, S9, S12, S14, S17 and the real-data parts of S8/S10/S16 are BLOCKED-OWNER (checklists in docs/SPIKE_RESULTS.md). New open questions OQ-9..OQ-14. T01 is not DONE until the owner finishes those.
- 2026-10-10: T02 merged (c87b100): goose migrations 0001-0010, seed command (argon2id, idempotent), sqlc queries, migration/constraint/seed tests (API-05, SYS-07, SYS-15..18). Licence scan Go collector now lists only built modules (go list -deps -test, fixed GOOS/GOARCH). Verified locally with testcontainers; go test -race only runs in CI (no gcc locally).
- 2026-10-17: D01 merged (345fbbd): worker scaffold, egress allow-list (config/allowed_hosts.json, SAF-13), limiter, retry, breaker, runner, scrubber logs, worker-http with HMAC. Assumptions D01-A1..A4 in docs/OPEN_QUESTIONS.md for owner review. B09 must sign/poll per docs/04 section 4. Deny-list now skips .claude/worktrees/.
- 2026-10-17: B01 merged: cmd/api skeleton, fail-fast config, scrubbing JSON logs, envelope and error mapping, rate limits, 77 route stubs (501), openapi.yaml and packages/api-types with a CI staleness check, internal/egress with forbidigo/depguard lint (SAF-13). Choices B01-1..B01-7 in docs/OPEN_QUESTIONS.md for owner review. Next: F01 (needs B01), then B02, F02, B03...
- 2026-10-17: B02 merged (26d90fc): argon2id login, hashed sliding sessions, lockout, CSRF header, change-password, logout-all; real session checker replaces DenyAll. Choices B02-1..B02-7 in docs/OPEN_QUESTIONS.md for owner review. Row id SEC-13 was duplicated (B01 headers vs D01 replay); D01's replay row is now SEC-20.
- 2026-10-17: D03 merged: flag_dismissals migration 0011 (D-U), split/bonus detector (docs/01 3.7, D-T volume rule), soft one-day-drop flag (D-O), D-K adjustment (only src_adjusted=false bars), post_import and process_queued_jobs (resumable at 3.5 min). Assumptions D03-A1..A9 in docs/OPEN_QUESTIONS.md for owner review. NOT met: detector false-positive criterion on real data (S8) needs the owner's price files for 30+ stocks with 10+ known events. D05/D06 plug in via post_import HOOKS. B07 must enqueue post_import with target action:<id> after Confirm (D03-A5). RUNBOOK sections renumbered: 9 = authentication (B02), 10 = prices/detection (D03).
- 2026-10-17: F01 merged: design tokens from docs/06a (tested against the doc), Tailwind v4, self-hosted Inter, app shell (sidebar, bottom tabs, footer disclaimer), API client (CSRF header, waking-server banner, 401 handling), auth gate middleware, CSP with per-request nonce, images.unoptimized (D-OQ8), Storybook, vitest, Playwright e2e. Open: OQ-16 contrast of spec colours (some light-theme pairs under 4.5:1), Lighthouse a11y score not run (owner, RUNBOOK 11), set API_BASE_URL on Vercel. Row ids renumbered: F01 SEC-14/15 are now SEC-21/22; RUNBOOK F01 section is 11.
- 2026-10-17: D04 merged: mfapi and AMFI adapters (header-name AMFI parser, CRLF/LF, value dates kept), MF analytics (05 9.2-9.3), jobs sync_mf_schemes, ingest_mf_navs, mf_refresh. D04-A1: exact host api.mfapi.in added to config/allowed_hosts.json (docs/01 section 4 uses it); owner to confirm. Live smoke check outstanding: python -m worker run sync_mf_schemes --dry-run. RUNBOOK section 12.
- 2026-10-17: B09 merged: POST /mf/schemes/{code}/refresh (cooldown, global limit, single active job), GET /jobs/{id}, POST /stocks/{symbol}/refresh -> 422 PRICE_MODE_MANUAL, signed worker-http caller via internal/egress (golden vector matches the Python signer), EnqueuePostImport helpers (B06/B07 must call them after commit). RUNBOOK section 13.
- 2026-10-17: B12 merged: alerts CRUD (13 kinds validated, THRESHOLD_ALREADY_MET, 200-active limit), Telegram link codes (sha256 stored, 15 min, single use), webhook with constant-time secret check, Telegram client via internal/egress. RUNBOOK section 14. Owner creates the bot (D-9); until then BOT_NOT_CONFIGURED. D06 must treat alert.last_state NULL as no bar evaluated yet.
- 2026-10-17: B03 merged: GET /stocks/index (ETag, 304, gzip under 150 kB for 2,300 instruments), GET /stocks (exact, prefix, trigram ranking, keyset), GET /stocks/{symbol} (alias redirect, opens as tracked 'opened', price_mode manual, freshness block, limited_history). No jobs are enqueued on open. RUNBOOK section 15. Choices B03-1..B03-7 in docs/OPEN_QUESTIONS.md. Merge note: main.go wires jobs, alerts and stocks together; Deps has Jobs, Alerts and Stocks.
- 2026-10-17: D05a merged: every indicator (docs/05 3) and return/risk formula (4) with known-answer tests, Analysis-tab series, snapshot builder, compute_analysis wired into post_import hooks, CLI job compute_analysis, price-only screener_row keys, numpy runtime dep (pandas dev only). Nulls carry reasons; never 0/NaN/Infinity. Assumptions D05a-A1..A8 in docs/OPEN_QUESTIONS.md: A1 percent numbers, A2 only the latest snapshot keeps series (30 kept), A6 series stored columnar so B04 must expand to [[date,value]] pairs. RUNBOOK section 16. D05b (fundamentals, scores, shareholding, definitions.json) next.
- 2026-10-17 (end of day): tracker brought fully up to date. All merged work is green on GitHub CI (last verified run 39011019057 on 5449fe9). D05b held by owner. Review (Prompt 3) is pending for every task except T00.

## Lessons for running parallel agents (keep)
- CI runs on Linux with Go 1.22; local is Windows with a newer Go. Anything case- or OS-dependent passes locally and fails in CI (example: `license.md` vs `LICENSE.md`, fixed in license_scan.py). Reproduce with `docker run golang:1.22` and a `git archive` export before guessing.
- Every merge of parallel branches conflicts in the same shared files: docs/RUNBOOK.md (renumber the sections), docs/07-edge-cases-tests.md (duplicate row ids: check with `grep -o "^| [A-Z]*-[0-9]* |" | sort | uniq -d`), docs/OPEN_QUESTIONS.md, THIRD_PARTY_NOTICES.md (regenerate with `python scripts/license_scan.py --write` after `go mod download`), packages/api-types (`npm run generate`), cmd/api/main.go and httpx/router.go (union of wiring), worker job_defs.py.
- Migration files must stay contiguous (T02 test); parallel agents that need one use the next free number and the coordinator renumbers.
- Windows: Python text-mode writes CRLF; git normalises on commit (.gitattributes eol=lf), but run `gofmt -w` after scripted edits. A running editor can lock `node_modules`: verify web in a clean export.
- Merge one branch at a time, run guards plus the relevant suite against Postgres 16, then push and check CI before the next big merge.
- 2026-10-24: Parallel batch merged: B04, B05, B08, B10, B06a (backend) and F02 (web). B01/B02 strict review done; all findings fixed (cookie renewal, TRUSTED_PROXY_HOPS, change-password throttle, login row lock, timing, docs). CI had one failure (go test -race): a test-only data race on a shared log buffer in the httpx auth tests, fixed in ef59495; production code was not involved. Owner items added: determine proxy hop count for TRUSTED_PROXY_HOPS (B02-R3), re-measure MF scheme search on Neon, confirm attribution wording (AMFI, via mfapi.in), approve OQ-16, generate Linux Playwright baselines before enabling VISUAL=1. Next unblocked: F03, B06b, B07, B11, B12 follow-ups per tasks/README.md waves; D05b still held. Reviews (Prompt 3) still pending for everything except T00 and B01/B02.
