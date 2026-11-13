# B21 - Relative strength against the Nifty 50 and sector peers: worker block and API pass-through

| Field | Value |
|---|---|
| Track | backend (worker `apps/worker`; the Go API only passes the block through) |
| Depends on | B16 (analysis blocks, `InvContext`, `snapshot._analysis`), D05 (snapshot), B06a (NIFTY50 reserved symbol import into `market_series`), B03 (instrument sector) |
| Size | M |
| Status | PROPOSED (decision RST, `docs/PLAN-investor-additions.md` item E; questions RST-1..RST-8 in `docs/OPEN_QUESTIONS.md`) |

## Read first
- `CLAUDE.md`, `docs/00-legal-and-safety.md`, `docs/PLAN-investor-additions.md` (0, 1, 2 item E, 3, 4, 5)
- `docs/05-analytics-spec.md` sections 1, 4 (beta alignment), 12.0 and **12.14** (formulas, vectors RA1-RA3, RP1-RP3, owner texts)
- `docs/03-api-spec.md` 4 and **4a.RST**; `docs/07-edge-cases-tests.md` rows `RST-I`, `RST-B`, `RST-P`, `RST-W`, `RST-Z`
- `apps/worker/worker/analytics/analysis_series.py`, `returns.py` (`align`, `rolling_beta`), `snapshot.py`, `inv_common.py`; `apps/worker/worker/analysis_db.py`

## Goal
Add `analysis.relative_strength` to the stored snapshot: relative return over trailing windows and calendar years against the owner-imported NIFTY50, the rebased ratio line, the share of rolling one-year periods that beat the index, and the stock's return rank among tracked stocks of the same sector over 3, 6 and 12 months. Descriptions of past prices: no verdict, no score, no target, no forecast.

## In scope
- New pure module `apps/worker/worker/analytics/relative_strength.py` (`mypy --strict`, numpy, no clock, no database): alignment, trailing windows, years, rebased ratio, rolling-year share, peer ranks; windows and minimums are arguments (the vectors use small ones).
- Minimal wiring: a block in `snapshot._analysis` (isolated: an exception makes that half `null` with `compute_error` and is logged, never aborting the snapshot), `InvContext` gains the peer inputs, `analysis_db` loads the stock's sector with the existing instrument read and the peers' recent prices with **one** extra grouped read, only when the stock has a sector.
- API: `GET /stocks/{symbol}/indicators` passes the block through (no Go code expected; a test pins it).
- Contract: `docs/03` 4a.RST, `openapi.yaml` (`InvRelativeStrength`), regenerated `packages/api-types`, `docs/field-map.json` (together with F22 when the test ids exist).
- RUNBOOK section 153; measured cost recorded in `docs/OPEN_QUESTIONS.md`.

## Out of scope
- Any UI (F22); a sector index or any new data source (RST-1); up and down capture (RST-5); a cross-stock recompute; a new route, query parameter or migration; changing existing blocks.

## Steps
1. Vectors RA1-RA3, RP1-RP3 as failing tests; 2. the pure module; 3. wiring and loaders, isolation and strict-JSON checks; 4. DB tests (RP3, query count, failure isolation, pruning, size); 5. API pass-through test; 6. measure the extra cost per `compute_analysis`; 7. RUNBOOK.

## Acceptance criteria (all must be true)
- [ ] Rows `RST-I01..I11`, `RST-P01..P08`, `RST-B01..B05`, `RST-W01`, `RST-Z01` pass; vectors match (1e-4 on percentages, exact on counts, dates and reasons).
- [ ] Index missing or short: `vs_index` null `no_index_series`; fewer than 252 aligned returns: the 1-year figures null `insufficient_overlap`; never 0, NaN or Infinity.
- [ ] Fewer than 3 peers: ranks hidden with `too_few_peers`; no sector: `no_sector`; a failing half is `compute_error` and the rest of the snapshot is written.
- [ ] Existing `analysis` keys unchanged; the snapshot stays under the 200 KB budget; one extra grouped read per `compute_analysis`.
- [ ] No new egress, no new dependency; deny-list, SAF-13, licence scan pass; `ruff check`, `ruff format --check`, `mypy --strict`, full worker pytest, API tests (if Go is touched), `check:generated` pass.

## Required tests
`RST-I*`, `RST-P*`, `RST-B*`, `RST-W01`, `RST-Z01`, plus the regression rows RET-89 and RET-90.

## Definition of done
- [ ] Matches `docs/05` 12.14 and `docs/03` 4a.RST exactly; `docs/RUNBOOK.md` section 153 updated; structured logs without secrets; open questions recorded instead of guessed.
