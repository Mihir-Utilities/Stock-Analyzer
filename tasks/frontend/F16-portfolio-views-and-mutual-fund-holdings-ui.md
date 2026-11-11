# F16 - Portfolio views All / Equity / Mutual funds, MF holdings, MF transactions and statement import UI

| Field | Value |
|---|---|
| Track | frontend |
| Depends on | F11 (portfolio page), F13a/F13b (import wizard), F14 (funds screens), B15 (API; develop against MSW mocks from the OpenAPI examples until it lands) |
| Size | L (S < 0.5 day, M 0.5-1.5 days, L 1.5-4 days of focused work) |
| Status | PROPOSED (D-MF spec, 2026-11-11); do not start before the owner answers the blocking questions in `docs/OPEN_QUESTIONS.md` (MFH-2, MFH-3, MFH-4, MFH-5, MFH-14, MFH-15) |

## Read first
- docs/06-frontend-spec.md sections 3, 5, 6.2, 6.7, 6.7a, 8, 9
- docs/03-api-spec.md section 12a
- docs/05-analytics-spec.md section 8.5 (labels and honesty only; the UI never computes totals or XIRR)
- docs/07-edge-cases-tests.md rows MFH-U70..U78
- `CLAUDE.md` (rules), `docs/00-legal-and-safety.md` (Safe Edition guards), `docs/OPEN_QUESTIONS.md` decision D-MF and questions MFH-1..MFH-22

## Goal
The All / Equity / Mutual funds switcher on `/portfolio` and the Dashboard snapshot, the MF holdings table, MF transactions list and form, and the `mf_statement` import wizard, as specified in `docs/06` 6.7a.

## In scope
- Switcher (`?view=`, default all), per-view cards, breakdown table, MF holdings table, allocation by asset class/scheme/category, MF transactions tab with Add/Edit/Delete and server messages, import entry (`/imports?kind=mf_statement`) and its preview in the F13 wizard, all states (loading, empty, partial, stale, error), under-one-year display, return-basis labels, attribution.
- zod schemas for the new responses; `format.ts` only for formatting; tokens only; ECharts via `ChartFrame`; `data-testid` on every interactive element; replace the `conditional:` entries of `docs/field-map.json` with real test ids (UI-09 guard).

## Out of scope
- Any calculation of totals, XIRR or P&L in the browser; third-party calls; forecasts; switch/merger entry (not offered, MFH-4); benchmark for All/MF.

## Steps
1. Schemas and fixtures (MSW) from the OpenAPI examples; 2. switcher and summary cards; 3. MF holdings and allocation; 4. transactions list/form; 5. import wizard kind; 6. states, a11y, field-map.

## Acceptance criteria (all must be true)
- [ ] MFH-U70..U78 pass; UI-09 field coverage passes with no `conditional:` placeholder left for these fields.
- [ ] No `0`, `NaN` or `Infinity` for unknown values; partial totals are never shown as complete; stale NAV chip works; under-one-year shows absolute return only.
- [ ] Axe, keyboard and responsive checks pass for the switcher and the form.

## Required tests
`MFH-U70..U78`, `UI-68`, `UI-69`, `UI-70` (regression), `SAF-03`.

## Definition of done
- [ ] Behaviour matches `docs/06` 6.7a exactly; tests pass in CI; loading/empty/partial/stale/error states implemented; no secrets or personal data in fixtures.
