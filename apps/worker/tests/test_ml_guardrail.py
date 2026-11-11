"""D07 guardrail (docs/05 10.5) and live gate (ML-07). The key acceptance test: random-noise
predictions never pass."""

from __future__ import annotations

from datetime import date, timedelta

import numpy as np
import pytest

from worker.ml.guardrail import (
    LIVE_MIN_DATES,
    FoldEval,
    GuardrailParams,
    LiveRecord,
    evaluate_guardrail,
    live_gate,
)

N_FOLDS = 13
ROWS = 1500
FAST = GuardrailParams(bootstrap_resamples=300)


def make_fold(
    index: int,
    rng: np.random.Generator,
    *,
    signal: bool,
    shift: float = 0.0,
    jitter: float = 0.0,
    cover: float = 0.8,
    b1_oracle: bool = False,
    b2_oracle: bool = False,
) -> FoldEval:
    q = rng.uniform(0.3, 0.7, ROWS)
    if signal:
        y = (rng.uniform(size=ROWS) < q).astype(float)
        p = q + shift + (rng.normal(0, jitter, ROWS) if jitter else 0.0)
    else:  # pure noise: predictions independent of the outcome
        y = (rng.uniform(size=ROWS) < 0.5).astype(float)
        p = q
    p = np.clip(p, 0.01, 0.99)
    base = float(y.mean())
    return FoldEval(
        index=index,
        y=y,
        p=p,
        p_b1=q.copy() if b1_oracle else np.full(ROWS, base),
        p_b2=q.copy() if b2_oracle else np.full(ROWS, base) + rng.normal(0, 1e-3, ROWS),
        p_b3=np.where(rng.uniform(size=ROWS) < 0.5, 0.55, 0.45),
        in_band=rng.uniform(size=ROWS) < cover,
        in_band_baseline=rng.uniform(size=ROWS) < 0.8,
        month=(index * 3 + np.arange(ROWS) % 3).astype(np.int64),
    )


def folds(seed: int, n: int = N_FOLDS, **kw: object) -> list[FoldEval]:
    rng = np.random.default_rng(seed)
    return [make_fold(i, rng, **kw) for i in range(n)]  # type: ignore[arg-type]


def test_random_noise_never_passes_the_guardrail() -> None:
    passes = 0
    for seed in range(150):
        res = evaluate_guardrail(folds(seed, signal=False), FAST)
        passes += int(res.passed)
        assert res.reason is not None or res.passed
    assert passes == 0


def test_a_calibrated_signal_with_a_good_band_passes_all_checks() -> None:
    res = evaluate_guardrail(folds(1, signal=True), FAST)
    assert res.passed and res.reason is None
    assert {c.name for c in res.checks} == {
        "auc_mean",
        "auc_bootstrap_lower",
        "brier_vs_b1",
        "ece_pooled",
        "band_coverage",
        "auc_vs_b2",
    }
    assert all(c.ok for c in res.checks)


@pytest.mark.parametrize(
    ("kw", "failed"),
    [
        ({"signal": False}, "auc_mean"),
        ({"signal": True, "b1_oracle": True}, "brier_vs_b1"),
        ({"signal": True, "shift": 0.06}, "ece_pooled"),
        ({"signal": True, "cover": 0.70}, "band_coverage"),
        ({"signal": True, "cover": 0.90}, "band_coverage"),
        ({"signal": True, "jitter": 0.12, "b2_oracle": True}, "auc_vs_b2"),
    ],
)
def test_each_condition_alone_blocks_the_guardrail(kw: dict[str, object], failed: str) -> None:
    res = evaluate_guardrail(folds(5, **kw), FAST)
    assert not res.passed
    assert failed in [c.name for c in res.checks if not c.ok]


def make_near_half_fold(index: int, rng: np.random.Generator, half_width: float) -> FoldEval:
    """A *calibrated* model whose probabilities hug 0.5 (``0.5 +/- half_width``) and whose outcomes
    follow them (so predictions and outcomes are weakly correlated: AUC about
    ``0.5 + 2 * half_width / 3``). Calibration, coverage and the B2 baseline look fine, so only the
    AUC checks (and the Brier margin) can stop it."""
    p = 0.5 + rng.uniform(-half_width, half_width, ROWS)
    y = (rng.uniform(size=ROWS) < p).astype(float)
    base = float(y.mean())
    return FoldEval(
        index=index,
        y=y,
        p=p,
        p_b1=np.full(ROWS, base),
        p_b2=np.full(ROWS, base) + rng.normal(0, 1e-3, ROWS),
        p_b3=np.where(rng.uniform(size=ROWS) < 0.5, 0.55, 0.45),
        in_band=rng.uniform(size=ROWS) < 0.8,
        in_band_baseline=rng.uniform(size=ROWS) < 0.8,
        month=(index * 3 + np.arange(ROWS) % 3).astype(np.int64),
    )


def test_calibrated_near_half_model_with_weak_correlation_never_passes() -> None:
    """The AUC checks are actually exercised: calibration, coverage and B2 pass, the mean AUC
    (about 0.52) is below 0.53 and that check is what blocks it."""
    caught = 0
    aucs: list[float] = []
    for seed in range(60):
        rng = np.random.default_rng(1000 + seed)
        res = evaluate_guardrail([make_near_half_fold(i, rng, 0.02) for i in range(N_FOLDS)], FAST)
        by = {c.name: c for c in res.checks}
        assert not res.passed
        assert by["ece_pooled"].ok and by["band_coverage"].ok and by["auc_vs_b2"].ok
        assert by["auc_bootstrap_lower"].value is not None  # the bootstrap ran and was finite
        assert by["auc_mean"].value is not None
        aucs.append(by["auc_mean"].value)
        caught += int(not by["auc_mean"].ok or not by["auc_bootstrap_lower"].ok)
    assert 0.50 < float(np.mean(aucs)) < 0.53  # weakly but positively correlated on average
    assert caught == 60  # the AUC checks (not luck elsewhere) block every one of them


def make_uneven_fold(index: int, rng: np.random.Generator) -> FoldEval:
    """One large informative calibrated month plus two tiny months (8 rows each) per fold in which
    ``p`` points the wrong way. The fold AUC (pooled, dominated by the large month) is about
    0.63, calibration is unaffected (16 of 1500 rows), but the unweighted per-month AUCs are
    noisy and average below 0.5, so the bootstrap lower bound is far below 0.50."""
    big, tiny = ROWS - 16, 8
    q = rng.uniform(0.3, 0.7, ROWS)
    y = np.empty(ROWS)
    y[:big] = rng.uniform(size=big) < q[:big]  # calibrated and informative
    y[big:] = rng.uniform(size=16) < (1.0 - q[big:])  # tiny months: p points the wrong way
    month = np.concatenate(
        [np.full(big, index * 3), np.full(tiny, index * 3 + 1), np.full(tiny, index * 3 + 2)]
    ).astype(np.int64)
    base = float(y.mean())
    return FoldEval(
        index=index,
        y=y,
        p=q,
        p_b1=np.full(ROWS, base),
        p_b2=np.full(ROWS, base) + rng.normal(0, 1e-3, ROWS),
        p_b3=np.where(rng.uniform(size=ROWS) < 0.5, 0.55, 0.45),
        in_band=rng.uniform(size=ROWS) < 0.8,
        in_band_baseline=rng.uniform(size=ROWS) < 0.8,
        month=month,
    )


def test_bootstrap_lower_bound_alone_blocks_a_good_mean_auc() -> None:
    rng = np.random.default_rng(3)
    res = evaluate_guardrail([make_uneven_fold(i, rng) for i in range(N_FOLDS)], FAST)
    by = {c.name: c for c in res.checks}
    assert by["auc_mean"].ok and by["auc_mean"].value is not None and by["auc_mean"].value > 0.55
    lower = by["auc_bootstrap_lower"].value
    assert lower is not None and lower <= 0.50
    # the bootstrap is the ONLY failing check
    assert [c.name for c in res.checks if not c.ok] == ["auc_bootstrap_lower"]
    assert not res.passed and res.reason == "auc_bootstrap_lower"


def test_fewer_than_12_folds_cannot_pass() -> None:
    res = evaluate_guardrail(folds(2, n=11, signal=True), FAST)
    assert not res.passed and res.reason == "insufficient_folds"


def test_only_the_last_eight_folds_count() -> None:
    rng = np.random.default_rng(4)
    old_bad = [make_fold(i, rng, signal=False) for i in range(5)]
    recent_good = [make_fold(5 + i, rng, signal=True) for i in range(8)]
    assert evaluate_guardrail([*old_bad, *recent_good], FAST).passed
    recent_bad = [make_fold(5 + i, rng, signal=False) for i in range(8)]
    good_old = [make_fold(i, rng, signal=True) for i in range(5)]
    assert not evaluate_guardrail([*good_old, *recent_bad], FAST).passed


def test_guardrail_is_deterministic() -> None:
    a = evaluate_guardrail(folds(8, signal=True), FAST).to_json()
    b = evaluate_guardrail(folds(8, signal=True), FAST).to_json()
    assert a == b


# ML-07 (pure part; the DB part is in test_ml_db)
def rec(p: float, realized: float, in_band: bool) -> LiveRecord:
    return LiveRecord(p, realized, in_band)


D0 = date(2024, 1, 1)


def good_records(n: int, *, dates: int | None = None) -> list[LiveRecord]:
    """``n`` resolved predictions with live AUC 1 and coverage 0.8 spread over ``dates`` days."""
    out = []
    for i in range(n):
        up = i % 2 == 0
        day = D0 + timedelta(days=i % (dates or n))
        out.append(LiveRecord(0.6 if up else 0.4, 0.01 if up else -0.01, i % 5 != 0, day))
    return out


def test_ml07_live_gate_needs_100_resolved_predictions() -> None:
    bad = [rec(0.6, -0.01, False) for _ in range(99)]  # worst possible, but only 99
    g = live_gate(bad)
    assert not g.tripped and g.resolved == 99
    assert not live_gate(good_records(100)).tripped
    assert live_gate([]).resolved == 0


def test_ml07_live_auc_below_half_trips() -> None:
    recs = [
        rec(0.6 if i % 2 == 0 else 0.4, -0.01 if i % 2 == 0 else 0.01, i % 5 != 0)
        for i in range(100)
    ]
    g = live_gate(recs)
    assert g.tripped and g.reason == "live_auc" and g.live_auc == pytest.approx(0.0)


@pytest.mark.parametrize(("hits", "tripped"), [(69, True), (70, False), (90, False), (91, True)])
def test_ml07_live_coverage_outside_70_90_trips(hits: int, tripped: bool) -> None:
    recs = [
        rec(0.6 if i % 2 == 0 else 0.4, 0.01 if i % 2 == 0 else -0.01, i < hits) for i in range(100)
    ]
    g = live_gate(recs)
    assert g.tripped is tripped
    if tripped:
        assert g.reason == "live_coverage"


# D07-17: 100 resolved rows are not enough when they come from a handful of dates
def test_ml07_live_gate_needs_20_distinct_dates_too() -> None:
    bad = [
        LiveRecord(0.6, -0.01 if i % 2 else 0.01, False, D0 + timedelta(days=i % 5))
        for i in range(200)
    ]  # 200 rows, coverage 0, AUC 0.5 -> would trip with enough dates
    g = live_gate(bad)
    assert not g.tripped and g.insufficient and g.distinct_dates == 5 and g.resolved == 200
    assert LIVE_MIN_DATES == 20
    spread = [
        LiveRecord(0.6, 0.01 if i % 2 else -0.01, False, D0 + timedelta(days=i % 20))
        for i in range(100)
    ]
    assert live_gate(spread).tripped  # 20 distinct dates: the same bad record now trips
    nineteen = [
        LiveRecord(0.6, 0.01 if i % 2 else -0.01, False, D0 + timedelta(days=i % 19))
        for i in range(100)
    ]
    assert not live_gate(nineteen).tripped
    assert not live_gate(good_records(100, dates=20)).tripped


def test_ml07_live_gate_with_one_class_is_insufficient_not_a_pass() -> None:
    one_class = [LiveRecord(0.6, 0.01, False, D0 + timedelta(days=i)) for i in range(120)]
    g = live_gate(one_class)  # AUC undefined (all rows are "up"), coverage 0 is out of range
    assert g.live_auc is None and g.insufficient and not g.tripped
    # a recovery window must not complete on such evidence
    assert live_gate(one_class, min_resolved=100).insufficient
