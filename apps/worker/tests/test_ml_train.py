"""D07 walk-forward training end to end on synthetic data: ML-04 (universe), ML-09 (abort),
ML-10 (quantile order), ML-11 (determinism), the noise-never-passes acceptance criterion and a
positive control showing the pipeline can find a planted signal (docs/05 10.4, 10.5, 10.8)."""

from __future__ import annotations

import numpy as np
import pytest
from mlgen import make_panel_inputs

from worker.ml import features as ft
from worker.ml.features import MarketInput, build_panel
from worker.ml.guardrail import GuardrailParams
from worker.ml.models import ScoringModel, TrainParams
from worker.ml.train import MIN_UNIVERSE, TrainingAborted, TrainOutput, train_all

TP = TrainParams(
    num_rounds=30,
    early_stopping_rounds=8,
    min_data_in_leaf=40,
    init_months=18,
    fold_months=3,
    inner_dates=21,
)
GP = GuardrailParams(bootstrap_resamples=200)
H = (5,)


H2 = (5, 21)


def run(
    seed: int,
    phi: float,
    n_stocks: int = 20,
    n_days: int = 1400,
    horizons: tuple[int, ...] = H,
) -> TrainOutput:
    stocks, market = make_panel_inputs(n_stocks=n_stocks, n_days=n_days, seed=seed, phi=phi)
    return train_all(build_panel(stocks, market), tp=TP, gp=GP, horizons=horizons)


@pytest.fixture(scope="module")
def noise() -> TrainOutput:
    return run(seed=1, phi=0.0, horizons=H2)


@pytest.fixture(scope="module")
def signal() -> TrainOutput:
    return run(seed=2, phi=0.5)


# ML-04
def test_ml04_fewer_than_20_eligible_stocks_is_insufficient_universe() -> None:
    assert MIN_UNIVERSE == 20
    out = run(seed=3, phi=0.0, n_stocks=19, n_days=400)
    assert out.status == "insufficient_universe"
    assert out.horizons == []  # no model, no run: forecasts stay hidden
    assert out.meta["universe"] == 19


def test_twenty_stocks_with_too_little_history_is_insufficient_history() -> None:
    out = run(seed=3, phi=0.0, n_stocks=20, n_days=500)
    assert out.status == "insufficient_history"
    h = out.horizons[0]
    assert h.model is None and not h.guardrail.passed
    assert h.guardrail.reason == "insufficient_folds"


# Acceptance (ML-14): random noise never passes the guardrail, on both horizons
@pytest.mark.parametrize("idx", [0, 1], ids=["5d", "21d"])
def test_noise_data_trains_but_never_passes_the_guardrail(noise: TrainOutput, idx: int) -> None:
    assert noise.status == "ok"
    ht = noise.horizons[idx]
    assert ht.horizon == H2[idx]
    assert ht.model is not None
    assert len(ht.fold_metrics) >= 12
    assert not ht.guardrail.passed
    auc = ht.guardrail.summary["auc_mean"]
    assert auc is not None and abs(auc - 0.5) < 0.04
    # the check that caught it is the discrimination check, not a side effect elsewhere
    by = {c.name: c for c in ht.guardrail.checks}
    assert ht.guardrail.reason == "auc_mean" and not by["auc_mean"].ok
    assert by["band_coverage"].ok  # the conformal band itself is fine on noise


@pytest.mark.parametrize("seed", [11, 12])
@pytest.mark.parametrize("h", [5, 21])
def test_more_noise_seeds_never_pass(seed: int, h: int) -> None:
    ht = run(seed=seed, phi=0.0, horizons=(h,)).horizons[0]
    assert not ht.guardrail.passed and ht.guardrail.reason == "auc_mean"


def test_planted_signal_is_found_and_calibrated(signal: TrainOutput) -> None:
    ht = signal.horizons[0]
    s = ht.guardrail.summary
    assert s["auc_mean"] is not None and s["auc_mean"] > 0.53
    assert s["auc_mean"] > (s["b2_auc_mean"] or 0) - 0.02
    assert s["brier_mean"] < s["baseline_brier_b1_mean"]  # beats the constant base rate
    assert ht.fold_metrics[0]["calibrated"] is False  # first fold has no earlier OOF
    assert all(m["calibrated"] for m in ht.fold_metrics[1:])
    cov = [m["band_coverage"] for m in ht.fold_metrics[-8:]]
    assert 0.7 < float(np.mean(cov)) < 0.9  # conformal calibration keeps the band near 80%


# ML-10 end to end and artifact round trip
def test_ml10_model_quantiles_are_monotone_and_artifacts_round_trip(signal: TrainOutput) -> None:
    model = signal.horizons[0].model
    assert model is not None
    stocks, market = make_panel_inputs(n_stocks=20, n_days=1400, seed=2, phi=0.5)
    panel = build_panel(stocks, market)
    x = panel.X[-500:]
    z = model.z_band(x)
    assert (z[:, 0] <= z[:, 1]).all() and (z[:, 1] <= z[:, 2]).all()
    p = model.p_up(x)
    assert ((p >= 0) & (p <= 1)).all()
    loaded = ScoringModel.load(model.dir_artifact(), model.range_artifact())
    assert np.array_equal(loaded.p_up(x), p)
    assert np.array_equal(loaded.z_band(x), z)
    assert loaded.names == panel.names and loaded.horizon == 5


# ML-11
def test_ml11_same_data_and_seed_give_identical_results(noise: TrainOutput) -> None:
    again = run(seed=1, phi=0.0)
    a, b = noise.horizons[0], again.horizons[0]
    assert a.fold_metrics == b.fold_metrics
    assert a.guardrail.to_json() == b.guardrail.to_json()
    assert a.model is not None and b.model is not None
    assert a.model.dir_artifact() == b.model.dir_artifact()
    assert a.model.range_artifact() == b.model.range_artifact()
    assert noise.meta["feature_hash"] == again.meta["feature_hash"]


# ML-22 (ML-03 for the calibration set): isotonic and conformal fits never see a label that is
# not yet known at the start of the fold they calibrate
def test_ml22_calibration_rows_are_purged_like_training_rows(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from worker.ml import train as tr
    from worker.ml.walkforward import make_folds, valid_mask

    stocks, market = make_panel_inputs(n_stocks=20, n_days=1400, seed=4, phi=0.3)
    panel = build_panel(stocks, market)
    calls: list[int] = []
    real_fit = tr.fit_isotonic

    def spy(p: np.ndarray, y: np.ndarray) -> object:  # type: ignore[type-arg]
        calls.append(len(p))
        return real_fit(p, y)

    monkeypatch.setattr(tr, "fit_isotonic", spy)
    out = train_all(panel, tp=TP, gp=GP, horizons=(5,))
    assert out.horizons[0].model is not None
    h = 5
    lab = panel.labeled(h)
    folds = make_folds(panel.calendar, init_months=TP.init_months, fold_months=TP.fold_months)
    sizes = []  # the unpurged OOF rows of all earlier folds, and the purged ones
    naive: list[int] = []
    purged: list[int] = []
    prev_end: list[np.ndarray] = []  # type: ignore[type-arg]
    for fold in folds:
        vm = valid_mask(lab, panel.date_idx, fold)
        if prev_end:
            ends = np.concatenate(prev_end)
            naive.append(len(ends))
            purged.append(int((ends < fold.start).sum()))
            assert purged[-1] < naive[-1]  # the purge removes the tail of the previous fold
            # exactly h trading days per stock of the previous fold's tail reach this fold
            assert naive[-1] - purged[-1] >= h * len(stocks)
        prev_end.append(panel.label_end[h][vm])
        sizes.append(int(vm.sum()))
    assert calls[:-1] == purged  # per-fold calibration used only the purged rows
    assert calls[-1] == sum(sizes)  # the final model's calibrator sees every out-of-fold row


def test_calibrated_probabilities_are_never_exactly_zero_or_one() -> None:
    from worker.ml.calibration import P_EPS, Isotonic, clip_prob

    iso = Isotonic(np.array([0.2, 0.5, 0.8]), np.array([0.0, 0.5, 1.0]))  # PAV can output 0 and 1
    raw = iso.predict(np.array([0.0, 0.2, 0.5, 0.8, 0.99]))
    assert raw[1] == 0.0 and raw[3] == 1.0
    p = clip_prob(raw)
    assert p.min() == P_EPS and p.max() == 1.0 - P_EPS and (p > 0).all() and (p < 1).all()


def test_meta_records_reproducibility_inputs(noise: TrainOutput) -> None:
    m = noise.meta
    assert m["seed"] == 42 and m["params"]["num_leaves"] == 15 and m["params"]["init_months"] == 18
    assert set(m["versions"]) == {"lightgbm", "numpy", "python"}
    assert m["features"] == build_panel(*make_panel_inputs(n_stocks=3, n_days=400)).names
    assert m["feature_hash"] == ft.feature_hash(m["features"])
    assert m["universe"] == 20


def test_default_parameters_match_the_spec() -> None:
    d = TrainParams()
    assert (d.num_leaves, d.min_data_in_leaf, d.feature_fraction) == (15, 500, 0.8)
    assert (d.bagging_fraction, d.bagging_freq, d.learning_rate) == (0.8, 1, 0.03)
    assert (d.lambda_l2, d.num_rounds, d.init_months, d.fold_months) == (10.0, 300, 36, 3)
    g = GuardrailParams()
    assert (g.eval_folds, g.min_folds, g.min_mean_auc, g.auc_lower_bound) == (8, 12, 0.53, 0.50)
    assert (g.brier_margin, g.brier_folds_needed, g.max_ece) == (0.0005, 6, 0.03)
    assert (g.coverage_lo, g.coverage_hi, g.b2_auc_tolerance) == (0.76, 0.84, 0.005)
    assert g.bootstrap_resamples == 2000


# ML-09
def test_ml09_timeout_aborts_cleanly_without_a_partial_model() -> None:
    stocks, market = make_panel_inputs(n_stocks=20, n_days=1400, seed=1)
    panel = build_panel(stocks, market)
    with pytest.raises(TrainingAborted):
        train_all(panel, tp=TP, gp=GP, horizons=H, should_stop=lambda: True)

    calls = {"n": 0}

    def stop_after_some() -> bool:
        calls["n"] += 1
        return calls["n"] > 12  # mid-way through the folds

    with pytest.raises(TrainingAborted):
        train_all(panel, tp=TP, gp=GP, horizons=H, should_stop=stop_after_some)
    assert calls["n"] > 12  # it was consulted repeatedly, not once at the start


def test_no_market_series_still_trains_without_those_features() -> None:
    stocks, _ = make_panel_inputs(n_stocks=20, n_days=1400, seed=5)
    out = train_all(build_panel(stocks, MarketInput()), tp=TP, gp=GP, horizons=H)
    assert out.status == "ok"
    assert "beta_252" not in out.meta["features"] and "vix_level" not in out.meta["features"]
