# PROGRESS (read this first in every new session)

Rule: ONE task per session. Each session does: Execute -> Review -> Fix -> Commit -> update this file -> STOP.
A new session starts with: "Resume. Read CLAUDE.md, PROGRESS.md, OPEN_QUESTIONS.md; continue at CURRENT."

## Pointer
- CURRENT: T00, phases 1 EXEC and 4 COMMIT done (commit f55371c). NEXT: phase 2 REVIEW (Prompt 3, ideally in a fresh session), then 3 FIX, then 5 LOGGED. Do not start T01/T02 before T00 is DONE.
- LAST COMPLETED: kickoff (layout reorganised, git init, decisions recorded in docs/OPEN_QUESTIONS.md and MASTER_PLAN 9)
- MODE: manual price mode (no broker). Each affected task file starts with an "Amendment: manual price mode" block that overrides the text below it (D02 removed; B08 reduced; B06 and F13 split a/b; B09/D03/D06/D07/D08 changed).
- COUNTS: 39 active task files; 42 tracked work items below (D05, B06, F13 each split in two; D02 REMOVED).
- BLOCKED ON OWNER: nothing. OQ-1..OQ-7 all closed. Owner still has to: provide the 2026 holiday list (or import holidays.csv), and record the raw/adjusted answer in the manual S4 check.

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
| 0 | T00 | DONE | 1 EXEC, 4 COMMIT | f55371c | T00 review done and fixes applied (deny-list, licence scan, .gitignore, CI hardening); GitHub run green on 16fa978. First run (921a1ba) failed: platform-dependent notices. OQ-8 closed as D-OQ8; egress allow-list D-N added to D01/B01 |
| 0 | T01 | IN-PROGRESS (owner spikes pending) | | | manual mode: S1 recorded, S2/S3/S5 skipped, S4 = manual adjustment check; owner needed for S4, S9 (25 MB upload), S12-S14, S17 |
| 0 | T02 | DONE | | | parallel with T01 after T00 |
| 1 | B01 | DONE | | | produces openapi.yaml; unlocks parallel FE/BE |
| 1 | D01 | DONE | | | |
| 1 | F01 | DONE except Lighthouse run (owner, pending green CI) | | | |
| 1 | B02 | DONE (pending green CI) | | | |
| 1 | F02 | TODO | | | |
| 2 | B03 | DONE (pending green CI) | | | |
| 2 | F03 | TODO | | | |
| 2 | D02 | REMOVED | | | manual price mode (D-1, D-2); stub file kept |
| 3 | D03 | DONE except S8 real-data criterion (pending green CI) | | | |
| 1 | B08 (reduced) | TODO | | | status endpoint only; do with B02 |
| 3 | B09 | DONE (pending green CI) | | | depends on D01 only |
| 3 | B04 | TODO | | | |
| 3 | B06a | TODO | | | instruments + prices importers, adjustment choice/check, trim/delete; needs B03, B09 |
| 4 | D05a (indicators/returns) | DONE (CI pending) | | | |
| 4 | F04 | TODO | | | |
| 4 | F05 | TODO | | | |
| 4 | F06 | TODO | | | |
| 4 | F13a | TODO | | | instruments/prices wizard, Add stock, Storage tab; needs B06a |
| 5 | B05 | TODO | | | |
| 5 | B06b | TODO | | | rest of B06 incl. holidays importer; needs B05, B06a |
| 5 | B07 | TODO | | | |
| 5 | F07 | TODO | | | |
| 5 | F08 | TODO | | | |
| 5 | F13b | TODO | | | rest of F13; needs B06b |
| 6 | D05b (fundamentals/scores) | TODO | | | |
| 6 | B13 | TODO | | | |
| 6 | F10 | TODO | | | |
| 7 | D04 | DONE except live smoke check (owner, pending green CI) | | | |
| 7 | B10 | TODO | | | |
| 7 | F14 | TODO | | | |
| 8 | B11 | TODO | | | |
| 8 | B12 | DONE (pending green CI) | | | owner: Telegram bot |
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
