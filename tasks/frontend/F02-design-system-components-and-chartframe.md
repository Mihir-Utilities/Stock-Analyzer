# F02 - Design-system components and ChartFrame

| Field | Value |
|---|---|
| Track | frontend |
| Depends on | F01 |
| Size | L (S < 0.5 day, M 0.5-1.5 days, L 1.5-4 days of focused work) |

## Read first
- docs/06a-design-system.md sections 4-6, 10
- `CLAUDE.md` (rules), `docs/00-legal-and-safety.md` (Safe Edition guards)

## Goal
Build every shared component with all states, including the ChartFrame with data-table view and exports.

## In scope
- Card, Stat, DeltaBadge, DataTable (sticky, virtualized, sparkline/databar/heat cells, CSV export safe from injection), Gauge, RangeBar, Sparkline, chips, banners, EmptyState, Skeleton, FormField, Wizard, Timeline, Heatmap, dialogs/drawers/toasts
- `ChartFrame` around ECharts: legend toggles, range chips, Show data, PNG/CSV export, fullscreen, loading/empty/error, theme sync
- Storybook stories for all states in light/dark
- Visual-regression snapshots

## Out of scope (do not do in this task)
- Screen composition

## Deliverables
- `components/ui/*`, `components/charts/*`, stories, tests

## Steps
1. Implement components with tokens only (no ad-hoc colors)
2. Implement ChartFrame data-table parity test (UI-10)
3. Add axe checks and snapshot baselines

## Acceptance criteria (all must be true)
- [ ] Every component has stories for loading/empty/partial/stale/error
- [ ] Charts render with 0, 1, 2, 10, 2,000 points
- [ ] CSV export prefixes dangerous cells (IMP-15)

## Required tests (from `docs/07-edge-cases-tests.md`)
- `UI-07` (see `docs/07-edge-cases-tests.md`)
- `UI-10` (see `docs/07-edge-cases-tests.md`)
- `IMP-15` (see `docs/07-edge-cases-tests.md`)

## Definition of done
- [ ] Behavior matches the cited spec sections exactly (note section numbers in the PR description).
- [ ] Tests above exist, run in CI and pass; new edge cases discovered are added to `docs/07-edge-cases-tests.md`.
- [ ] Loading/empty/partial/stale/error states implemented for any UI work.
- [ ] No secrets or personal data in code, logs or fixtures; deny-list check passes.
- [ ] `docs/RUNBOOK.md` updated for any new variable, job or failure mode.
- [ ] Questions or spec conflicts recorded in `docs/OPEN_QUESTIONS.md` instead of guessed.
