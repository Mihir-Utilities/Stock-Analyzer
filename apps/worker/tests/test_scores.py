"""Scores (docs/05 section 6): trend, risk and quality with hand-computed values (SCO-81..SCO-89)."""

from __future__ import annotations

import json
from typing import Any

import pytest

from worker.analytics.scores import (
    QUALITY_COMPONENTS,
    RISK_WEIGHTS,
    RiskInput,
    interpolate,
    quality_score,
    risk_label,
    risk_scores,
    trend_label,
    trend_score,
)

ap = pytest.approx


def snap(**over: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "bars": 300,
        "last_close": 110.0,
        "technicals": {
            "sma50": 105.0, "sma200": 100.0, "adx14": 25.0, "plus_di14": 30.0,
            "minus_di14": 10.0, "macd_hist": 0.5,
        },
        "returns": {"trading": {"ret_1m": 2.0, "ret_6m": 8.0}},
    }  # fmt: skip
    for k, v in over.items():
        if k in base["technicals"]:
            base["technicals"][k] = v
        elif k in base["returns"]["trading"]:
            base["returns"]["trading"][k] = v
        else:
            base[k] = v
    return base


# --- 6.1 trend ----------------------------------------------------------------------------------


def test_trend_all_conditions_met_is_100_strong_up() -> None:
    t = trend_score(snap())
    assert t["score"] == 100 and t["label"] == "strong_up" and t["reason"] is None
    assert [c["points"] for c in t["components"]] == [20, 20, 20, 10, 10, 10, 10]


@pytest.mark.parametrize(
    ("over", "score", "label"),
    [
        ({"last_close": 102.0}, 80, "up"),  # below SMA50 only: -20
        ({"last_close": 99.0}, 60, "sideways"),  # below SMA50 and SMA200: -40; SMA50 > SMA200 stays
        ({"sma50": 99.0}, 80, "up"),  # SMA50 below SMA200: -20; close above both stays
        ({"ret_1m": -1.0}, 90, "strong_up"),
        ({"ret_6m": 0.0}, 90, "strong_up"),  # not strictly above 0
        ({"adx14": 20.0}, 90, "strong_up"),  # ADX must be above 20
        ({"plus_di14": 10.0}, 90, "strong_up"),  # +DI must exceed -DI
        ({"macd_hist": 0.0}, 90, "strong_up"),
    ],
)
def test_trend_each_rule(over: dict[str, Any], score: int, label: str) -> None:
    got = trend_score(snap(**over))
    assert got["score"] == score and got["label"] == label


def test_trend_label_bands_and_history_rule() -> None:
    assert [trend_label(s) for s in (0, 20, 21, 40, 41, 60, 61, 80, 81, 100)] == [
        "strong_down", "strong_down", "down", "down", "sideways", "sideways", "up", "up",
        "strong_up", "strong_up",
    ]  # fmt: skip
    short = trend_score(snap(bars=199))
    assert short["score"] is None and short["reason"] == "insufficient_history"
    assert trend_score(snap(bars=200))["score"] == 100  # exactly 200 bars is enough


def test_trend_unknown_input_scores_zero_points_and_says_so() -> None:
    t = trend_score(snap(macd_hist=None))
    assert t["score"] == 90
    assert t["components"][-1]["met"] is None and t["components"][-1]["value"] is None


# --- 6.2 risk -----------------------------------------------------------------------------------


def uni(n: int, bars: int = 300) -> dict[str, RiskInput]:
    """Stock i: volatility, drawdown, beta and traded value all increase with i, so the first
    three percentiles rise with i while illiquidity (100 - percentile of traded value) falls."""
    return {
        f"S{i:02d}": RiskInput(
            bars=bars,
            vol_252=20.0 + i,
            maxdd_3y=-(10.0 + i),
            beta_252=0.5 + i / 10,
            adv_value_60_cr=1.0 + i,
        )
        for i in range(n)
    }


def test_risk_known_answer_for_lowest_and_highest_of_twenty() -> None:
    out = risk_scores(uni(20))
    lo, hi = out["S00"], out["S19"]
    # S00: percentiles 0/0/0, illiquidity 100 - 0 = 100 -> 0.2 x 100 = 20
    assert lo["score"] == ap(20.0) and lo["label"] == "low"
    # S19: percentiles 100/100/100, illiquidity 100 - 100 = 0 -> 0.35 + 0.25 + 0.20 = 80
    assert hi["score"] == ap(80.0) and hi["label"] == "high"
    assert lo["coverage"] == ap(1.0) and lo["universe_size"] == 20
    assert [c["key"] for c in lo["components"]] == [k for k, _, _ in RISK_WEIGHTS]
    p = 10 / 19 * 100  # S10 ranks 10 of 0..19
    assert out["S10"]["score"] == ap(0.8 * p + 0.2 * (100 - p))


def test_risk_needs_20_eligible_stocks_else_universe_too_small() -> None:
    out = risk_scores(uni(19))
    assert all(v["score"] is None and v["reason"] == "universe_too_small" for v in out.values())
    # a stock with fewer than 252 bars is not eligible and does not count toward the 20
    short = {**uni(19), "SHORT": RiskInput(251, 30.0, -20.0, 1.0, 5.0)}
    out2 = risk_scores(short)
    assert out2["SHORT"]["reason"] == "insufficient_history"
    assert out2["S00"]["reason"] == "universe_too_small"
    ok = {**uni(19), "EDGE": RiskInput(252, 30.0, -20.0, 1.0, 5.0)}
    assert risk_scores(ok)["EDGE"]["score"] is not None  # 252 bars qualifies: 20 eligible


def test_risk_missing_components_renormalise_and_need_three() -> None:
    u = uni(20)
    u["S05"] = RiskInput(300, 25.0, None, 1.0, 6.0)  # no 3Y drawdown (fewer than 756 bars)
    out = risk_scores(u)["S05"]
    assert out["coverage"] == ap(0.75)
    comps = {c["key"]: c for c in out["components"]}
    assert comps["maxdd_3y"]["available"] is False and comps["maxdd_3y"]["percentile"] is None
    pv, pb, pl = (comps[k]["percentile"] for k in ("vol_252", "beta_252", "illiquidity"))
    assert out["score"] == ap((0.35 * pv + 0.20 * pb + 0.20 * pl) / 0.75)
    u["S06"] = RiskInput(300, 26.0, None, None, 7.0)  # only 2 components
    bad = risk_scores(u)["S06"]
    assert bad["score"] is None and bad["reason"] == "insufficient_data"
    assert len(bad["components"]) == 4  # still shown


def test_risk_ties_share_the_average_rank_and_negative_beta_counts_as_zero() -> None:
    u = {
        f"T{i:02d}": RiskInput(300, 30.0, -20.0, -0.5 if i < 10 else 0.0, 10.0) for i in range(20)
    }  # identical vol, drawdown, liquidity; betas -0.5 and 0 both count as 0: everything tied
    for v in risk_scores(u).values():
        assert v["score"] == ap(50.0)  # every percentile is the average rank 50
    assert risk_label(32.99) == "low" and risk_label(33.0) == "medium"
    assert risk_label(66.0) == "medium" and risk_label(66.01) == "high"


def test_risk_output_is_json_safe() -> None:
    u = uni(20)
    u["S00"] = RiskInput(300, float("nan"), float("inf"), None, None)
    json.dumps(risk_scores(u), allow_nan=False)


# --- 6.3 quality --------------------------------------------------------------------------------


def test_interpolation_anchors_and_clipping() -> None:
    assert interpolate(5.0, 5.0, 25.0) == 0.0 and interpolate(25.0, 5.0, 25.0) == 100.0
    assert interpolate(15.0, 5.0, 25.0) == ap(50.0)
    assert interpolate(-10.0, 5.0, 25.0) == 0.0 and interpolate(99.0, 5.0, 25.0) == 100.0
    assert interpolate(2.0, 2.0, 0.1) == 0.0 and interpolate(0.1, 2.0, 0.1) == 100.0  # D/E
    assert interpolate(0.0, 2.0, 0.1) == 100.0  # no debt
    assert interpolate(30.0, 30.0, 0.0) == 0.0 and interpolate(15.0, 30.0, 0.0) == ap(50.0)


def test_quality_weights_sum_to_100() -> None:
    assert sum(w for _, _, w, _, _ in QUALITY_COMPONENTS) == ap(100.0)


FULL: dict[str, float | None] = {
    "roe": 15.0,
    "roce": 19.0,
    "revenue_cagr_3y": 10.0,
    "net_profit_cagr_3y": 12.5,
    "debt_equity": 1.05,
    "interest_coverage": 4.75,
    "cfo_to_pat_avg": 0.65,
    "promoter_pledged_pct": 15.0,
    "promoter_change_1y": -2.5,
}  # every value sits at the midpoint of its anchors: component score 50


def test_quality_all_components_at_midpoint_scores_50() -> None:
    q = quality_score(FULL, financial=False, no_debt=False)
    assert q["score"] == ap(50.0) and q["coverage"] == ap(1.0) and q["reason"] is None
    assert all(c["score"] == ap(50.0) for c in q["components"])


def test_quality_weighted_sum_with_known_components() -> None:
    values = dict(FULL, roe=25.0, roce=8.0)  # ROE 100 (weight 15), ROCE 0 (weight 10)
    q = quality_score(values, financial=False, no_debt=False)
    assert q["score"] == ap((100 * 15 + 0 * 10 + 50 * 75) / 100)


def test_quality_missing_components_renormalise_and_coverage_below_60_is_null() -> None:
    no_trend = {k: v for k, v in FULL.items() if k != "promoter_change_1y"}
    q = quality_score(no_trend, financial=False, no_debt=False)
    assert q["coverage"] == ap(0.95) and q["score"] == ap(50.0)
    sparse = {"roe": 25.0, "roce": 30.0, "debt_equity": 0.1, "interest_coverage": 8.0}  # weight 45
    s = quality_score(sparse, financial=False, no_debt=False)
    assert s["score"] is None and s["reason"] == "insufficient_data" and s["coverage"] == ap(0.45)
    assert len(s["components"]) == 9  # all components displayed
    edge = dict(sparse, cfo_to_pat_avg=1.0)  # weight 60 exactly: allowed
    e = quality_score(edge, financial=False, no_debt=False)
    assert e["coverage"] == ap(0.6) and e["score"] == ap(100.0)


def test_quality_no_debt_company_skips_coverage_and_de_is_100() -> None:
    values = dict(FULL, debt_equity=0.0, interest_coverage=3.0)
    q = quality_score(values, financial=False, no_debt=True)
    comps = {c["key"]: c for c in q["components"]}
    assert comps["debt_equity"]["score"] == 100.0
    assert comps["interest_coverage"]["available"] is False
    assert q["coverage"] == ap(0.9)
    assert q["score"] == ap((100 * 10 + 50 * 80) / 90)


def test_quality_not_applicable_for_financials() -> None:
    q = quality_score(FULL, financial=True, no_debt=False)
    assert q["score"] is None and q["reason"] == "not_applicable_financial"
    assert q["components"] == []
