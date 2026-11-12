# B20 - Decision journal: migration 0015, CRUD API and backup

| Field | Value |
|---|---|
| Track | backend (Go API `apps/api`, worker backup `apps/worker`) |
| Depends on | B03 (instrument resolution), B11 (portfolio transactions, idempotency store), D08 (backup), T02 (migrations) |
| Size | M (S < 0.5 day, M 0.5-1.5 days, L 1.5-4 days of focused work) |
| Status | SPEC (plan Item D, `docs/PLAN-investor-additions.md`; questions JRN-1..JRN-6 in `docs/OPEN_QUESTIONS.md`) |

## Read first
- `docs/PLAN-investor-additions.md` sections 0, 1, 2 (Item D), 3, 4 (JRN-1, JRN-2), 5
- `docs/02-database.sql` (migration 0015 block), `docs/03-api-spec.md` sections 1, 12 (idempotency, `note`), **13a**
- `docs/04-worker-jobs.md` 3.11 (backup), `apps/worker/worker/backup.py` (TABLES, guard tests), `docs/07-edge-cases-tests.md` rows `JRN-01..JRN-24`, `JRN-Z01`
- `apps/api/internal/portfolio/txns.go` (idempotency claim pattern), `apps/api/internal/httpx/portfolio_handlers.go`, `routes.go`
- `CLAUDE.md`, `docs/00-legal-and-safety.md`

## Goal
Store, list, edit and delete the owner's dated notes about a stock (reason, price at the time, review date, status, optional transaction link) behind the existing auth, CSRF, validation and envelope rules, and keep them in the encrypted backup.

## In scope
- `db/migrations/0015_decision_journal.sql` (goose up and down) and `docs/02-database.sql` in the same change.
- A `journal` package (service with an injectable `Now`, pgx, no sqlc needed) and `httpx` handlers for `GET /stocks/{symbol}/journal`, `POST /stocks/{symbol}/journal`, `PATCH /journal/{id}`, `DELETE /journal/{id}` exactly as docs/03 13a; routes declared in `routes.go`; `openapi.yaml`, `packages/api-types` and `docs/field-map.json` in the same change.
- Validation: note 1..1000 characters, no control characters other than newline and tab; `review_on` rules; transaction link must belong to the same stock; 500-note cap; `Idempotency-Key` on create.
- Backup: `journal_note` in `TABLES` after `portfolio_txn` (identity, pk `id`), its instruments in `_REFERENCED_INSTRUMENTS`, guard and round-trip tests; the LRU untrack guard in housekeeping treats a stock with notes as owner data.
- `docs/RUNBOOK.md` section 152 (the new migration is applied with the normal goose run before the API is deployed).

## Out of scope
- Any UI (F21); Telegram reminders (JRN-2); an export of notes; sharing; full-text search; attaching files; editing the price at the time.

## Steps
1. Migration and the schema test; 2. service with pure validation and the due rule as failing tests first; 3. handlers and routes, contract tests; 4. integration tests on a throwaway Postgres; 5. backup change and its tests; 6. RUNBOOK.

## Acceptance criteria (all must be true)
- [ ] Rows `JRN-01..JRN-24` and `JRN-Z01` pass; the migration up/down/up test and `TestRoutesMatchOpenAPI` pass.
- [ ] No wall clock in tests: the service takes `Now`; the due rule is a pure function of status, review date and the IST date.
- [ ] Notes are never logged, never in Telegram or alert text, never exported outside the encrypted backup.
- [ ] A backup restore keeps ids and the identity sequence.
- [ ] `go vet`, `golangci-lint run ./...`, gofmt, `go test ./... -count=1`, worker `ruff`, `mypy --strict`, backup and housekeeping tests, deny-list and licence scan pass.

## Required tests
`JRN-01..JRN-24`, `JRN-Z01`, existing backup, housekeeping and migration tests (regression).

## Definition of done
- [ ] Behaviour matches docs/03 13a exactly; contract, OpenAPI, generated types and field-map agree; RUNBOOK section 152 written; open questions recorded.
