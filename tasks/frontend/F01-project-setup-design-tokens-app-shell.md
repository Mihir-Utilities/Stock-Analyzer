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
- [ ] Lighthouse a11y >= 95 on the shell. **Not run** (no Lighthouse available in the build environment). Proxy: real-browser axe (wcag2a/aa, 21a/aa, with colour contrast) reports 0 violations on `/` and `/login`, dark and light, 375 and 1440 px (`tests/e2e/shell.spec.ts`, 8 tests). Owner runs Lighthouse once (RUNBOOK section 9); F15 automates it.
- [x] No external network requests at runtime: Playwright "every request stays on this origin and the CSP blocks nothing we ship" (shell, login, 404) plus unit scan of `src` for http(s) hosts (`theme.test.ts`); fonts self-hosted.
- [x] `next` param cannot redirect off-origin (SEC-06): `safe-next.test.ts` (35 cases), `security.test.ts` (middleware), e2e "protocol-relative path never produces an off-origin redirect".

Evidence for the required tests: SEC-06 `safe-next.test.ts`, `security.test.ts`, e2e; UI-01 `api-client.test.ts` "cold start (UI-01)" and `shell.test.tsx` "waking banner"; UI-03 e2e "responsive shell" at 320/375/768/1024/1440; UI-04 `theme.test.ts` (hex equals docs, contrast, known deviations OQ-16) plus e2e axe in both themes; SAF-03 `shell.test.tsx` "footer disclaimer" and e2e "footer on every page". Storybook (step 4): `npm run build-storybook` passes (stories in `src/components/shell/shell.stories.tsx`).

## Required tests (from `docs/07-edge-cases-tests.md`)
- `SEC-06` (see `docs/07-edge-cases-tests.md`)
- `UI-01` (see `docs/07-edge-cases-tests.md`)
- `UI-03` (see `docs/07-edge-cases-tests.md`)
- `UI-04` (see `docs/07-edge-cases-tests.md`)
- `SAF-03` (see `docs/07-edge-cases-tests.md`)

## Definition of done
- [x] Behavior matches the cited spec sections exactly (06a sections 2, 3, 9; 06 sections 1, 2, 4.6, 5, 9). Deviations: CSP nonce (06 section 1 amended), contrast of spec hex values (OQ-16, open).
- [x] Tests above exist, run in CI and pass; new edge cases added (SEC-14, SEC-15, UI-11..UI-15).
- [x] States for shell primitives: waking (loading), error panel with Retry and request id, not-found; data states arrive with screens.
- [x] No secrets or personal data in code, logs or fixtures; deny-list check passes.
- [x] `docs/RUNBOOK.md` updated (section 9: API_BASE_URL, CSP, tests, Lighthouse).
- [x] Questions recorded in `docs/OPEN_QUESTIONS.md` (OQ-16, F01-1..F01-5).
