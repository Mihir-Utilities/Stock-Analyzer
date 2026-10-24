# PROGRESS (read this first in every new session)

Rule: ONE task per session. Each session does: Execute -> Review -> Fix -> Commit -> update this file -> STOP.
A new session starts with: "Resume. Read CLAUDE.md, PROGRESS.md, OPEN_QUESTIONS.md; continue at CURRENT."

## Pointer
- LAST UPDATED: 2026-10-24. `main` = fdd3182, GitHub CI GREEN on every job (guards, api with -race, worker, web incl. build, storybook and Playwright e2e, api-types; run 40096211203).
- CURRENT: no task in progress. **D05b is deliberately NOT started (owner instruction 2026-10-17: "don't start 5b").** Suggested next: Prompt 3 reviews of B06b, B11, D06 (then F03, F13a, B12, D04, D05a, D01, T02, B08), then B07 and the unblocked UI tasks.
- MODE: manual price mode (no broker). Each affected task file starts with an "Amendment: manual price mode" block that overrides the text below it.
- WHAT "DONE" MEANS TODAY: tasks marked DONE completed phases 1 EXEC and 4 COMMIT (merged, CI green). Phase 2 REVIEW and 3 FIX are done for: T00, B01, B02, B03, B04, B05, B06a, B09, B10, D03, F01, F02. **Review still pending for: T02, D01, D04, D05a, B06b, B08, B11, B12, D06, F03, F13a.** Run Prompt 3 on a batch (B06b + B11 + D06 first: importers, money math, alert delivery) before building more on top.
- HOW WORK WAS RUN: each task by a separate agent in its own git worktree (read-only reviewers and fix agents too), merged by a coordinator agent or by me (resolve shared docs, renumber RUNBOOK sections and docs/07 row ids, regenerate THIRD_PARTY_NOTICES.md and packages/api-types, run guards and tests against a real Postgres 16, push, confirm CI). Reusable lessons are at the bottom.
- COUNTS: 39 active task files; 42 tracked work items (D05, B06, F13 each split in two; D02 REMOVED).

### Next tasks that are unblocked (verify the Depends-on line in the task file first)
- B07 corporate actions detected/confirm/reject (B06 done; must stop a manual split on a detected row's ex-date being confirmed twice, see B06b notes)
- F04 login + dashboard (F02, F03, B02), F05 stock header + overview (F02, F03, B03, B04), then F06 (F05), F07 (F05, B05, B06), F08 (F05, B05, B07)
- F11 portfolio UI (F02, B11), F12 settings/alerts UI (F02, B12; no Broker card), F13b rest of import center (F02, B06b), F14 mutual funds UI (F02, F03, B10)
- Blocked: B13/F10 and D07/B14/F09/D08/F15 wait on D05b (held) or later tasks.

### BLOCKED ON OWNER (nothing blocks coding; these block closing tasks)
1. T01 owner spikes: S4 adjusted-vs-raw check (needs your price files), S8 real-data detector tuning (30+ stocks, 10+ known events), S9 hosting (Render/Neon/Vercel; rescoped to about 40k rows plus Vercel's current body limit, D-S; set `IMPORT_PRICES_LARGE_ENABLED` only if you need more than 5 MB / 50,000 rows), S12 Telegram after idle, S14 read the terms (docs/TERMS_NOTES.md), S16 real ratio comparison, S17 data-entry timing.
2. GitHub: enable branch protection on `main` and add the required checks guards, api, worker, web and "Generated API types (openapi.yaml)" (RUNBOOK 5a). Pushes may block on a Git Credential Manager sign-in window after a restart: complete it as `Mihir-Utilities`.
3. Vercel: set `API_BASE_URL` for the build (changing it needs a redeploy); run Lighthouse mobile on `/` once and record the a11y score in docs/SPIKE_RESULTS.md (F01 criterion, RUNBOOK 11).
4. Telegram (D-9, not blocking): create the bot in BotFather, set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_BOT_USERNAME`, run `setWebhook` with `secret_token` (RUNBOOK 14), link your chat. Until then alerts stay `pending` with `bot_not_configured`. Add the 19:30 `evaluate_alerts` schedule when the workflows are built (D06).
5. Live smoke check nobody has run: `python -m worker run sync_mf_schemes --dry-run` (D04; expect amfi_rows above 10,000 and about 38,000 mfapi schemes).
6. Data: import `holidays.csv` for 2026 (the app cannot invent dates) and give the raw/adjusted answer in the S4 check; set `INITIAL_PASSWORD_HASH` and run the seed before any login works (RUNBOOK 2a).
7. Same `WORKER_HMAC_KEY` on API and worker; host clocks within 120 s.
8. **Set `TRUSTED_PROXY_HOPS`** to the real number of proxies in front of the API (Render is one; the Vercel rewrite may add another; B02-R3). At the default 0 the login rate limit sees every request as one client.
9. Re-measure MF scheme search on Neon after the first bulk load (B10; GIN pending-list note in RUNBOOK 19 and 27); optionally decide a `fastupdate=off` migration.
10. Playwright visual baselines are win32-only: generate Linux baselines in CI before enabling `VISUAL=1` there (F02-6).

### Owner decisions pending (interim assumptions in force; none blocks work). Details in docs/OPEN_QUESTIONS.md
- OQ-16 light-theme contrast of the spec hex colours (some text pairs under 4.5:1; chart colours under 3:1): approve the proposed fix or keep the spec values (the second encoding is already in place, so the fix is a token edit).
- Attribution wording: docs/00 says "AMFI, via mfapi.in" (comma), docs/01/06 and the task file do not; B10 used docs/00.
- F03-1 (no `GET /search` in the contract; the palette uses `/stocks/index`, `/stocks?q=` and `/mf/schemes`) and F03-2.
- D03R-1 (gap guard for the split detector: spec silent, interim `low_confidence` marker only), B06a-18 (future `listing_date` accepted), R-B10-3 (MF stale = 4 calendar days vs docs/03 "2 business days"), R-B04-1 (volume not split-adjusted when `adjusted=true`).
- D04-A1 (`api.mfapi.in` added to the egress allow-list: confirm), D04-A2..A9.
- Per-task assumption lists to skim and confirm: D01-A1..A4, B01-1..7, B02-1..7 and R1..R3, B03-1..7, B04-1..8, B05-1..9, B06a-1..21, B06b-1..15, B09-1..6, B10-1..9, B11-1..9, B12-1..10, D03-A1..9 and D03R-1..5, D05a-A1..8, D06-1..13, F01-1..5, F02-1..8, F03-1..9, F13a-1..10.

### Housekeeping notes
- `.gitignore` has an UNCOMMITTED stray line 59 (`claude --resume ...`, pasted by accident) plus uncommitted Playwright/Storybook ignore lines (`test-results/`, `playwright-report/`, `storybook-static/`). Remove the stray line, keep the others, and commit.
- Local agent worktrees under `.claude/worktrees/` are gitignored and skipped by the deny-list; remove finished ones with `git worktree remove -f -f <path>` and delete merged `worktree-agent-*` branches.
- `apps/web/node_modules` in the main checkout can be locked by the editor on Windows: verify web in a clean `git archive` export that includes `docs/` and `config/` (several unit tests read them).
- To run the DB tests locally start `postgres:16` (user analyzer, password ci-only-password, db analyzer_test) and set `TEST_DATABASE_URL` (RUNBOOK 3b). No local `go test -race` (no cgo): CI runs it, so keep test helpers race-safe.
- Next.js was bumped 16.4.0 -> 16.4.1 for three advisories (owner approved); future advisories fail `next build` until bumped (RUNBOOK 32). Keep merging Renovate PRs promptly.

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
| 1 | B01 | DONE (review + fix done) | | 088b627, fixes in 181b6d8 | TRUSTED_PROXY_HOPS added; owner sets the hop count (B02-R3) |
| 1 | D01 | DONE (review pending) | | 345fbbd | worker scaffold, egress allow-list, worker-http HMAC; CI green |
| 1 | F01 | DONE (review + fix done); Lighthouse a11y run is an owner item | | 8a108c6 / merge db1e19c; fixes in 181b6d8 | OQ-16 contrast open; set API_BASE_URL on Vercel |
| 1 | B02 | DONE (review + fix done) | | 26d90fc, fixes in 181b6d8 | cookie renewal, change-password throttle, login row lock, timing; owner must run the seed |
| 1 | F02 | DONE (review + fix done) | | ee280f9; fixes in 181b6d8 | 44 px touch targets, dialog focus, UI-26..29 tests; contrast fix awaits owner |
| 2 | B03 | DONE (review + fix done) | | 2d738f5 / merge 5b66efc; fixes in 181b6d8 | NEXT50 flag, suspect-bar consistency, NUL/UTF-8 and double-decode fixes |
| 2 | F03 | DONE (review pending) | | bd84000 / merge 181b6d8 | formatters, definitions, search palette; F03-1 endpoint choice to confirm |
| 2 | D02 | REMOVED | | | manual price mode (D-1, D-2); stub file kept |
| 3 | D03 | DONE except S8 real-data criterion (review + fix done) | | 349fc5d / merge 3e89353; fixes in 181b6d8 | suspect bars excluded from the volume average only (D03R-1); owner price files for S8 |
| 1 | B08 (reduced) | DONE (review pending) | | 65c1c43 | GET /broker/status only |
| 3 | B09 | DONE (review + fix done) | | 2dcb811 / merge 53390e7; fixes in 181b6d8 | stale/queued sweep for all kinds, reaper, result kept on timeout, atomic enqueue |
| 3 | B04 | DONE (review + fix done) | | merge 0f3ce35; fixes in 181b6d8 | prices + indicators; series cap 750; B04-1..8 |
| 3 | B06a | DONE (review + fix done) | | merge 0f3ce35; fixes in 181b6d8 | new-rows size guard, upload caps, cross-part duplicates, 1990 floor; lazy part loading deferred (B06a-19) |
| 4 | D05a (indicators/returns) | DONE (review pending) | | 345559f / merge 388284f | compute_analysis hook live; B04 must expand columnar series (D05a-A6) |
| 4 | F04 | TODO | | | |
| 4 | F05 | TODO | | | |
| 4 | F06 | TODO | | | |
| 4 | F13a | DONE (review pending) | | 913d239 / merge 181b6d8 | /imports wizard, Add stock, Storage; uses local-format.ts until a follow-up swaps in F03 formatters |
| 5 | B05 | DONE (review + fix done) | | merge 0f3ce35; fixes in 181b6d8 | derived_as_of + DERIVED_STALE; derived metrics null until D05b; B05-1..9 |
| 5 | B06b | DONE (review pending) | | 46faf08 / merge 181b6d8 | 8 more importers, manual forms, holidays, undo; B06b-1..15; owner: import holidays.csv |
| 5 | B07 | TODO | | | |
| 5 | F07 | TODO | | | |
| 5 | F08 | TODO | | | |
| 5 | F13b | TODO | | | rest of F13; needs B06b |
| 6 | D05b (fundamentals/scores) | TODO (HELD by owner: do not start) | |  | owner instruction 2026-10-17 |
| 6 | B13 | TODO | | | |
| 6 | F10 | TODO | | | |
| 7 | D04 | DONE except live smoke check (review pending) | | 8d38fea / merge ae7ad5c | owner: confirm api.mfapi.in (D04-A1); run sync_mf_schemes --dry-run |
| 7 | B10 | DONE (review + fix done) | | merge 0f3ce35; fixes in 181b6d8 | 6 /mf routes, XIRR errors, SIP end-date rule, LTTB; owner: attribution wording, Neon re-measure |
| 7 | F14 | TODO | | | |
| 8 | B11 | DONE (review pending) | | b67e053 / merge 181b6d8 | FIFO lots, adjustments, XIRR, idempotent txns (migration 0012); B11-1..9 |
| 8 | B12 | DONE (review pending) | | bc54d1d / merge 542b4f6 | owner: Telegram bot (D-9); D06 treats alert.last_state NULL as no bar evaluated |
| 8 | D06 | DONE (review pending) | | 00aaceb / merge 181b6d8 | alerts evaluator + Telegram delivery; alert deadlock fixed in merge; works without a bot token; D06-1..13 |
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

- 2026-10-24: Parallel batch merged (B04, B05, B08, B10, B06a, F02). B01/B02 strict review done and all findings fixed. CI failure `go test -race`: a test-only data race on a shared log buffer in the httpx auth tests, fixed in ef59495 (production code not involved).
- 2026-10-24: Second batch: builds F03, B06b, B11, D06, F13a; reviews of B06a, B09+D03, B03/B04/B05/B10, F01/F02 (owner approved all findings); four fix agents; Next.js bumped 16.4.0 -> 16.4.1 (owner approved). Merged by a coordinator agent in order importer fixes, B06b, worker fixes, D06, read-API fixes, B11, F03, F13a, then frontend fixes and the bump; pushed as 181b6d8. Collisions renumbered: RUNBOOK sections 23-32, docs/07 IMP-35..40 -> IMP-44..49, IMP-30..32 -> IMP-50..52, ACT-20/21 -> ACT-24/25, UI-20 -> UI-25, UI-21..24 (frontend fixes) -> UI-26..29. Real bugs found by the reviews and merges: stuck refresh jobs (queued/running never cleared), job result overwritten on timeout, silent decimal-comma misread (0,123), size guard refusing zero-growth re-imports, double-decoded symbol paths (A%2541), alert evaluator pool deadlock, heatmap printing NaN, sub-44 px touch targets (root font is 14 px).
- 2026-10-24: CI at 181b6d8 was green except web `npm run test:e2e`: a merge-order gap, not a flaky server. F03's new search trigger (69x39 px, visible 'Ctrl K' not in its accessible name) failed the frontend fixes' UI-26 touch-target test and axe label-content-name-mismatch on 5 pages (6 failures in a Linux reproduction with CI settings). Fixed in 9271c10 (SearchPalette.tsx only); merged as fdd3182; CI green (run 40096211203). Note: two unit tests (search-rank timing, one search-palette test) failed once under heavy load and passed on re-run: timing-sensitive, watch for flakes.

## Lessons for running parallel agents (keep)
- CI runs on Linux with Go 1.22; local is Windows with a newer Go. Anything case- or OS-dependent passes locally and fails in CI (example: `license.md` vs `LICENSE.md`, fixed in license_scan.py). Reproduce with `docker run golang:1.22` and a `git archive` export before guessing.
- Every merge of parallel branches conflicts in the same shared files: docs/RUNBOOK.md (renumber the sections), docs/07-edge-cases-tests.md (duplicate row ids: check with `grep -o "^| [A-Z]*-[0-9]* |" | sort | uniq -d`), docs/OPEN_QUESTIONS.md, THIRD_PARTY_NOTICES.md (regenerate with `python scripts/license_scan.py --write` after `go mod download`), packages/api-types (`npm run generate`), cmd/api/main.go and httpx/router.go (union of wiring), worker job_defs.py.
- Migration files must stay contiguous (T02 test); parallel agents that need one use the next free number and the coordinator renumbers.
- Windows: Python text-mode writes CRLF; git normalises on commit (.gitattributes eol=lf), but run `gofmt -w` after scripted edits. A running editor can lock `node_modules`: verify web in a clean export.
- Merge one branch at a time, run guards plus the relevant suite against Postgres 16, then push and check CI before the next big merge.
- A subagent can hand back an interim or "placeholder" message while its work is still running: check its worktree (`git log main..HEAD`, `git status`) before treating a task as finished, and wait for the real report.
- Use `git -C /d/Analyzer ...` for coordinator commands: the shell's working directory can silently become an agent's worktree (a merge and a push once ran in the wrong place).
- The CI web job runs lint, format, typecheck, unit tests, `next build`, `build-storybook` and `test:e2e`: all must pass locally before merging web work. A web export for verification must include `docs/` and `config/`.
- Reviewers that run Docker/DB tests hang when many agents compete for Docker: tell read-only reviewers to skip DB tests; builders run golangci-lint alone (it takes a lock).
- When two branches fix the same thing (the atomic enqueue), keep one implementation and both tests. When a fix collides with a test-data assumption (1990 date floor vs old test years), change the data, not the assertion.
- Pushes can block on a Git Credential Manager window after a restart; the tool shows no error, only a hang.
- Branches that each pass alone can fail together: after merging UI work, run the whole web suite (unit, build, storybook, e2e) on the merged tree in a Linux Playwright container before pushing, not just per-branch checks.
