# F01 - Project setup, design tokens, app shell

| Field | Value |
|---|---|
| Track | frontend |
| Depends on | T00, B01 |
| Size | M (S < 0.5 day, M 0.5-1.5 days, L 1.5-4 days of focused work) |

## Read first
- docs/06a-design-system.md sections 2, 3, 9
- docs/06-frontend-spec.md sections 1-2
- `CLAUDE.md` (rules), `docs/00-legal-and-safety.md` (Safe Edition guards)

## Goal
Set up Next.js with tokens, theming, layout shell, routing, API client and auth gate.

## In scope
- Tailwind config from tokens, CSS variables for dark/light, Inter self-hosted
- Desktop sidebar and mobile bottom-tab shell, top bar with market-status pill placeholder, theme toggle
- API client with the 70 s timeout, waking-server state, envelope parsing, zod validation from generated types
- `middleware.ts` auth gate, `/login` redirect handling with safe `next`
- Footer disclaimer and error boundary primitives
- ECharts theme generator from tokens

## Out of scope (do not do in this task)
- Feature screens

## Deliverables
- `apps/web/*` base, `lib/api`, `lib/theme`, `components/shell`

## Steps
1. Implement tokens exactly (hex values) and verify contrast
2. Build shell responsive at 320, 375, 768, 1024, 1440
3. Implement waking-server UX
4. Add Storybook with the shell and theme toggle

## Acceptance criteria (all must be true)
- [ ] Lighthouse a11y >= 95 on the shell
- [ ] No external network requests at runtime
- [ ] `next` param cannot redirect off-origin (SEC-06)

## Required tests (from `docs/07-edge-cases-tests.md`)
- `SEC-06` (see `docs/07-edge-cases-tests.md`)
- `UI-01` (see `docs/07-edge-cases-tests.md`)
- `UI-03` (see `docs/07-edge-cases-tests.md`)
- `UI-04` (see `docs/07-edge-cases-tests.md`)
- `SAF-03` (see `docs/07-edge-cases-tests.md`)

## Definition of done
- [ ] Behavior matches the cited spec sections exactly (note section numbers in the PR description).
- [ ] Tests above exist, run in CI and pass; new edge cases discovered are added to `docs/07-edge-cases-tests.md`.
- [ ] Loading/empty/partial/stale/error states implemented for any UI work.
- [ ] No secrets or personal data in code, logs or fixtures; deny-list check passes.
- [ ] `docs/RUNBOOK.md` updated for any new variable, job or failure mode.
- [ ] Questions or spec conflicts recorded in `docs/OPEN_QUESTIONS.md` instead of guessed.
