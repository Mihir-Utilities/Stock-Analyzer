# PROGRESS (read this first in every new session)

Rule: ONE task per session. Each session does: Execute -> Review -> Fix -> Commit -> update this file -> STOP.
A new session starts with: "Resume. Read CLAUDE.md, PROGRESS.md, OPEN_QUESTIONS.md; continue at CURRENT."

## Pointer
- CURRENT: T00 (not started) - waiting for owner's "begin T00"
- LAST COMPLETED: kickoff (layout reorganised, git init, decisions recorded in docs/OPEN_QUESTIONS.md and MASTER_PLAN 9)
- BLOCKED ON OWNER: OQ-1 broker name, OQ-2 static IP (both default to manual price mode / no static IP); OQ-3 training basket before D07

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
| 0 | T01 | TODO | | | needs owner: broker login, spikes |
| 0 | T02 | TODO | | | parallel with T01 after T00 |
| 1 | B01 | TODO | | | produces openapi.yaml; unlocks parallel FE/BE |
| 1 | D01 | TODO | | | |
| 1 | F01 | TODO | | | |
| 1 | B02 | TODO | | | |
| 1 | F02 | TODO | | | |
| 2 | B03 | TODO | | | |
| 2 | F03 | TODO | | | |
| 2 | D02 | TODO | | | needs BROKER_DECISION.md approved |
| 3 | D03 | TODO | | | |
| 3 | B08 | TODO | | | owner does broker login |
| 3 | B09 | TODO | | | |
| 3 | B04 | TODO | | | |
| 4 | D05a (indicators/returns) | TODO | | | |
| 4 | F04 | TODO | | | |
| 4 | F05 | TODO | | | |
| 4 | F06 | TODO | | | |
| 5 | B05 | TODO | | | |
| 5 | B06 | TODO | | | |
| 5 | B07 | TODO | | | |
| 5 | F07 | TODO | | | |
| 5 | F08 | TODO | | | |
| 5 | F13 | TODO | | | |
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
| 8 | F12 | TODO | | | |
| 9 | D07 | TODO | | | needs training basket |
| 9 | B14 | TODO | | | |
| 9 | F09 | TODO | | | |
| 10 | D08 | TODO | | | |
| 10 | F15 | TODO | | | |

## Parallel work (only after B01 is DONE)
Frontend and backend tasks may run in separate git worktrees/sessions. Frontend uses the MSW mock server from openapi.yaml until the backend task lands. Each parallel session updates only its own row here; resolve merge conflicts in this file by keeping both rows' updates.

## Session log (append newest at bottom)
- 2026-10-10: Kickoff review done. Owner answered; decisions recorded; files moved to documented layout (from extracted zip, content verified identical); .gitignore added; first commit made. Awaiting "begin T00".
