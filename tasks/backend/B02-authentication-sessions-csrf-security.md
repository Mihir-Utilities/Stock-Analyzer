# B02 - Authentication, sessions, CSRF, security

| Field | Value |
|---|---|
| Track | backend |
| Depends on | B01 |
| Size | M (S < 0.5 day, M 0.5-1.5 days, L 1.5-4 days of focused work) |

## Read first
- docs/03-api-spec.md section 2
- docs/07-edge-cases-tests.md SEC-01..SEC-12
- `CLAUDE.md` (rules), `docs/00-legal-and-safety.md` (Safe Edition guards)

## Goal
Implement the single-user password login with lockout, hashed sessions and CSRF protection.

## In scope
- POST login/logout/logout-all/change-password, GET me
- argon2id verification, sha256-hashed random session tokens, sliding expiry (update at most hourly)
- Lockout rules with doubling delay, identical error messages, random 300-800 ms delay
- CSRF header requirement for all non-GET requests; open-redirect-safe `next` handling helper
- Auth middleware protecting all routes except `/healthz`, `/auth/login`, `/telegram/webhook`, `/broker/callback`
- Password policy (min 12, differs from current)

## Out of scope (do not do in this task)
- UI
- Telegram webhook logic (B12)
- Broker callback logic (B08)

## Deliverables
- `internal/auth/*`
- handlers and middleware
- integration tests

## Steps
1. Implement password hashing/verification and session store
2. Implement lockout state in `app_user`
3. Add middleware and wire route groups
4. Write integration tests for every SEC-* row listed

## Acceptance criteria (all must be true)
- [ ] All SEC-01, 02, 03, 09, 10, 12 tests pass
- [ ] Cookie flags: httpOnly, Secure, SameSite=Lax
- [ ] Changing the password revokes other sessions

## Required tests (from `docs/07-edge-cases-tests.md`)
- `SEC-01` (see `docs/07-edge-cases-tests.md`)
- `SEC-02` (see `docs/07-edge-cases-tests.md`)
- `SEC-03` (see `docs/07-edge-cases-tests.md`)
- `SEC-06` (see `docs/07-edge-cases-tests.md`)
- `SEC-09` (see `docs/07-edge-cases-tests.md`)
- `SEC-10` (see `docs/07-edge-cases-tests.md`)
- `SEC-12` (see `docs/07-edge-cases-tests.md`)

## Definition of done
- [ ] Behavior matches the cited spec sections exactly (note section numbers in the PR description).
- [ ] Tests above exist, run in CI and pass; new edge cases discovered are added to `docs/07-edge-cases-tests.md`.
- [ ] Loading/empty/partial/stale/error states implemented for any UI work.
- [ ] No secrets or personal data in code, logs or fixtures; deny-list check passes.
- [ ] `docs/RUNBOOK.md` updated for any new variable, job or failure mode.
- [ ] Questions or spec conflicts recorded in `docs/OPEN_QUESTIONS.md` instead of guessed.
