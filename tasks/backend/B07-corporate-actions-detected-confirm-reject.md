# B07 - Corporate actions: detected confirm/reject

| Field | Value |
|---|---|
| Track | backend |
| Depends on | B06 |
| Size | S (S < 0.5 day, M 0.5-1.5 days, L 1.5-4 days of focused work) |

## Read first
- docs/03-api-spec.md section 14 (PATCH actions)
- docs/01-data-sources.md section 3.7
- docs/05-analytics-spec.md section 8.2
- docs/07-edge-cases-tests.md ACT-*
- `CLAUDE.md` (rules), `docs/00-legal-and-safety.md` (Safe Edition guards)

## Goal
Let the owner confirm or reject detected split/bonus candidates and trigger history re-adjustment.

## In scope
- PATCH action status (`confirmed`/`rejected`) with owner-selected type and final numbers; validate multiplier vs detected fraction (warn beyond 3%)
- Enqueue a re-adjust job (worker) and analytics recompute
- Manual create/edit/delete of actions with validators

## Out of scope (do not do in this task)
- The detector itself (worker D03)

## Deliverables
- handlers, tests

## Steps
1. Implement state transitions (detected -> confirmed/rejected; rejected is sticky for that ex-date)
2. Enqueue worker job through `refresh_job` kind reuse or a dedicated queue column

## Acceptance criteria (all must be true)
- [ ] ACT-03, ACT-04, ACT-06, ACT-09, ACT-10 pass
- [ ] Confirming sets the multiplier used by portfolio math

## Required tests (from `docs/07-edge-cases-tests.md`)
- `ACT-03` (see `docs/07-edge-cases-tests.md`)
- `ACT-04` (see `docs/07-edge-cases-tests.md`)
- `ACT-06` (see `docs/07-edge-cases-tests.md`)
- `ACT-09` (see `docs/07-edge-cases-tests.md`)
- `ACT-10` (see `docs/07-edge-cases-tests.md`)

## Definition of done
- [ ] Behavior matches the cited spec sections exactly (note section numbers in the PR description).
- [ ] Tests above exist, run in CI and pass; new edge cases discovered are added to `docs/07-edge-cases-tests.md`.
- [ ] Loading/empty/partial/stale/error states implemented for any UI work.
- [ ] No secrets or personal data in code, logs or fixtures; deny-list check passes.
- [ ] `docs/RUNBOOK.md` updated for any new variable, job or failure mode.
- [ ] Questions or spec conflicts recorded in `docs/OPEN_QUESTIONS.md` instead of guessed.
