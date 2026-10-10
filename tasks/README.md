# Task Index and Order

Each file is a self-contained work package: goal, scope, out-of-scope, deliverables, steps, acceptance criteria, required tests (IDs from `docs/07-edge-cases-tests.md`) and a definition of done. Claude Code should receive **one task at a time** (see `PROMPT_FOR_CLAUDE_CODE.md`).

## Tracks
| Track | Folder | Tasks | What it covers |
|---|---|---|---|
| Foundation | `foundation/` | T00-T02 | Repo, CI, safety guards, spikes, migrations |
| Backend (Go API) | `backend/` | B01-B14 | HTTP API, auth, imports, portfolio, alerts API, MF API |
| Data/Worker (Python) | `data/` | D01-D08 | Broker adapter, ingestion, analytics, alerts, ML, jobs |
| Frontend (Next.js) | `frontend/` | F01-F15 | Design system, screens, visualisations |

## Recommended order (sequential waves; tasks inside a wave can run in parallel)
| Wave | Tasks | Notes |
|---|---|---|
| 0 | T00 -> T01 -> T02 | T01 (spikes) needs the owner for broker login; T02 can run in parallel with T01 after T00 |
| 1 | B01, D01, F01 | Then B02, F02 |
| 2 | B03, F03, D02 | D02 needs `docs/BROKER_DECISION.md` from T01 |
| 3 | D03, B08, B09, B04 | Prices flow end-to-end |
| 4 | D05 (indicators and returns first), F04, F05, F06 | Stock page with chart and indicators |
| 5 | B05, B06, B07, F07, F08, F13 | Owner data: imports, fundamentals, ownership, events |
| 6 | D05 (fundamentals/scores part), B13, F10 | Peers, compare, screener |
| 7 | D04, B10, F14 | Mutual funds |
| 8 | B11, B12, D06, F11, F12 | Portfolio, alerts, Telegram, settings, broker UI |
| 9 | D07, B14, F09 | Experimental predictions |
| 10 | D08, F15 | Hardening, workflows, polish |

## Contract-first rule (lets frontend and backend run in parallel)
1. B01 produces `openapi.yaml` and generated TypeScript types from `docs/03-api-spec.md`.
2. Frontend tasks develop against a mock server generated from the OpenAPI examples (MSW), then switch to the real API when the backend task lands.
3. Any change to an endpoint contract must update `docs/03-api-spec.md`, `openapi.yaml` and `docs/field-map.json` in the same PR.

## Dependency summary
```
T00 -> T01, T02
T00,T02 -> B01 -> B02 -> B03,B08,B10,B12 ; B03 -> B04,B05,B11 ; B05 -> B06 -> B07 ; B08,D01 -> B09
T00,T02 -> D01 -> D02(T01) -> D03 -> D05 -> D07 ; D01 -> D04 ; D03,B12 -> D06 ; D01..D07 -> D08
T00,B01 -> F01 -> F02 -> F03 -> F04..F14 -> F15
```

## Splitting rule when a task feels too big
Do not invent new scope. Split along the "Steps" list, keep acceptance criteria attached to the piece that satisfies them, and record the split in the PR description.
