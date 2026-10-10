# D07 - Experimental ML pipeline

| Field | Value |
|---|---|
| Track | data |
| Depends on | D05 |
| Size | L (S < 0.5 day, M 0.5-1.5 days, L 1.5-4 days of focused work) |

## Read first
- docs/05-analytics-spec.md section 10
- docs/04-worker-jobs.md 3.8
- docs/07-edge-cases-tests.md ML-*
- `CLAUDE.md` (rules), `docs/00-legal-and-safety.md` (Safe Edition guards)

## Goal
Train, validate, guard and serve the experimental forecasts with a live track record.

## In scope
- Feature builder with leakage guards and market features only if available
- Walk-forward training with embargo, LightGBM classifiers/quantile models, conformal band calibration, baselines B1-B3
- Metrics, block bootstrap, guardrail evaluation, `model_run` records, activation rule
- `predict` job with per-stock display rules and outcome resolution
- Skip with `insufficient_universe` when fewer than 20 eligible stocks

## Out of scope (do not do in this task)
- Any UI

## Deliverables
- `apps/worker/ml/*`, jobs `train_models`, `predict`, tests

## Steps
1. Implement dataset builder and write the no-lookahead test first
2. Implement validation loop and metrics
3. Implement guardrails and live gate
4. Create synthetic-data tests that prove a random model fails the guardrail

## Acceptance criteria (all must be true)
- [ ] ML-01, ML-02, ML-03, ML-04, ML-08, ML-09, ML-10, ML-11 pass
- [ ] Random-noise synthetic data never passes the guardrail

## Required tests (from `docs/07-edge-cases-tests.md`)
- `ML-01` (see `docs/07-edge-cases-tests.md`)
- `ML-02` (see `docs/07-edge-cases-tests.md`)
- `ML-03` (see `docs/07-edge-cases-tests.md`)
- `ML-04` (see `docs/07-edge-cases-tests.md`)
- `ML-06` (see `docs/07-edge-cases-tests.md`)
- `ML-07` (see `docs/07-edge-cases-tests.md`)
- `ML-08` (see `docs/07-edge-cases-tests.md`)
- `ML-09` (see `docs/07-edge-cases-tests.md`)
- `ML-10` (see `docs/07-edge-cases-tests.md`)
- `ML-11` (see `docs/07-edge-cases-tests.md`)

## Definition of done
- [ ] Behavior matches the cited spec sections exactly (note section numbers in the PR description).
- [ ] Tests above exist, run in CI and pass; new edge cases discovered are added to `docs/07-edge-cases-tests.md`.
- [ ] Loading/empty/partial/stale/error states implemented for any UI work.
- [ ] No secrets or personal data in code, logs or fixtures; deny-list check passes.
- [ ] `docs/RUNBOOK.md` updated for any new variable, job or failure mode.
- [ ] Questions or spec conflicts recorded in `docs/OPEN_QUESTIONS.md` instead of guessed.
