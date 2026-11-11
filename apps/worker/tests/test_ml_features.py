"""D07 feature builder: ML-01 (no lookahead), ML-02 (label alignment with holidays), ML-08
(missing index/VIX), plus the docs/05 10.3 formulas against hand/numpy references."""

from __future__ import annotations

import math
from datetime import date

import numpy as np
import pytest
from mlgen import make_bars, make_panel_inputs, weekdays

from worker.analytics.snapshot import Bars
from worker.ml import features as ft
from worker.ml.features import MarketInput, StockInput, build_panel


def _row(panel: ft.Panel, symbol: str, i: int) -> int:
    si = panel.symbols.index(symbol)
    hits = np.flatnonzero((panel.stock == si) & (panel.row_in_stock == i))
    assert len(hits) == 1
    return int(hits[0])


def _shuffle_after(bars: Bars, t: int, rng: np.random.Generator) -> Bars:
    perm = rng.permutation(len(bars.dates) - t - 1) + t + 1
    idx = np.concatenate([np.arange(t + 1), perm])
    return Bars(
        bars.dates,
        bars.close[idx],
        bars.adj_close[idx],
        bars.high[idx],
        bars.low[idx],
        bars.volume[idx],
    )


# ML-01
def test_ml01_changing_prices_after_t_leaves_features_at_t_unchanged() -> None:
    stocks, market = make_panel_inputs(n_stocks=5, n_days=700, seed=3)
    t = 450  # row index == calendar index here (every stock has every date)
    rng = np.random.default_rng(99)
    shuffled = [StockInput(s.symbol, _shuffle_after(s.bars, t, rng)) for s in stocks]
    dates = stocks[0].bars.dates
    assert market.nifty is not None and market.vix is not None
    nifty = {d: v * (3.0 if i > t else 1.0) for i, (d, v) in enumerate(market.nifty.items())}
    vix = {d: v + (50.0 if i > t else 0.0) for i, (d, v) in enumerate(market.vix.items())}
    a = build_panel(stocks, market)
    b = build_panel(shuffled, MarketInput(nifty, vix))
    assert dates[t] == a.calendar[t]
    ma, mb = a.date_idx <= t, b.date_idx <= t
    assert ma.sum() > 100 and ma.sum() == mb.sum()
    assert np.array_equal(a.X[ma], b.X[mb])  # includes the per-date cross-sectional ranks
    assert np.array_equal(a.sigma[ma], b.sigma[mb])
    assert not np.array_equal(a.X[~ma], b.X[~mb])  # the test would be vacuous otherwise


def test_ml01_cross_sectional_rank_uses_only_that_date() -> None:
    date_idx = np.array([0, 0, 0, 1, 1, 1], dtype=np.int64)
    v = np.array([3.0, 1.0, 2.0, 10.0, 30.0, 20.0])
    r = ft.cross_sectional_ranks(date_idx, v)
    assert np.allclose(r, [1.0, 1 / 3, 2 / 3, 1 / 3, 1.0, 2 / 3])
    # changing day 1 does not move day 0
    v2 = v.copy()
    v2[3:] = [5.0, 4.0, 1e9]
    assert np.allclose(ft.cross_sectional_ranks(date_idx, v2)[:3], r[:3])


def test_rank_of_a_single_stock_is_dropped_not_invented() -> None:
    r = ft.cross_sectional_ranks(np.array([0, 1, 1], dtype=np.int64), np.array([5.0, 1.0, 2.0]))
    assert math.isnan(r[0]) and np.allclose(r[1:], [0.5, 1.0])


# ML-02
def test_ml02_labels_use_the_stocks_own_rows_across_holidays() -> None:
    rng = np.random.default_rng(5)
    all_days = weekdays(620)
    gap_days = {all_days[300], all_days[301], all_days[302], all_days[450]}
    own_days = [d for d in all_days if d not in gap_days]
    full = StockInput("FULL", make_bars(all_days, rng))
    gappy = StockInput("GAPPY", make_bars(own_days, rng))
    panel = build_panel([full, gappy], MarketInput(), horizons=(5, 21))
    for h in (5, 21):
        for i in (260, 299, 440, 445):  # windows that do and do not cross the gap
            pos = _row(panel, "GAPPY", i)
            expect_date = gappy.bars.dates[i + h]
            assert panel.calendar[int(panel.label_end[h][pos])] == expect_date
            c = gappy.bars.adj_close
            assert panel.y_ret[h][pos] == pytest.approx(math.log(c[i + h] / c[i]))
    # the same row offset in calendar days differs from the row offset: the gap shifts the date
    pos = _row(panel, "GAPPY", 299)
    assert (gappy.bars.dates[299 + 5] - gappy.bars.dates[299]).days > 7
    # the last h rows of a stock have no label
    last = _row(panel, "FULL", 619)
    assert not panel.labeled(5)[last]
    assert not panel.labeled(5)[_row(panel, "FULL", 615)]
    assert panel.labeled(5)[_row(panel, "FULL", 614)]


def test_label_direction_is_strictly_positive_return() -> None:
    stocks, market = make_panel_inputs(n_stocks=2, n_days=400, seed=1, with_market=False)
    panel = build_panel(stocks, market, horizons=(5,))
    ok = panel.labeled(5)
    y = panel.y_dir(5)[ok]
    assert set(np.unique(y)) <= {0.0, 1.0}
    assert np.array_equal(y, (panel.y_ret[5][ok] > 0).astype(float))
    # an exactly flat window is class 0 (> 0, not >= 0)
    flat = Bars(
        weekdays(400),
        np.full(400, 50.0),
        np.full(400, 50.0),
        np.full(400, 50.5),
        np.full(400, 49.5),
        np.full(400, 1e6),
    )
    f = ft.stock_frame(
        StockInput("F", flat),
        {d: i for i, d in enumerate(flat.dates)},
        ft.build_market([], MarketInput()),
    )
    assert f.y_ret[5][10] == 0.0


# ML-08
@pytest.mark.parametrize(
    ("has_nifty", "has_vix"), [(True, True), (True, False), (False, True), (False, False)]
)
def test_ml08_missing_market_series_are_omitted_for_all_rows(
    has_nifty: bool, has_vix: bool
) -> None:
    stocks, market = make_panel_inputs(n_stocks=4, n_days=520, seed=2)
    mk = MarketInput(market.nifty if has_nifty else None, market.vix if has_vix else None)
    panel = build_panel(stocks, mk)
    names = set(panel.names)
    assert (set(ft.NIFTY_FEATURES) <= names) == has_nifty
    assert not has_nifty or "beta_252" in names
    assert (set(ft.VIX_FEATURES) <= names) == has_vix
    assert panel.X.shape[1] == len(panel.names) and len(panel) > 0
    assert np.isfinite(panel.X).all()  # every row complete, none dropped for the omitted group
    no_market = build_panel(stocks, MarketInput())
    assert len(no_market) >= len(panel)  # omitting a group never removes rows


def test_ml08_feature_hash_changes_with_the_feature_set() -> None:
    a = ft.feature_hash(ft.feature_names(nifty=True, vix=True))
    assert a != ft.feature_hash(ft.feature_names(nifty=False, vix=True))
    assert a == ft.feature_hash(ft.feature_names(nifty=True, vix=True))


def test_market_gaps_fill_forward_by_at_most_one_row() -> None:
    cal = weekdays(8)
    series = {cal[0]: 100.0, cal[1]: 101.0, cal[4]: 104.0}  # gaps: rows 2-3 and 5-7
    out = ft.on_calendar(series, cal)
    assert out is not None
    assert out[1] == 101.0 and out[2] == 101.0  # one row filled
    assert math.isnan(out[3])  # the second missing row stays missing -> the stock row is dropped
    assert out[4] == 104.0 and out[5] == 104.0 and math.isnan(out[6])
    assert ft.on_calendar(None, cal) is None
    assert ft.on_calendar({date(1999, 1, 1): 5.0}, cal) is None  # never meets the calendar


# docs/05 10.3 formulas
def test_feature_formulas_match_numpy_references() -> None:
    stocks, market = make_panel_inputs(n_stocks=3, n_days=600, seed=11)
    panel = build_panel(stocks, market)
    s = stocks[1]
    c = s.bars.adj_close
    i = 400
    pos = _row(panel, s.symbol, i)

    def col(name: str) -> float:
        return float(panel.column(name)[pos])

    lr = np.diff(np.log(c))
    assert col("ret_1") == pytest.approx(math.log(c[i] / c[i - 1]))
    for w in (5, 10, 21, 63, 126):
        assert col(f"ret_{w}") == pytest.approx(math.log(c[i] / c[i - w]))
    assert col("vol_20") == pytest.approx(lr[i - 20 : i].std(ddof=1))
    assert col("vol_60") == pytest.approx(lr[i - 60 : i].std(ddof=1))
    assert col("vol_ratio") == pytest.approx(col("vol_20") / col("vol_60"))
    k = s.bars.adj_close / s.bars.close
    assert col("dist_52w_high") == pytest.approx(
        c[i] / (s.bars.high * k)[i - 251 : i + 1].max() - 1
    )
    assert col("dist_52w_low") == pytest.approx(c[i] / (s.bars.low * k)[i - 251 : i + 1].min() - 1)
    adv = (s.bars.close * s.bars.volume)[i - 59 : i + 1].mean()
    assert col("adv_value_60_log") == pytest.approx(math.log(adv))
    assert col("dow") == s.bars.dates[i].weekday()
    # beta_252: OLS slope of stock simple returns on Nifty simple returns over 252 returns
    assert market.nifty is not None
    nf = np.array([market.nifty[d] for d in s.bars.dates])
    rs, rb = c[1:] / c[:-1] - 1, nf[1:] / nf[:-1] - 1
    sl = slice(i - 252, i)  # returns i-251 .. i  (return j belongs to row j+1)
    beta = np.polyfit(rb[sl], rs[sl], 1)[0]
    assert col("beta_252") == pytest.approx(beta)
    assert col("rel_strength_21") == pytest.approx(
        math.log(c[i] / c[i - 21]) - math.log(nf[i] / nf[i - 21])
    )
    assert col("mkt_ret_5") == pytest.approx(math.log(nf[i] / nf[i - 5]))
    assert col("mkt_vol_20") == pytest.approx(np.diff(np.log(nf))[i - 20 : i].std(ddof=1))
    assert market.vix is not None
    vx = np.array([market.vix[d] for d in s.bars.dates])
    assert col("vix_level") == pytest.approx(vx[i])
    assert col("vix_chg_5") == pytest.approx(vx[i] - vx[i - 5])


def test_ewma_sigma_matches_the_recursion_by_hand() -> None:
    rng = np.random.default_rng(0)
    lr = np.concatenate([[np.nan], rng.normal(0, 0.01, 40)])
    out = ft.ewma_sigma(lr)
    assert np.isnan(out[:20]).all()
    var = float(np.var(lr[1:21], ddof=1))
    assert out[20] == pytest.approx(math.sqrt(var))
    var = 0.94 * var + 0.06 * lr[21] ** 2
    assert out[21] == pytest.approx(math.sqrt(var))
    var = 0.94 * var + 0.06 * lr[22] ** 2
    assert out[22] == pytest.approx(math.sqrt(var))


def test_rows_with_a_missing_feature_are_dropped_not_imputed() -> None:
    stocks, _ = make_panel_inputs(n_stocks=2, n_days=300, seed=4, with_market=False)
    panel = build_panel(stocks, MarketInput())
    first_complete = panel.row_in_stock.min()
    assert first_complete >= 251  # dist_52w needs 252 rows; earlier rows are absent, not filled
    assert np.isfinite(panel.X).all()


def test_zero_variance_window_row_is_dropped() -> None:
    n = 400
    flat = Bars(
        weekdays(n),
        np.full(n, 50.0),
        np.full(n, 50.0),
        np.full(n, 50.5),
        np.full(n, 49.5),
        np.full(n, 1e6),
    )
    other = make_bars(weekdays(n), np.random.default_rng(1))
    panel = build_panel([StockInput("FLAT", flat), StockInput("OK", other)], MarketInput())
    assert "FLAT" not in {panel.symbols[i] for i in np.unique(panel.stock)}  # sigma 0 -> dropped
