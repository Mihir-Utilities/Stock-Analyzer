# Task Index and Order

Each file is a self-contained work package: goal, scope, out-of-scope, deliverables, steps, acceptance criteria, required tests (IDs from `docs/07-edge-cases-tests.md`) and a definition of done. Claude Code should receive **one task at a time** (see `PROMPT_FOR_CLAUDE_CODE.md`).

## Tracks
| Track | Folder | Tasks | What it covers |
|---|---|---|---|
| Foundation | `foundation/` | T00-T02 | Repo, CI, safety guards, spikes, migrations |
| Backend (Go API) | `backend/` | B01-B14 | HTTP API, auth, imports, portfolio, alerts API, MF API |
| Data/Worker (Python) | `data/` | D01-D08 | Ingestion jobs (`post_import`), analytics, alerts, ML, housekeeping (broker adapter D02 removed) |
| Frontend (Next.js) | `frontend/` | F01-F15 | Design system, screens, visualisations |

## Recommended order (sequential waves; tasks inside a wave can run in parallel)
| Wave | Tasks | Notes |
|---|---|---|
| 0 | T00 -> T01 -> T02 | T01 in manual price mode: S1 recorded as manual, S2-S5 skipped (docs/08); S6-S17 as specified; owner involvement for S9/S12-S14/S17. T02 can run in parallel with T01 after T00 |
| 1 | B01, D01, F01 | Then B02, F02 |
| 2 | B03, F03 | **D02 is REMOVED in manual mode** (decisions D-1, D-2; file kept as a stub). Tracked-set logic lives in B03/B11 (API) and D08 (housekeeping) |
| 3 | D03, B09, B04, then B06a | Prices flow end-to-end by import. **B08 reduced** to `GET /broker/status` (do it with B02). **B06a** = instruments + prices importers, upload store, Add stock, post_import enqueue (split of B06) |
| 4 | D05 (indicators and returns first), F04, F05, F06, F13a | Stock page with chart and indicators. **F13a** = import wizard for instruments/prices, Add stock form, storage tab (split of F13) |
| 5 | B05, B06b, B07, F07, F08, F13b | Owner data: remaining importers/forms (B06b, F13b = the rest of B06/F13), fundamentals, ownership, events |
| 6 | D05 (fundamentals/scores part), B13, F10 | Peers, compare, screener |
| 7 | D04, B10, F14 | Mutual funds |
| 8 | B11, B12, D06, F11, F12 | Portfolio, alerts, Telegram, settings (no broker card) |
| 9 | D07, B14, F09 | Experimental predictions |
| 10 | D08, F15 | Hardening, workflows, polish |

## Contract-first rule (lets frontend and backend run in parallel)
1. B01 produces `openapi.yaml` and generated TypeScript types from `docs/03-api-spec.md`.
2. Frontend tasks develop against a mock server generated from the OpenAPI examples (MSW), then switch to the real API when the backend task lands.
3. Any change to an endpoint contract must update `docs/03-api-spec.md`, `openapi.yaml` and `docs/field-map.json` in the same PR.

## Counts
39 active task files (T00-T02, B01-B14, D01 and D03-D08, F01-F15; D02 is a REMOVED stub). Tracked work items in `PROGRESS.md` = 42: D05 -> D05a + D05b, B06 -> B06a + B06b, F13 -> F13a + F13b.

## Dependency summary
```
T00 -> T01, T02
T00,T02 -> B01 -> B02 -> B03,B08(status only),B10,B12 ; B03 -> B04,B05,B11 ; D01 -> B09 ; B03,B09 -> B06a ; B05,B06a -> B06b -> B07
T00,T02 -> D01 -> D03 -> D05 -> D07 ; D01 -> D04 ; D03,B12 -> D06 ; D01,D03..D07 -> D08      (D02 removed)
T00,B01 -> F01 -> F02 -> F03 -> F04..F14 -> F15 ; F13a needs B06a, F13b needs B06b
```

## Splits and removals made for manual price mode (2026-10-10)
- **D02 removed.** `tasks/data/D02-*.md` is a stub marked REMOVED.
- **B06 -> B06a + B06b.** B06a: `instruments` and `prices` importers (incl. reserved symbols, size guard, streaming, 5,000-row chunks, `import_upload`), `POST /instruments`, templates, post_import enqueue, `DELETE /stocks/{symbol}/prices`, `POST /prices/trim`. B06b: all other importers and manual forms, undo.
- **F13 -> F13a + F13b.** F13a: instruments/prices wizard, Add stock form, storage tab with Trim history, Delete-prices action on the Data tab. F13b: the rest.
- The 4 IDs keep their file names; each file lists which half it covers.

## Splitting rule when a task feels too big
Do not invent new scope. Split along the "Steps" list, keep acceptance criteria attached to the piece that satisfies them, and record the split in the PR description.
