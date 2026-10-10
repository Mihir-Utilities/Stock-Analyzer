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
| 0 | T01 | TODO | | | manual mode: S1 recorded, S2/S3/S5 skipped, S4 = manual adjustment check; owner needed for S4, S9 (25 MB upload), S12-S14, S17 |
| 0 | T02 | TODO | | | parallel with T01 after T00 |
| 1 | B01 | TODO | | | produces openapi.yaml; unlocks parallel FE/BE |
| 1 | D01 | TODO | | | |
| 1 | F01 | TODO | | | |
| 1 | B02 | TODO | | | |
| 1 | F02 | TODO | | | |
| 2 | B03 | TODO | | | |
| 2 | F03 | TODO | | | |
| 2 | D02 | REMOVED | | | manual price mode (D-1, D-2); stub file kept |
| 3 | D03 | TODO | | | |
| 1 | B08 (reduced) | TODO | | | status endpoint only; do with B02 |
| 3 | B09 | TODO | | | depends on D01 only |
| 3 | B04 | TODO | | | |
| 3 | B06a | TODO | | | instruments + prices importers, adjustment choice/check, trim/delete; needs B03, B09 |
| 4 | D05a (indicators/returns) | TODO | | | |
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
| 7 | D04 | TODO | | | |
| 7 | B10 | TODO | | | |
| 7 | F14 | TODO | | | |
| 8 | B11 | TODO | | | |
| 8 | B12 | TODO | | | owner: Telegram bot |
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
