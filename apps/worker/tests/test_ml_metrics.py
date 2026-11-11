"""D07 metrics, baselines, isotonic and conformal calibration, quantile ordering (ML-10)
against hand-computed values (docs/05 10.4, 10.5)."""

from __future__ import annotations

import math

import numpy as np
import pytest

from worker.ml import baselines as bl
from worker.ml import metrics as mt
from worker.ml.calibration import (
    apply_band,
    conformal_adjustment,
    fit_isotonic,
    order_quantiles,
)


def test_auc_hand_values_and_ties() -> None:
    y = np.array([0.0, 0.0, 1.0, 1.0])
    assert mt.auc(y, np.array([0.1, 0.4, 0.35, 0.8])) == pytest.approx(0.75)
    assert mt.auc(y, np.array([0.5, 0.5, 0.5, 0.5])) == pytest.approx(0.5)
    assert mt.auc(y, np.array([0.1, 0.2, 0.3, 0.4])) == pytest.approx(1.0)
    assert mt.auc(y, np.array([0.4, 0.3, 0.2, 0.1])) == pytest.approx(0.0)
    assert math.isnan(mt.auc(np.ones(3), np.array([0.1, 0.2, 0.3])))  # one class: unknown


def test_brier_logloss_accuracy_hand_values() -> None:
    y = np.array([1.0, 0.0, 1.0, 0.0])
    p = np.array([0.8, 0.3, 0.4, 0.1])
    assert mt.brier(y, p) == pytest.approx((0.04 + 0.09 + 0.36 + 0.01) / 4)
    ll = -(math.log(0.8) + math.log(0.7) + math.log(0.4) + math.log(0.9)) / 4
    assert mt.log_loss(y, p) == pytest.approx(ll)
    assert mt.accuracy(y, p) == pytest.approx(0.75)
    assert math.isfinite(mt.log_loss(np.array([1.0]), np.array([0.0])))  # clipped, never inf


def test_ece_hand_value_and_perfect_calibration() -> None:
    y = np.array([1.0, 1.0, 0.0, 0.0])
    p = np.array([0.95, 0.95, 0.05, 0.05])  # bins 9 and 0
    assert mt.ece(y, p) == pytest.approx(0.5 * 0.05 + 0.5 * 0.05)
    # bin [0.1, 0.2): p mean 0.15, observed 0.5 -> |0.5 - 0.15| weighted 1.0
    assert mt.ece(np.array([1.0, 0.0]), np.array([0.15, 0.15])) == pytest.approx(0.35)
    rng = np.random.default_rng(0)
    q = rng.uniform(0, 1, 200_000)
    assert mt.ece((rng.uniform(0, 1, q.size) < q).astype(float), q) < 0.01


def test_coverage() -> None:
    r = np.array([-1.0, 0.0, 1.0, 2.0])
    assert mt.coverage(r, np.full(4, -0.5), np.full(4, 1.0)) == pytest.approx(0.5)


def test_block_bootstrap_is_seeded_and_bounds_the_mean() -> None:
    vals = np.array([0.52, 0.55, 0.49, 0.58, 0.51, 0.54, 0.50, 0.53])
    a = mt.block_bootstrap_lower(vals, resamples=500, seed=1)
    assert a == mt.block_bootstrap_lower(vals, resamples=500, seed=1)
    assert a < float(vals.mean())
    assert math.isnan(mt.block_bootstrap_lower(np.array([0.6]), seed=1))
    assert mt.block_bootstrap_lower(np.full(6, 0.6), resamples=200, seed=2) == pytest.approx(0.6)


def test_monthly_auc_skips_single_class_months() -> None:
    y = np.array([0.0, 1.0, 0.0, 1.0, 1.0, 1.0])
    p = np.array([0.1, 0.9, 0.8, 0.2, 0.3, 0.4])
    month = np.array([1, 1, 2, 2, 3, 3])
    out = mt.monthly_auc(y, p, month)
    assert out.tolist() == [1.0, 0.0]  # month 3 has one class only


def test_isotonic_pav_hand_example() -> None:
    p = np.array([0.1, 0.2, 0.3, 0.4, 0.5])
    y = np.array([0.0, 1.0, 0.0, 1.0, 1.0])
    iso = fit_isotonic(p, y)
    out = iso.predict(p)
    assert np.allclose(out, [0.0, 0.5, 0.5, 1.0, 1.0])
    assert (np.diff(iso.predict(np.linspace(0, 1, 50))) >= 0).all()
    assert iso.predict(np.array([0.0, 1.0])).tolist() == [0.0, 1.0]  # clipped outside the fit
    again = type(iso).from_json(iso.to_json())
    assert np.array_equal(again.predict(p), out)


def test_isotonic_pools_equal_inputs_and_needs_both_classes() -> None:
    iso = fit_isotonic(np.array([0.5, 0.5, 0.5, 0.5]), np.array([1.0, 0.0, 0.0, 0.0]))
    assert iso.predict(np.array([0.5]))[0] == pytest.approx(0.25)
    ident = fit_isotonic(np.array([0.2, 0.4]), np.array([1.0, 1.0]))
    assert ident.predict(np.array([0.3])).tolist() == [0.3]


def test_conformal_hits_the_target_coverage_on_calibration_and_fresh_data() -> None:
    rng = np.random.default_rng(3)
    z = rng.normal(size=20_000)
    q10, q90 = np.full(z.size, -0.3), np.full(z.size, 0.3)  # a deliberately too-narrow band
    adj = conformal_adjustment(q10[:10_000], q90[:10_000], z[:10_000])
    assert adj > 0.8
    fresh = z[10_000:]
    cov = float(np.mean((fresh >= -0.3 - adj) & (fresh <= 0.3 + adj)))
    assert cov == pytest.approx(0.8, abs=0.015)
    # a too-wide band is narrowed (negative adjustment)
    assert conformal_adjustment(np.full(z.size, -5.0), np.full(z.size, 5.0), z) < 0
    assert conformal_adjustment(np.zeros(0), np.zeros(0), np.zeros(0)) == 0.0


def test_conformal_small_sample_covers_at_least_the_target() -> None:
    z = np.arange(1.0, 11.0)  # n = 10: level = ceil(11 * 0.8) / 10 = 0.9
    adj = conformal_adjustment(np.zeros(10), np.zeros(10), z)
    covered = np.mean((z >= -adj) & (z <= adj))
    assert covered >= 0.8


# ML-10
def test_ml10_quantile_crossing_is_sorted_monotonic() -> None:
    q = np.array([[0.5, -0.2, 0.9], [0.1, 0.3, 0.2], [1.0, 0.0, -1.0], [0.0, 0.0, 0.0]])
    s = order_quantiles(q)
    assert (s[:, 0] <= s[:, 1]).all() and (s[:, 1] <= s[:, 2]).all()
    assert s[0].tolist() == [-0.2, 0.5, 0.9]
    for adj in (-5.0, -0.1, 0.0, 0.3):  # even a narrowing adjustment cannot cross the median
        b = apply_band(q, adj)
        assert (b[:, 0] <= b[:, 1]).all() and (b[:, 1] <= b[:, 2]).all()
    assert np.array_equal(order_quantiles(q), np.sort(q, axis=1))


def test_baselines() -> None:
    y = np.array([1.0, 0.0, 0.0, 1.0, 1.0])
    assert bl.b1_base_rate(y, 3).tolist() == [0.6, 0.6, 0.6]
    assert bl.b3_momentum(np.array([0.01, -0.01, 0.0])).tolist() == [0.55, 0.45, 0.45]
    lo, hi = bl.empirical_band(np.linspace(-1, 1, 101))
    assert lo == pytest.approx(-0.8) and hi == pytest.approx(0.8)


def test_b2_logistic_fits_the_base_rate_and_a_planted_signal() -> None:
    rng = np.random.default_rng(1)
    x = rng.normal(size=(20_000, 2))
    y = (rng.uniform(size=20_000) < 1 / (1 + np.exp(-(0.4 + 1.5 * x[:, 0])))).astype(float)
    m = bl.Logistic(x, y)
    p = m.predict(x)
    assert float(p.mean()) == pytest.approx(float(y.mean()), abs=1e-6)  # intercept is unpenalised
    assert mt.auc(y, p) > 0.75
    flat = bl.Logistic(np.zeros((50, 2)), np.r_[np.ones(10), np.zeros(40)]).predict(
        np.zeros((2, 2))
    )
    assert flat == pytest.approx([0.2, 0.2], abs=1e-3)  # constant features -> base rate
