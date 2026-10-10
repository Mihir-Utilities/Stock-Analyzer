# Prompts for Claude Code

Open Claude Code in the repo root (where `CLAUDE.md` lives). Use plan mode for Prompt 1 and for the planning half of Prompt 2.

---

## Prompt 1: Kickoff (paste once, first session)

```
You are the lead engineer for a private, single-user "India Stock & Mutual Fund Analyzer" (Safe Edition). This repository contains the complete specification. Do NOT write application code yet.

Step 1. Read, in this order: CLAUDE.md, MASTER_PLAN.md, docs/00-legal-and-safety.md, tasks/README.md, docs/01-data-sources.md, docs/08-phase0-spikes.md. Skim the headings of docs/02..07 and docs/06a so you know where things are.

Step 2. Reply with:
(a) a 15-line summary of the product, the Safe Edition rules (allowed vs forbidden data sources, no trading) and the architecture, in your own words;
(b) the list of anything you found ambiguous, contradictory or missing across the files (do not fix silently; list it);
(c) the owner decisions you need from me (MASTER_PLAN section 9) as numbered questions;
(d) the exact order you will execute tasks, and which tasks need me personally (broker login, account creation, Telegram bot creation).

Step 3. Wait for my answers. After I answer, record decisions in docs/OPEN_QUESTIONS.md and update MASTER_PLAN.md section 9, then stop and wait for my instruction to begin task T00.

Hard rules: never fetch from or write code for NSE/BSE websites, Yahoo/yfinance, Screener scraping or news scraping; never implement order placement; never ask for or store my broker password; do not guess, ask.
```

---

## Prompt 2: Run one task (paste per task; replace the task id)

```
Execute task <TASK_ID> now. The task file is under tasks/ (for example tasks/backend/B03-*.md).

Process:
1. Read CLAUDE.md, the task file, and ONLY the spec sections the task cites. If the task depends on another task, verify it is done (check the code and tests); if not, stop and tell me.
2. Before coding, post a short plan: restate scope and out-of-scope in <= 10 lines, list files to create/change, list the tests you will write (IDs from docs/07-edge-cases-tests.md), and list any open question. If any open question blocks you, ask me and stop.
3. Implement test-first where the spec gives formulas or edge cases. Follow CLAUDE.md conventions exactly. Do not add features outside the task.
4. Run the full relevant test suites, linters and type checks. Fix failures properly (no skipped or weakened tests).
5. Tick every acceptance criterion in the task file honestly. For each criterion state the evidence (test name, command output summary).
6. Update docs/RUNBOOK.md, docs/field-map.json, openapi.yaml and any spec file that changed (spec and code must never disagree).
7. Finish with: a summary of what changed, what was deliberately not done, any new edge cases you added to docs/07-edge-cases-tests.md, and anything I must do personally. Commit with a conventional message.

Safe Edition guards apply: no forbidden sources, no order code, no secrets in code/logs/fixtures.
```

---

## Prompt 3: Review a finished task (paste after each task, in a fresh session if possible)

```
Review task <TASK_ID> as a strict senior reviewer. Do not change code yet.

Check against: the task file, the cited spec sections, CLAUDE.md, and docs/07-edge-cases-tests.md rows assigned to the task.
Report:
1. Spec deviations (quote the spec line and the code location).
2. Missing or weak tests (list the exact test IDs not covered or only superficially covered).
3. Safe Edition violations (forbidden hosts/libraries, order endpoints, secrets in code/logs/fixtures).
4. Security issues (see CLAUDE.md section 4).
5. UI/UX gaps: states (loading/empty/partial/stale/error), null reasons, units, source/as-of chips, data-table view for charts, accessibility.
6. Performance or budget regressions.
Then give a prioritized fix list (blocker / should-fix / nice-to-have). Wait for my approval before fixing.
```

---

## Prompt 4: Fix review findings

```
Fix the blocker and should-fix items from the review of <TASK_ID>. For each fix add or strengthen a test that would have caught it. Re-run all checks, update docs if behavior changed, and report evidence per item.
```

---

## Prompt 5: Resume in a new session

```
Resume work. Read CLAUDE.md, MASTER_PLAN.md, tasks/README.md and docs/OPEN_QUESTIONS.md. Inspect the repository (git log, test results, which tasks have all acceptance boxes ticked) and tell me: which tasks are complete, which is in progress, what is blocked, and the next task you recommend. Do not start coding until I confirm.
```

---

## Prompt 6: Change a decision or spec (use when reality contradicts the plan)

```
A spec change is needed: <describe the problem and evidence, e.g., "spike S3 shows the broker's daily candles are limited to 1 year per request and 3 years total">.
1. List every spec file and task file affected (with section numbers).
2. Propose the minimal edits (show a diff of the spec text).
3. List code/tests that would need to change.
Wait for my approval; then apply spec edits first, regenerate openapi.yaml/types if needed, then code, and log the decision in docs/OPEN_QUESTIONS.md under "Decisions".
```

---

## Prompt 7: Phase 0 spikes (owner-assisted; use as Prompt 2 for T01)

```
Execute T01 (Phase 0 spikes). You cannot log in to my broker; when a spike needs a login or a live check, give me exact numbered steps (what to open, what to click, what to paste back). Never ask for my broker password or OTP. Start with S1 (broker decision): read the official developer documentation and terms of Angel One SmartAPI, Fyers, Upstox and DhanHQ, fill docs/BROKER_DECISION.md using the rubric in docs/01-data-sources.md section 3.1, recommend one (or manual price mode), and wait for my approval before running S2-S5 against it. Record every result in docs/SPIKE_RESULTS.md. If a spike fails, propose spec amendments (Prompt 6 format) instead of working around it.
```

---

## Tips for best results
- One task per session; commit after each; keep the repo green.
- Frontend and backend can run in parallel in separate worktrees/sessions after B01 produces `openapi.yaml` (frontend uses a mock server until backend tasks land).
- If Claude Code proposes using Yahoo, NSE endpoints, nsepython, Screener scraping or news scraping "just for testing", refuse: that violates the Safe Edition.
- Keep secrets out of the chat; set them in `.env` (local) and host/GitHub secret stores.
