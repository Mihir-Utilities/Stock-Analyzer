# T02 - Database migrations and seed

| Field | Value |
|---|---|
| Track | foundation |
| Depends on | T00 |
| Size | M (S < 0.5 day, M 0.5-1.5 days, L 1.5-4 days of focused work) |

## Read first
- docs/02-database.sql
- docs/07-edge-cases-tests.md (API-05, SYS-07)
- `CLAUDE.md` (rules), `docs/00-legal-and-safety.md` (Safe Edition guards)

## Goal
Turn the DDL into ordered forward-only goose migrations with a seed command and typed query generation.

## In scope
- Split `02-database.sql` into ordered migrations (extensions/settings, reference, market data, owner data, MF, user features, ops, import/broker tables, FKs)
- Seed command (`apps/api cmd/seed`): create the single `app_user` from `INITIAL_PASSWORD_HASH`, default `app_setting` rows (constants from MASTER_PLAN section 5), empty config files check
- sqlc configuration and the first query packages
- Migration test: apply all migrations to a clean Postgres and verify every constraint and index exists

## Out of scope (do not do in this task)
- API handlers
- Data loading

## Deliverables
- `db/migrations/*.sql`
- `apps/api/cmd/seed`
- `apps/api/queries/*.sql` (initial)
- `sqlc.yaml`

## Steps
1. Create migrations in dependency order; never edit applied ones
2. Implement seed with argon2id hashing helper
3. Write migration CI job using testcontainers
4. Add a test that inserts invalid rows to prove CHECK constraints work (one per table family)

## Acceptance criteria (all must be true)
- [ ] `goose up` then `goose down`/`up` works on a clean DB
- [ ] All tables from the DDL exist; constraints reject bad data
- [ ] Seed creates exactly one user and default settings
- [ ] `pg_trgm` extension is created (or task fails with clear message)

## Required tests (from `docs/07-edge-cases-tests.md`)
- `API-05` (see `docs/07-edge-cases-tests.md`)
- `SYS-07` (see `docs/07-edge-cases-tests.md`)

## Definition of done
- [ ] Behavior matches the cited spec sections exactly (note section numbers in the PR description).
- [ ] Tests above exist, run in CI and pass; new edge cases discovered are added to `docs/07-edge-cases-tests.md`.
- [ ] Loading/empty/partial/stale/error states implemented for any UI work.
- [ ] No secrets or personal data in code, logs or fixtures; deny-list check passes.
- [ ] `docs/RUNBOOK.md` updated for any new variable, job or failure mode.
- [ ] Questions or spec conflicts recorded in `docs/OPEN_QUESTIONS.md` instead of guessed.
