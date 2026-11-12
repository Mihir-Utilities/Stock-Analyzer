# F19 - Swing dips card on the Analysis tab

| Field | Value |
|---|---|
| Track | frontend |
| Depends on | F17 (Analysis cards and the card shell), F03 (definitions generator), B18 (data; develop against fixtures built from the docs/05 vectors until it lands) |
| Size | M (S < 0.5 day, M 0.5-1.5 days, L 1.5-4 days of focused work) |
| Status | PROPOSED (plan item A, `docs/PLAN-investor-additions.md`) |

## Read first
- docs/06-frontend-spec.md 6.4 and **6.4a item 4a** (and the principles above it); docs/03-api-spec.md section 4a-swing
- docs/05-analytics-spec.md 12.13 (wording, honesty, the owner text)
- docs/07-edge-cases-tests.md rows `SWD-U`, `SWD-E`, `SWD-Z01`, UI-09
- `apps/web/src/components/stock/chart/AnalysisTab.tsx`, `InvCards.tsx` (card shell and helpers), `lib/stock/inv-schemas.ts`, `scripts/gen-definitions.mjs`, `tests/e2e/f17-inv.spec.ts`
- `CLAUDE.md` (rules), `docs/00-legal-and-safety.md`

## Goal
Show "Swing dips" beside the unchanged "Drawdown profile": the summary per fall size, the last 8 dips with the open one flagged, and the swing-legs summary, with sample sizes, reasons and the line "how this differs from the all-time-high view".

## In scope
- A lazy-loaded card component (own file) using the F17 card shell; zod schema with per-field degradation in its own file; the block parsed on its own (a bad block degrades this card only).
- One line in `AnalysisTab.tsx` (lazy import and placement beside the Drawdown profile); `swing_dips` owner text added to `gen-definitions.mjs` `ENTRIES` and `npm run gen:definitions`; `docs/field-map.json` ids real (`inv-swing`, `inv-swing-table`, `inv-swing-records`, `inv-swing-legs`).
- Unit tests (`swd-f19.test.tsx`) and Playwright (`swd-f19.spec.ts`: axe in both themes at 375 and 1440 px, keyboard, no page scroll).

## Out of scope
- Changes to the Drawdown profile card; computing anything in the browser; charts; a verdict, score or target; new dependencies.

## Acceptance criteria (all must be true)
- [ ] Every row `SWD-U01..U12`, `SWD-E01..E02` passes; web unit suite, eslint, prettier, tsc, build, `npm run check:bundle`, `check:generated` pass.
- [ ] The open dip is visibly labelled in text; hidden medians show reasons as visible and visually hidden text; tokens only; every interactive element has a `data-testid`; numbers only through `format.ts`.
- [ ] The Drawdown profile card is byte-for-byte unchanged in behaviour.

## Definition of done
- [ ] Behaviour matches docs/06 6.4a item 4a exactly; states (loading, empty, partial, stale, error) implemented; RUNBOOK section 150 updated; open questions recorded.
