# F05 - Stock detail: header and Overview

| Field | Value |
|---|---|
| Track | frontend |
| Depends on | F02, F03, B03, B04 |
| Size | L (S < 0.5 day, M 0.5-1.5 days, L 1.5-4 days of focused work) |

## Amendment: manual price mode (decisions D-1, D-2 and follow-ups, 2026-10-10)
Source of truth: `docs/OPEN_QUESTIONS.md` Decisions; updated specs: `docs/01` 7.0/7.1, `docs/03` 3, 4, 14, `docs/04` 3.9-3.13. Where this block conflicts with the sections below, **this block wins**.
- The Refresh button is **hidden** in manual mode; show the "Last price import: {bar date}" chip (amber if older than 1 trading day) and an "Import prices" link. No broker banners. Show the small "holiday list missing" notice when `freshness.holidays_missing`; stale chip uses `freshness.prices_stale`. Test: **SYS-14** (header part).

## Read first
- docs/06-frontend-spec.md sections 4.2, 6.4 (Overview)
- docs/06a-design-system.md section 5
- `CLAUDE.md` (rules), `docs/00-legal-and-safety.md` (Safe Edition guards)

## Goal
Build the stock page shell, price header, refresh flow, banners and the Overview tab.

## In scope
- Sticky header with LTP, change, quote age, RangeBar, actions (watchlist, alert, add transaction, compare, refresh)
- Refresh flow with polling and every state/error copy
- Banners: broker disconnected, manual price mode, UNCONFIRMED_ACTION (Confirm/Reject), warnings[]
- Overview: KPI grid with source/no-data chips, Gauges, mini candlestick, performance bars, quality radar, upcoming events, actions, research links card

## Out of scope (do not do in this task)
- Nothing else; stay within the scope above.

## Deliverables
- `app/stocks/[symbol]/*`, components, tests

## Steps
1. Implement tab routing via `?tab=`
2. Implement refresh polling and cooldown messages
3. Add field-map entries for every Overview field

## Acceptance criteria (all must be true)
- [ ] PRC/BRK UI states verified (stale, no data, backfill pending)
- [ ] Field-coverage test passes for `/stocks/{symbol}` and `/indicators` fields
- [ ] Axe clean

## Required tests (from `docs/07-edge-cases-tests.md`)
- `UI-01` (see `docs/07-edge-cases-tests.md`)
- `UI-09` (see `docs/07-edge-cases-tests.md`)
- `BRK-12` (see `docs/07-edge-cases-tests.md`)
- `ACT-01` (see `docs/07-edge-cases-tests.md`)

## Definition of done
- [ ] Behavior matches the cited spec sections exactly (note section numbers in the PR description).
- [ ] Tests above exist, run in CI and pass; new edge cases discovered are added to `docs/07-edge-cases-tests.md`.
- [ ] Loading/empty/partial/stale/error states implemented for any UI work.
- [ ] No secrets or personal data in code, logs or fixtures; deny-list check passes.
- [ ] `docs/RUNBOOK.md` updated for any new variable, job or failure mode.
- [ ] Questions or spec conflicts recorded in `docs/OPEN_QUESTIONS.md` instead of guessed.
