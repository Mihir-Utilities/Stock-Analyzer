# F20 - Portfolio risk section on /portfolio: concentration, position stress, value history and drawdown

| Field | Value |
|---|---|
| Track | frontend |
| Depends on | F11, F16 (portfolio page and the All / Equity / Mutual funds switcher), F02 (`ChartFrame`), F03 (definitions generator), B19 (data; MSW fixtures until it lands) |
| Size | M |
| Status | PROPOSED -> BUILT by the item-C agent |

## Read first
- docs/06-frontend-spec.md sections 3, 5, 7, 8 and **6.7b** (and 6.7a for the switcher); docs/03-api-spec.md **12b**; docs/05 8.6 (wording and the owner texts); docs/07 rows `PRK-U*`, `PRK-E01`
- `apps/web/src/components/portfolio/PortfolioPage.tsx`, `ViewCards.tsx`, `ChartsSection.tsx`, `components/ui/*` (ChartFrame), `scripts/gen-definitions.mjs`, `lib/portfolio/*`
- `CLAUDE.md`, `docs/00-legal-and-safety.md`

## Goal
A lazy-loaded "Portfolio risk" section that follows the page's view switcher and shows concentration (tiles, weight bars, tables with an Unclassified row), position stress (what-if table) and the time-weighted index with drawdown (two ChartFrame charts), exactly as docs/06 6.7b. The browser computes nothing.

## In scope
zod schemas with per-field degradation; fixtures from the docs/05 vectors; the section component loaded with `next/dynamic`; definitions via `npm run gen:definitions`; `format.ts` for every figure; tokens only; `data-testid` on every interactive element; real ids in `docs/field-map.json`; Playwright spec (axe both themes at 375 and 1440 px, keyboard on the view switch, no page scroll); RUNBOOK 151 (UI part).

## Out of scope
Any computation of weights, impacts, drawdown or index in the browser; a second switcher; benchmark lines; forecast or advice text; new dependencies; colour that says good or bad.

## Acceptance criteria
- [ ] `PRK-U01..U07` and `PRK-E01` pass; UI-09 (strict, `f15-polish.test.tsx` untouched) passes with real ids.
- [ ] Reasons are visible text and reachable by keyboard and touch; polite live region on a view change; no 0, NaN or Infinity.
- [ ] `npm run check:bundle` keeps the portfolio route under 250 kB gzip (lazy load); eslint, prettier, tsc, build pass.

## Required tests
`PRK-U01..U07`, `PRK-E01`, UI-09, existing portfolio tests (regression).

## Definition of done
- [ ] Matches docs/06 6.7b; all states (loading, empty, partial, stale, error) implemented; RUNBOOK 151 updated.
