# B08 - Broker OAuth and token storage

| Field | Value |
|---|---|
| Track | backend |
| Depends on | B02 |
| Size | M (S < 0.5 day, M 0.5-1.5 days, L 1.5-4 days of focused work) |

## Amendment: manual price mode (decisions D-1, D-2 and follow-ups, 2026-10-10)
Source of truth: `docs/OPEN_QUESTIONS.md` Decisions; updated specs: `docs/01` 7.0/7.1, `docs/03` 3, 4, 14, `docs/04` 3.9-3.13. Where this block conflicts with the sections below, **this block wins**.
- **Reduced to `GET /broker/status`** returning `{enabled:false, mode:"manual"}`. No OAuth, no `broker_oauth_state`, no token encryption, no login/callback/session routes (`422 BROKER_DISABLED` if called). Ignore the broker items below. Size drops to S.

## Read first
- docs/01-data-sources.md sections 3.1, 3.4
- docs/03-api-spec.md section 14a
- docs/07-edge-cases-tests.md BRK-01..BRK-04
- docs/BROKER_DECISION.md (from T01)
- `CLAUDE.md` (rules), `docs/00-legal-and-safety.md` (Safe Edition guards)

## Goal
Implement the read-only broker connection flow with encrypted token storage.

## In scope
- GET status/login/callback, DELETE session
- `broker_oauth_state` handling (hashed, 10 min, single use)
- AES-256-GCM token encryption with `BROKER_TOKEN_KEY`; token never returned or logged
- Broker-specific code exchange implemented per the chosen broker (adapter file), behind an interface
- `BROKER_ENABLED=false` returns `BROKER_DISABLED` everywhere (manual price mode)

## Out of scope (do not do in this task)
- Automating login
- Order endpoints or order scopes

## Deliverables
- `internal/broker/*`, handlers, tests with a fake broker server

## Steps
1. Implement state store and callback validation
2. Implement encryption helpers with test vectors
3. Implement exchange against a fake server in tests; real broker verified manually with the owner
4. Write unit tests ensuring no log line contains token text

## Acceptance criteria (all must be true)
- [ ] BRK-03, BRK-04 pass
- [ ] Reconnect revokes the old session
- [ ] Status endpoint shows minutes left
- [ ] Deny-list test confirms no order endpoint paths exist (SAF-02)

## Required tests (from `docs/07-edge-cases-tests.md`)
- `BRK-01` (see `docs/07-edge-cases-tests.md`)
- `BRK-03` (see `docs/07-edge-cases-tests.md`)
- `BRK-04` (see `docs/07-edge-cases-tests.md`)
- `SAF-02` (see `docs/07-edge-cases-tests.md`)

## Definition of done
- [ ] Behavior matches the cited spec sections exactly (note section numbers in the PR description).
- [ ] Tests above exist, run in CI and pass; new edge cases discovered are added to `docs/07-edge-cases-tests.md`.
- [ ] Loading/empty/partial/stale/error states implemented for any UI work.
- [ ] No secrets or personal data in code, logs or fixtures; deny-list check passes.
- [ ] `docs/RUNBOOK.md` updated for any new variable, job or failure mode.
- [ ] Questions or spec conflicts recorded in `docs/OPEN_QUESTIONS.md` instead of guessed.
