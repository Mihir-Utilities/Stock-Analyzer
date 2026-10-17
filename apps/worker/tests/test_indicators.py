"""Known-answer tests for docs/05 section 3 (IND-81 .. IND-91). Expected values are computed by
hand in the comments; the EMA is also cross-checked against pandas (the spec's reference)."""

from __future__ import annotations

import math

import numpy as np
import pandas as pd
import pytest

from worker.analytics import indicators as ind

nan = math.nan


def arr(*v: float) -> np.ndarray:
    return np.array(v, dtype=np.float64)


def same(actual: np.ndarray, expected: list[float], tol: float = 1e-9) -> None:
    assert len(actual) == len(expected)
    for a, e in zip(actual, expected, strict=True):
        if math.isnan(e):
            assert math.isnan(a), (actual, expected)
        else:
            assert a == pytest.approx(e, rel=tol, abs=tol), (actual, expected)


# SMA ----------------------------------------------------------------------------------------
def test_sma_known_answer_and_warmup() -> None:
    same(ind.sma(arr(1, 2, 3, 4, 5), 3), [nan, nan, 2, 3, 4])
    same(ind.sma(arr(1, 2), 3), [nan, nan])


# IND-81 -------------------------------------------------------------------------------------
def test_ind81_ema_hand_values_seeded_with_sma() -> None:
    # n=3, alpha=0.5: seed (idx2) = mean(1,2,3) = 2; idx3 = .5*4+.5*2 = 3; idx4 = .5*5+.5*3 = 4
    same(ind.ema(arr(1, 2, 3, 4, 5), 3), [nan, nan, 2, 3, 4])


@pytest.mark.parametrize("n", [5, 12, 26])
def test_ind81_ema_matches_pandas_ewm_seeded_the_same_way(n: int) -> None:
    rng = np.random.default_rng(7)
    x = 100 + np.cumsum(rng.normal(0, 1, 300))
    seeded = x[n - 1 :].copy()
    seeded[0] = x[:n].mean()  # the spec's seed: SMA of the first n values
    ref = pd.Series(seeded).ewm(span=n, adjust=False).mean().to_numpy()
    got = ind.ema(x, n)
    assert np.isnan(got[: n - 1]).all()
    # tolerance applies after 3n bars (docs/05 3); got[k] pairs with ref[k - (n - 1)]
    np.testing.assert_allclose(got[3 * n :], ref[3 * n - (n - 1) :], rtol=1e-6)


# IND-82 -------------------------------------------------------------------------------------
WILDER = [
    44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08,
    45.89, 46.03, 45.61, 46.28, 46.28, 46.00, 46.03, 46.41, 46.22,
]  # fmt: skip


def test_ind82_rsi_wilder_hand_computation() -> None:
    close = arr(*WILDER)
    got = ind.rsi(close, 14)
    assert np.isnan(got[:14]).all()
    # Independent naive Wilder implementation as the reference.
    d = np.diff(close)
    g, lo = np.where(d > 0, d, 0.0), np.where(d < 0, -d, 0.0)
    ag, al = g[:14].mean(), lo[:14].mean()
    exp = [100 - 100 / (1 + ag / al)]
    for i in range(14, len(d)):
        ag, al = (ag * 13 + g[i]) / 14, (al * 13 + lo[i]) / 14
        exp.append(100 - 100 / (1 + ag / al))
    np.testing.assert_allclose(got[14:], exp, rtol=1e-12)
    # Pinned values (first RSI = 100 - 100/(1+RS) with RS from the first-14 simple means).
    np.testing.assert_allclose(got[14:], [70.4641, 66.2496, 66.4809, 69.3469, 66.2947], atol=1e-3)


def test_ind82_rsi_all_gains_is_100_and_flat_is_50() -> None:
    assert ind.rsi(arr(*range(1, 20)), 14)[-1] == 100.0
    assert ind.rsi(arr(*([5.0] * 20)), 14)[-1] == 50.0
    assert ind.rsi(arr(*range(20, 1, -1)), 14)[-1] == 0.0


# IND-83 -------------------------------------------------------------------------------------
def test_ind83_macd_linear_series_exact_and_valid_after_34_bars() -> None:
    # EMA(n) of a linear series t lags by (n-1)/2 exactly (SMA seed): macd = 12.5 - 5.5 = 7.
    m = ind.macd(arr(*range(1, 61)))
    assert np.isnan(m.macd[:25]).all() and not np.isnan(m.macd[25])
    assert np.isnan(m.signal[:33]).all() and not np.isnan(m.signal[33])
    assert np.isnan(m.hist[:33]).all()
    np.testing.assert_allclose(m.macd[25:], 7.0, rtol=1e-12)
    np.testing.assert_allclose(m.signal[33:], 7.0, rtol=1e-12)
    np.testing.assert_allclose(m.hist[33:], 0.0, atol=1e-9)


# IND-84 -------------------------------------------------------------------------------------
def test_ind84_bollinger_population_std() -> None:
    # [2,4,4,4,5,5,7,9]: mean 5, population std 2 -> bands 1 and 9; C=9 sits at position 1.0
    b = ind.bollinger(arr(2, 4, 4, 4, 5, 5, 7, 9), n=8, k=2.0)
    assert (b.middle[-1], b.upper[-1], b.lower[-1]) == (5.0, 9.0, 1.0)
    assert b.position[-1] == pytest.approx(1.0)
    assert np.isnan(b.middle[:7]).all()


def test_ind84_bollinger_zero_width_has_no_position() -> None:
    b = ind.bollinger(arr(*([10.0] * 25)))
    assert b.upper[-1] == b.lower[-1] == 10.0
    assert math.isnan(b.position[-1])


# IND-85 -------------------------------------------------------------------------------------
H = arr(10, 11, 13, 12, 14)
L = arr(8, 9, 10, 9, 11)
C = arr(9, 10, 12, 10, 13)


def test_ind85_true_range_and_atr_wilder() -> None:
    # TR1..4 = 2, 3, 3, 4 ; ATR(3) at idx3 = (2+3+3)/3 = 8/3 ; idx4 = (8/3*2 + 4)/3 = 28/9
    same(ind.true_range(H, L, C), [nan, 2, 3, 3, 4])
    same(ind.atr(H, L, C, 3), [nan, nan, nan, 8 / 3, 28 / 9])


def test_ind85_adx_wilder_hand_values() -> None:
    # n=2. +DM = 1,2,0,2 ; -DM = 0,0,1,0 ; TR = 2,3,3,4
    # t=2: sTR 5, s+ 3, s- 0 -> +DI 60, -DI 0, DX 100
    # t=3: sTR 5.5, s+ 1.5, s- 1 -> +DI 27.2727, -DI 18.1818, DX 20
    # t=4: sTR 6.75, s+ 2.75, s- .5 -> +DI 40.7407, -DI 7.4074, DX 69.2308
    # ADX first (idx 3) = mean(100, 20) = 60 ; idx4 = (60 + 69.2308)/2 = 64.6154
    a = ind.adx(H, L, C, 2)
    same(a.plus_di, [nan, nan, 60, 100 * 1.5 / 5.5, 100 * 2.75 / 6.75], 1e-9)
    same(a.minus_di, [nan, nan, 0, 100 * 1 / 5.5, 100 * 0.5 / 6.75], 1e-9)
    same(
        a.adx, [nan, nan, nan, 60, (60 + 100 * (40.74074074 - 7.40740741) / 48.14814815) / 2], 1e-6
    )
    assert a.adx[4] == pytest.approx(64.6154, abs=1e-4)


def test_ind85_adx_needs_two_n_bars_and_flat_market_is_zero_dx() -> None:
    flat = arr(*([5.0] * 40))
    a = ind.adx(flat, flat, flat)
    assert np.isnan(a.adx[:27]).all()
    assert a.adx[27] == 0.0  # no movement -> DX 0, not a division error
    assert np.isnan(ind.adx(flat[:20], flat[:20], flat[:20]).adx).all()


# IND-86 -------------------------------------------------------------------------------------
def test_ind86_stochastic_hand_values_and_flat_range() -> None:
    # n=3: idx2 HH13 LL8 C12 -> 80 ; idx3 HH13 LL9 C10 -> 25 ; idx4 HH14 LL9 C13 -> 80 ; %D(2)=52.5
    s = ind.stochastic(H, L, C, 3, 2)
    same(s.k, [nan, nan, 80, 25, 80])
    same(s.d, [nan, nan, nan, 52.5, 52.5])
    flat = arr(*([7.0] * 20))
    assert ind.stochastic(flat, flat, flat).k[-1] == 50.0  # HH == LL -> 50


# IND-87 -------------------------------------------------------------------------------------
def test_ind87_obv_signs() -> None:
    same(ind.obv(arr(10, 11, 10, 10, 12), arr(100, 200, 300, 400, 500)), [0, 200, -100, -100, 400])


# IND-88 -------------------------------------------------------------------------------------
def test_ind88_volume_zscore_prior_window_excludes_today() -> None:
    # prior [10,20,30]: mean 20, sample std 10 -> (40-20)/10 = 2 ; today is not in its own window
    same(ind.volume_zscore(arr(10, 20, 30, 40), 3), [nan, nan, nan, 2.0])


def test_ind88_volume_zscore_zero_std_is_null() -> None:
    assert math.isnan(ind.volume_zscore(arr(*([100.0] * 25)))[-1])


# IND-89 -------------------------------------------------------------------------------------
def test_ind89_week52_window_and_null_below_252_rows() -> None:
    h = np.linspace(100, 200, 300)
    lo = h - 10
    r = ind.week52(h, lo)
    assert r is not None and r.high == 200.0 and r.low == pytest.approx(h[-252] - 10)
    assert ind.week52(h[:251], lo[:251]) is None


# IND-90 -------------------------------------------------------------------------------------
def test_ind90_support_resistance_clusters_and_orders_by_distance() -> None:
    s = arr(5, 9, 5, 8, 5, 9.1, 5, 6, 6.5)
    sup, res = ind.support_resistance(s, s, 7.0, wing=1, window=250)
    # swing lows 5,5,5 ; swing highs 9, 8, 9.1 -> 9 and 9.1 are within 1.5% and average to 9.05
    assert [(x.price, x.touches) for x in sup] == [(5.0, 3)]
    assert [round(x.price, 2) for x in res] == [8.0, 9.05]
    assert [x.touches for x in res] == [1, 2]


def test_ind90_last_wing_rows_are_unconfirmed() -> None:
    s = arr(5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 50)  # a spike on the very last bar is not a swing yet
    sup, res = ind.support_resistance(s, s, 6.0, wing=5)
    assert res == []


# IND-91 -------------------------------------------------------------------------------------
def test_ind91_golden_and_death_cross_within_last_20_bars() -> None:
    n = 30
    fast, slow = np.full(n, 10.0), np.full(n, 11.0)
    fast[25:] = 12.0  # crosses above on bar 25 (inside the last 20)
    c = ind.crosses(fast, slow)
    assert c is not None and c.golden and not c.death and c.last_cross == "golden"
    fast2 = np.full(n, 12.0)
    fast2[25:] = 10.0
    d = ind.crosses(fast2, slow)
    assert d is not None and d.death and not d.golden and d.last_cross == "death"


def test_ind91_cross_outside_window_or_without_slow_sma() -> None:
    n = 40
    fast, slow = np.full(n, 10.0), np.full(n, 11.0)
    fast[5:] = 12.0  # long ago
    old = ind.crosses(fast, slow)
    assert old is not None and not old.golden and not old.death and old.last_cross is None
    slow_nan = np.full(n, np.nan)
    assert ind.crosses(fast, slow_nan) is None
