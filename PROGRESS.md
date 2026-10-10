# PROGRESS (read this first in every new session)

Rule: ONE task per session. Each session does: Execute -> Review -> Fix -> Commit -> update this file -> STOP.
A new session starts with: "Resume. Read CLAUDE.md, PROGRESS.md, OPEN_QUESTIONS.md; continue at CURRENT."

## Pointer
- CURRENT: T00 (not started) - waiting for owner's "begin T00"
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
| 0 | T00 | TODO | | | |
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
