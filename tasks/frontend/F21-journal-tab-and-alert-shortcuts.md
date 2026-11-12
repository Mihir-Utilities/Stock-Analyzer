# F21 - Journal tab on the stock page and alert shortcuts in the Analysis tab

| Field | Value |
|---|---|
| Track | frontend |
| Depends on | F06 (Analysis tab), F12 (alert form), F05 (stock page tabs), F17 (Price position fact), B20 (develop against MSW mocks from the OpenAPI examples until it lands) |
| Size | M (S < 0.5 day, M 0.5-1.5 days, L 1.5-4 days of focused work) |
| Status | SPEC (plan Item D; questions JRN-1..JRN-6, ALS-1..ALS-4 in `docs/OPEN_QUESTIONS.md`) |

## Read first
- `docs/PLAN-investor-additions.md` sections 0, 2 (Item D), 4
- `docs/06-frontend-spec.md` sections 3, 5, 6.4, **6.4b**, 6.8, 7, 8, 9; `docs/03-api-spec.md` sections 13 and **13a**
- `docs/07-edge-cases-tests.md` rows `JRN-25..JRN-30`, `ALS-01..ALS-09`, `UI-09`
- `apps/web/src/components/alerts/AlertForm.tsx`, `lib/alerts/*`, `components/stock/StockPage.tsx`, `components/stock/chart/AnalysisTab.tsx`, `components/ui/overlays.tsx`
- `CLAUDE.md`, `docs/00-legal-and-safety.md`

## Goal
Let the owner jot down why they hold or watch a stock and review it later, and set an alert at a level taken from facts already on the Analysis tab, using the existing alerts API.

## In scope
- Journal tab (`journal`, lazy), list, filter, form with counter, review date and transaction link, status toggle, edit, delete with confirmation, "Review due" chip and count from the API's `today`, states loading/empty/partial/error, focus management and polite live region, 375 px.
- zod schemas per field (an item with a bad optional field still renders its note); no `dangerouslySetInnerHTML`; notes rendered as text.
- Alert shortcuts card in the Analysis tab (levels: 10% and 20% below the 52-week highest close, the 200-day average), exact level and source and as-of on each button, an optional `prefill` prop on the existing `AlertForm` (smallest change, ALS-3), drawer, existing `THRESHOLD_ALREADY_MET` message.
- `format.ts` for every number and date, tokens only, `data-testid` on every interactive element, real ids in `docs/field-map.json` for the new fields (strict f15-polish guard; never edit that test).
- Unit tests, a Playwright spec (axe in both themes at 375 and 1440 px, keyboard paths), RUNBOOK section 152 (web part).

## Out of scope
- A dip-low shortcut (ALS-1), new alert kinds, URL deep links into the alert form, Telegram reminders, export, markdown or HTML in notes, any calculation other than the arithmetic of a price level.

## Steps
1. Schemas, API hooks, MSW fixtures; 2. level maths (decimal strings) with tests; 3. alert shortcuts card and `AlertForm` prefill; 4. journal list and form; 5. states, focus, live regions, 375 px; 6. field map, e2e, RUNBOOK.

## Acceptance criteria (all must be true)
- [ ] Rows `JRN-25..JRN-30` and `ALS-01..ALS-09` pass; UI-09 passes with real ids.
- [ ] Axe clean in both themes at 375 and 1440 px; keyboard-only paths for adding a note and for creating an alert from a shortcut; no page-level horizontal scroll at 375 px; targets at least 44 px.
- [ ] The Alerts page behaves as before; the `check:bundle` budget holds (journal and shortcuts are lazy).
- [ ] No verdict or advice wording; reasons are visible text.

## Required tests
`JRN-25..JRN-30`, `ALS-01..ALS-09`, `UI-09`, `SAF-03`, existing alerts, Analysis and stock page tests (regression).

## Definition of done
- [ ] Behaviour matches docs/06 6.4b exactly; loading/empty/partial/stale/error states implemented; RUNBOOK section 152 updated.
