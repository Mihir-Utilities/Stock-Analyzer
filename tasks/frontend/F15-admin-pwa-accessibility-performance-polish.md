# F15 - Admin, PWA, accessibility, performance, polish

| Field | Value |
|---|---|
| Track | frontend |
| Depends on | F04..F14 |
| Size | M (S < 0.5 day, M 0.5-1.5 days, L 1.5-4 days of focused work) |

## Read first
- docs/06-frontend-spec.md sections 6.12, 7, 8
- docs/06a-design-system.md section 10
- `CLAUDE.md` (rules), `docs/00-legal-and-safety.md` (Safe Edition guards)

## Goal
Finish the admin screen, PWA, accessibility, performance budgets, field-coverage enforcement and visual polish.

## In scope
- Admin status page
- PWA manifest/icons/service worker (shell only)
- Field-coverage test wired to OpenAPI and `docs/field-map.json`
- Lighthouse/axe/bundle-budget CI gates; visual regression baselines; keyboard and screen-reader pass
- Final design review at 320/375/768/1024/1440 in both themes

## Out of scope (do not do in this task)
- Nothing else; stay within the scope above.

## Deliverables
- `app/admin/*`, `public/manifest.json`, `sw.js`, CI gates

## Steps
1. Wire CI budgets and fix violations
2. Run manual a11y checklist and record results in RUNBOOK

## Acceptance criteria (all must be true)
- [ ] Lighthouse >= 90 perf / >= 95 a11y on main routes
- [ ] Zero serious axe violations
- [ ] Field coverage test passes with no unmapped fields

## Required tests (from `docs/07-edge-cases-tests.md`)
- `UI-03` (see `docs/07-edge-cases-tests.md`)
- `UI-04` (see `docs/07-edge-cases-tests.md`)
- `UI-06` (see `docs/07-edge-cases-tests.md`)
- `UI-08` (see `docs/07-edge-cases-tests.md`)
- `UI-09` (see `docs/07-edge-cases-tests.md`)
- `UI-10` (see `docs/07-edge-cases-tests.md`)
- `SEC-11` (see `docs/07-edge-cases-tests.md`)

## Definition of done
- [ ] Behavior matches the cited spec sections exactly (note section numbers in the PR description).
- [ ] Tests above exist, run in CI and pass; new edge cases discovered are added to `docs/07-edge-cases-tests.md`.
- [ ] Loading/empty/partial/stale/error states implemented for any UI work.
- [ ] No secrets or personal data in code, logs or fixtures; deny-list check passes.
- [ ] `docs/RUNBOOK.md` updated for any new variable, job or failure mode.
- [ ] Questions or spec conflicts recorded in `docs/OPEN_QUESTIONS.md` instead of guessed.
