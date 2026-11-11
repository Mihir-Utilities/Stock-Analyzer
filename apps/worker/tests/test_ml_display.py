"""D07 per-stock display rules (ML-06), buckets, band conversion, outcome resolution and the
prediction builder (docs/05 10.6, 10.7; docs/03 section 6). No wall clock: ``today`` is passed."""

from __future__ import annotations

import math
from dataclasses import dataclass, replace
from datetime import date

import numpy as np
import pytest
from mlgen import make_panel_inputs

from worker.ml import display as dp
from worker.ml.features import MarketInput, build_panel
from worker.ml.predict import PredRow, StockInfo, build_predictions

AS_OF = date(2026, 10, 7)  # Wednesday
TODAY = date(2026, 10, 8)


def base(**kw: object) -> dp.DisplayInput:
    d = dp.DisplayInput(
        bars=800,
        adv_value_cr=3.0,
        last_bar=AS_OF,
        as_of=AS_OF,
        today=TODAY,
        holidays=frozenset(),
        action_dates=(),
        unconfirmed_action=False,
        model_state="active_pass",
    )
    return replace(d, **kw)  # type: ignore[arg-type]


# ML-06
def test_ml06_a_clean_stock_is_shown() -> None:
    assert dp.hidden_reason(base()) is None


@pytest.mark.parametrize(
    ("bars", "reason"),
    [(503, dp.INSUFFICIENT_HISTORY), (504, None), (100, dp.INSUFFICIENT_HISTORY)],
)
def test_ml06_history_threshold_is_504_bars(bars: int, reason: str | None) -> None:
    assert dp.hidden_reason(base(bars=bars)) == reason


@pytest.mark.parametrize(
    ("adv", "reason"),
    [(0.49, dp.LOW_LIQUIDITY), (0.5, None), (None, dp.LOW_LIQUIDITY), (math.nan, dp.LOW_LIQUIDITY)],
)
def test_ml06_liquidity_threshold_is_half_a_crore(adv: float | None, reason: str | None) -> None:
    assert dp.hidden_reason(base(adv_value_cr=adv)) == reason


def test_ml06_unconfirmed_action_hides_with_the_action_reason() -> None:
    assert dp.hidden_reason(base(unconfirmed_action=True)) == dp.NEAR_ACTION


@pytest.mark.parametrize(
    ("ex", "hidden"),
    [
        (date(2026, 10, 14), True),  # 5 trading days after as_of
        (date(2026, 10, 15), False),  # 6
        (date(2026, 9, 30), True),  # 5 trading days before
        (date(2026, 9, 29), False),  # 6
        (date(2026, 10, 7), True),  # on as_of
    ],
)
def test_ml06_corporate_action_window_is_five_trading_days_each_side(
    ex: date, hidden: bool
) -> None:
    got = dp.hidden_reason(base(action_dates=(ex,), today=date(2026, 10, 7)))
    assert (got == dp.NEAR_ACTION) is hidden


def test_ml06_trading_days_skip_weekends_and_holidays() -> None:
    hol = frozenset({date(2026, 10, 2)})  # a Friday holiday
    assert dp.trading_days_between(date(2026, 9, 30), AS_OF, frozenset()) == 5
    assert dp.trading_days_between(date(2026, 9, 30), AS_OF, hol) == 4
    assert dp.hidden_reason(base(action_dates=(date(2026, 9, 29),), holidays=hol)) == dp.NEAR_ACTION
    assert dp.trading_days_between(AS_OF, AS_OF, hol) == 0
    assert dp.trading_days_between(AS_OF, date(2026, 10, 1), hol) == 0
    assert dp.last_trading_day(date(2026, 10, 10), frozenset()) == date(2026, 10, 9)  # Saturday
    assert dp.last_trading_day(date(2026, 10, 3), hol) == date(2026, 10, 1)


@pytest.mark.parametrize(
    ("last_bar", "today", "reason"),
    [
        (date(2026, 10, 7), date(2026, 10, 12), None),  # 3 trading days behind (Thu, Fri, Mon)
        (date(2026, 10, 6), date(2026, 10, 12), dp.STALE),  # 4
        (date(2026, 10, 7), date(2026, 10, 10), None),  # Saturday: expected date is Friday (2)
        (date(2026, 10, 1), date(2026, 10, 10), dp.STALE),
        (date(2026, 10, 7), date(2026, 10, 7), None),
    ],
)
def test_ml06_stale_data_is_more_than_three_trading_days(
    last_bar: date, today: date, reason: str | None
) -> None:
    got = dp.hidden_reason(base(last_bar=last_bar, as_of=last_bar, today=today))
    assert got == reason


def test_ml06_model_reasons_come_last_and_stock_reasons_win() -> None:
    assert dp.hidden_reason(base(model_state="none")) == dp.NO_MODEL
    assert dp.hidden_reason(base(model_state="gated")) == dp.NOT_BETTER
    assert dp.hidden_reason(base(model_state="failed")) == dp.NOT_BETTER
    assert dp.hidden_reason(base(model_state="none", bars=10)) == dp.INSUFFICIENT_HISTORY
    assert dp.stock_level_reason(base(model_state="gated")) is None
    assert dp.stock_level_reason(base(bars=10)) == dp.INSUFFICIENT_HISTORY
    assert dp.hidden_reason(base(bars=10)) in {
        "model_not_better_than_baseline",
        "insufficient_history",
        "low_liquidity",
        "near_corporate_action",
        "no_model",
        "stale_data",
    }


@pytest.mark.parametrize(
    ("p", "name"),
    [
        (0.39, "strongly_down"),
        (0.40, "slightly_down"),
        (0.469, "slightly_down"),
        (0.47, "neutral"),
        (0.53, "neutral"),
        (0.531, "slightly_up"),
        (0.60, "slightly_up"),
        (0.601, "strongly_up"),
    ],
)
def test_buckets_follow_the_api_spec(p: float, name: str) -> None:
    assert dp.bucket(p) == name


def test_band_returns_scale_by_sigma_sqrt_h_and_are_simple_returns() -> None:
    q10, q50, q90 = dp.band_returns(0.02, 21, (-1.28, 0.0, 1.28))
    s = 0.02 * math.sqrt(21)
    assert q10 == pytest.approx(math.exp(-1.28 * s) - 1)
    assert q50 == 0.0 and q90 == pytest.approx(math.exp(1.28 * s) - 1)
    assert q10 < q50 < q90


def test_outcome_resolution_formulas() -> None:
    o = dp.resolve_outcome(ref_close=100.0, later_close=103.0, p_up=0.55, q10=-0.05, q90=0.04)
    assert o.realized_return == pytest.approx(0.03) and o.direction_correct is True
    assert o.in_band is True
    o = dp.resolve_outcome(ref_close=100.0, later_close=103.0, p_up=0.49, q10=-0.05, q90=0.02)
    assert o.direction_correct is False and o.in_band is False
    o = dp.resolve_outcome(ref_close=100.0, later_close=75.0, p_up=0.5, q10=-0.25, q90=0.02)
    assert o.direction_correct is False  # p_up >= 0.5 predicts up; the stock fell
    assert o.in_band is True  # -0.25 sits exactly on the lower edge
    o = dp.resolve_outcome(ref_close=100.0, later_close=100.0, p_up=0.3, q10=None, q90=None)
    assert o.realized_return == 0.0 and o.direction_correct is True  # flat is not "up"
    assert o.in_band is None
    assert (
        dp.resolve_outcome(
            ref_close=1.0, later_close=2.0, p_up=None, q10=None, q90=None
        ).direction_correct
        is None
    )


# --- prediction builder -------------------------------------------------------------------


@dataclass
class StubModel:
    names: list[str]

    def p_up(self, x: np.ndarray) -> np.ndarray:
        return np.full(len(x), 0.58)

    def z_band(self, x: np.ndarray) -> np.ndarray:
        return np.tile(np.array([-1.0, 0.1, 1.2]), (len(x), 1))


def build(
    states: dict[int, str], *, names: list[str] | None = None, today: date | None = None
) -> tuple[list[PredRow], list[str]]:
    stocks, _ = make_panel_inputs(n_stocks=4, n_days=800, seed=21, with_market=False)
    panel = build_panel(stocks, MarketInput())
    infos: dict[str, StockInfo] = {}
    for s in stocks:
        b = s.bars
        infos[s.symbol] = StockInfo(
            s.symbol, len(infos) + 1, 800, b.dates[-1], float(b.adj_close[-1]), 5.0, (), False
        )
    infos["S01"] = replace(infos["S01"], adv_value_cr=0.1)
    infos["S02"] = replace(infos["S02"], unconfirmed_action=True)
    infos["SHORT"] = StockInfo("SHORT", 9, 600, stocks[0].bars.dates[-1], 10.0, 5.0, (), False)
    model = StubModel(list(panel.names) if names is None else names)
    last = stocks[0].bars.dates[-1]
    rows = build_predictions(
        panel,
        infos,
        {5: model, 21: model},  # type: ignore[dict-item]
        states,
        today=today or last,
        holidays=frozenset(),
    )
    return rows, [last.isoformat()]


def by(rows: list[PredRow], symbol: str, h: int = 5) -> PredRow:
    return next(r for r in rows if r.symbol == symbol and r.horizon == h)


def test_predictions_follow_the_display_rules() -> None:
    rows, _ = build({5: "active_pass", 21: "active_pass"})
    assert len(rows) == 2 * 5
    ok = by(rows, "S00")
    assert ok.shown and ok.hidden_reason is None and ok.p_up == pytest.approx(0.58)
    assert ok.ret_q10 is not None and ok.ret_q50 is not None and ok.ret_q90 is not None
    assert ok.ret_q10 < ok.ret_q50 < ok.ret_q90
    illiquid, unconfirmed = by(rows, "S01"), by(rows, "S02")
    assert not illiquid.shown and illiquid.hidden_reason == dp.LOW_LIQUIDITY
    assert not unconfirmed.shown and unconfirmed.hidden_reason == dp.NEAR_ACTION
    for r in (illiquid, unconfirmed):
        assert r.p_up is None and r.ret_q10 is None  # never 0 for unknown
    short = by(rows, "SHORT")
    assert short.hidden_reason == dp.INSUFFICIENT_HISTORY and short.p_up is None


def test_stale_stock_is_hidden_without_values() -> None:
    rows, _ = build({5: "active_pass"}, today=date(2030, 1, 1))
    assert {r.hidden_reason for r in rows if r.symbol != "SHORT"} <= {
        dp.STALE,
        dp.LOW_LIQUIDITY,
        dp.NEAR_ACTION,
    }
    assert by(rows, "S00").hidden_reason == dp.STALE and by(rows, "S00").p_up is None


def test_a_gated_model_stores_values_for_tracking_but_never_shows_them() -> None:
    rows, _ = build({5: "gated"})
    r = by(rows, "S00")
    assert not r.shown and r.hidden_reason == dp.NOT_BETTER and r.p_up == pytest.approx(0.58)


def test_a_failed_candidate_has_no_values_and_no_model_means_no_rows() -> None:
    rows, _ = build({5: "failed", 21: "none"})
    assert {r.horizon for r in rows} == {5}  # `none` has no model_run to reference
    assert by(rows, "S00").hidden_reason == dp.NOT_BETTER and by(rows, "S00").p_up is None


def test_a_model_trained_on_other_features_is_not_used() -> None:
    rows, _ = build({5: "active_pass"}, names=["ret_1"])
    r = by(rows, "S00")
    assert not r.shown and r.hidden_reason == dp.NO_MODEL and r.p_up is None
