# India Stock & Mutual Fund Analyzer: Spec Package for Claude Code (Safe Edition)

## What is in this package
- `MASTER_PLAN.md`: the main file (scope, decisions, architecture, phases). Short by design.
- `CLAUDE.md`: rules Claude Code follows automatically (it is loaded from the repo root).
- `docs/`: reference specifications (data sources, DB schema, API, jobs, analytics, frontend, design system, edge cases, spikes, legal/safety).
- `tasks/`: 39 active task files (42 tracked work items: D05, B06 and F13 are each split in two; D02 is removed) in four tracks (foundation, backend, data/worker, frontend), with an index and order in `tasks/README.md`.
- `config/`, `.env.example`: templates.
- `PROMPT_FOR_CLAUDE_CODE.md`: copy-paste prompts.

## Why not one giant file
A single huge file overflows the working context, hides what matters for the current task, and invites drift. The structure here gives Claude Code (1) a short main plan, (2) a rules file that auto-loads, (3) reference specs it reads **by section**, and (4) one task at a time with explicit scope and acceptance criteria. Frontend and backend are separate tracks that meet at the API contract (`docs/03-api-spec.md` -> `openapi.yaml`).

## How to start (10 minutes)
1. Create an empty folder, unzip this package into it, run `git init`, commit.
2. Install Claude Code, open it in that folder (`claude`). `CLAUDE.md` loads automatically.
3. Paste **Prompt 1 (Kickoff)** from `PROMPT_FOR_CLAUDE_CODE.md`. Answer its questions (broker or manual price mode, repo visibility, etc.).
4. Run tasks in order from `tasks/README.md` using **Prompt 2 (Run one task)**. Use a fresh session per task (or `/clear`) so context stays clean; commit after each task.
5. After each task paste **Prompt 3 (Review)**; fix findings before moving on.
6. Do the owner-only steps yourself: create the broker developer app, log in to the broker (OAuth) when asked, create the Telegram bot, create the Neon/Render/Vercel accounts, set secrets in the hosts. Claude Code must never receive your broker password.

## Owner checklist (things only you can do)
- Decide broker vs manual price mode (S1). Read the broker's terms on data use.
- Create accounts: GitHub, Neon, Render, Vercel; Telegram bot via BotFather.
- Prepare optional CSVs: sector/industry and index tags (`instrument_meta`), results/shareholding for the stocks you care about.
- Maintain `config/market_holidays.json` yearly (from the exchange's published holiday list).
- Reconnect the broker each trading day (one tap) if you use broker prices.

## Safety reminder
This package implements the lowest-risk configuration identified in research, not zero risk, and is not legal advice. Read `docs/00-legal-and-safety.md` and `docs/TERMS_NOTES.md` (created by spike S14). Keep the app private, personal and non-commercial; never share forecasts.
