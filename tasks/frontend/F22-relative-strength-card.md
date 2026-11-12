# F22 - Relative strength card (against the Nifty 50 and sector peers)

| Field | Value |
|---|---|
| Track | frontend (`apps/web`) |
| Depends on | B21 (data), F17 (Analysis tab cards, shared card state), F02 (`ChartFrame`), F03 (`format.ts`, definitions) |
| Size | M |
| Status | PROPOSED (decision RST) |

## Read first
- `CLAUDE.md`, `docs/PLAN-investor-additions.md` item E; `docs/06-frontend-spec.md` 6.4a and **6.4a.RST**; `docs/06a-design-system.md`; `docs/05-analytics-spec.md` 12.14 (owner texts); `docs/03-api-spec.md` 4a.RST
- `apps/web/src/components/stock/chart/AnalysisTab.tsx`, `InvCards.tsx`, the shared card-state components of F17; `tests/unit/f15-polish.test.tsx` (the strict field-coverage guard: never edit it)

## Goal
A lazily loaded "Relative strength" card in the Analysis tab: window and calendar-year differences against the Nifty 50, the rebased ratio line (`ChartFrame`), the share of past one-year periods that beat the index (with the overlap statement), the alignment and dropped-date line, and the peer rank strip. Wording as in docs/06 6.4a.RST; "Beating the index in the past is not a forecast." No verdict, no score, no colour judgement.

## In scope
- `RelativeStrengthCard` (new file), `next/dynamic`, one line in `AnalysisTab.tsx`; zod schema with per-field degradation; source and as-of chip, sample sizes, Small sample chips, How to read, note line, reasons reachable by keyboard and touch, the owner hint for `no_index_series` with the Import Center link, tokens only, `format.ts`, `data-testid` on every interactive element and on the ids named in 6.4a.RST.
- `docs/field-map.json` entries mapped to real test ids; `ENTRIES` for the four owner texts in `scripts/gen-definitions.mjs` and `npm run gen:definitions`.
- Unit tests (`tests/unit/rst-f22.test.tsx`) and the Playwright spec `f22-rst` (axe both themes at 375 and 1440 px, no page scroll, keyboard).

## Out of scope
Changing any API field; computing anything in the browser beyond formatting and selecting; a sector index; up/down capture; editing `f15-polish.test.tsx`.

## Acceptance criteria
- [ ] Rows `RST-C01..C07`, `RST-E01..E02`, `RST-W02` pass; states loading, empty (not computed), partial, stale, error implemented; 375 px has no horizontal page scroll.
- [ ] Web unit suite, eslint, prettier, tsc, `npm run build`, `npm run check:bundle`, `check:generated`, `gen:definitions --check` pass; the card is in its own lazy chunk.

## Definition of done
- [ ] Matches docs/06 6.4a.RST exactly; RUNBOOK 153 test commands correct; open questions recorded.
