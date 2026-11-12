# B18 - Swing dips: worker block and API passthrough

| Field | Value |
|---|---|
| Track | backend (worker `apps/worker`; Go API passthrough test only) |
| Depends on | B16 (analysis blocks, `snapshot._analysis`, `inv_common.py`, `investing.py`, done), B04 (`/indicators`, done) |
| Size | M (S < 0.5 day, M 0.5-1.5 days, L 1.5-4 days of focused work) |
| Status | PROPOSED (plan item A, `docs/PLAN-investor-additions.md`; questions SWD-1..SWD-8 in `docs/OPEN_QUESTIONS.md`) |

## Read first
- docs/05-analytics-spec.md sections 12.0, 12.4 (drawdown profile, unchanged), 12.6 (entry-point study window) and **12.13** (rules, golden vectors SW1-SW4)
- docs/03-api-spec.md section 4a-swing; docs/07-edge-cases-tests.md rows `SWD-W`, `SWD-A`, `SWD-Z01`
- `apps/worker/worker/analytics/investing.py`, `inv_common.py`, `snapshot.py` (`_analysis`), `analysis_series.py`
- `CLAUDE.md` (rules), `docs/00-legal-and-safety.md` (Safe Edition guards)

## Goal
Compute `analysis.swing_dips` (falls of at least 10% and 20% from the 252-row high, recovered or not, plus zig-zag swing legs) from the stock's own imported prices and store it in the analysis snapshot, next to the unchanged `drawdown_profile`. Descriptions of past prices only: no verdict, no target.

## In scope
- `apps/worker/worker/analytics/swing_dips.py` (pure numpy, `mypy --strict`): rule A and rule B of docs/05 12.13, windows and thresholds as arguments; golden vectors SW1-SW4 as failing tests first.
- Minimal wiring in `snapshot._analysis`: one key `swing_dips`, computed in its own guarded step; on any exception the block is `None`, `swing_dips_reason` is `compute_error` and the error is logged (structlog/zerolog-style JSON, no secrets); the snapshot is never aborted.
- API: no code change expected (`data.analysis` passes unknown blocks through); add a test pinning the passthrough and the null-plus-reason shape. Contract: docs/03, `openapi.yaml`, `packages/api-types` and `docs/field-map.json` agree (`npm run check:generated` clean).
- RUNBOOK section 150.

## Out of scope
- Any UI (F19); changes to `drawdown_profile` or any other existing block; a new route; new settings; selectable thresholds; a target, verdict or score; any new network access or data source.

## Acceptance criteria (all must be true)
- [ ] Every row `SWD-W01..W18`, `SWD-A01..A02`, `SWD-Z01` passes; vectors SW1-SW4 exact on counts and dates, 1e-4 on percents.
- [ ] The existing `drawdown_profile` and every other block are unchanged (VD1 and the INV rows still pass).
- [ ] A failing swing block yields `null` plus `compute_error` and a log line while the rest of the snapshot is stored.
- [ ] No 0, NaN or Infinity for unknown values; snapshot growth under 6 KB; `compute_analysis` time not noticeably changed.
- [ ] Worker `ruff check`, `ruff format --check`, `mypy --strict`, full pytest, deny-list and licence scan pass.

## Definition of done
- [ ] Behaviour matches docs/05 12.13 and docs/03 4a-swing exactly; tests pass in CI; `docs/RUNBOOK.md` section 150 updated; open questions recorded instead of guessed.
