"""Derived fundamentals, ratios and valuation (docs/05 section 5): FND-16 known answers plus the
null-reason rows FND-01, FND-04..FND-10, FND-13, FND-14 and FND-81..FND-89, SHP-02..SHP-04.

Hand-computed values use the fictional company DEMOCO of spike S16 (INR crore unless stated).
No clock, no random data: every date is fixed.
"""

from __future__ import annotations

import calendar
import json
from datetime import UTC, date, datetime, timedelta
from typing import Any

import numpy as np
import pytest

from worker.analytics import fundamentals as fnd
from worker.analytics.fundamentals import (
    FundInputs,
    FundRow,
    HoldingRow,
    Multiplier,
    build_fundamentals,
)

AS_OF = date(2026, 11, 6)  # a Friday
T0 = datetime(2026, 10, 1, 12, 0, tzinfo=UTC)
CON, STA = "consolidated", "standalone"


def row(
    pt: str,
    end: date,
    key: str,
    value: float | None,
    *,
    basis: str = CON,
    source: str = "csv_import",
    unit: str | None = None,
    filed: date | None = None,
    fetched: datetime = T0,
) -> FundRow:
    if unit is None:
        unit = {"pnl.eps": "INR", "bs.shares_outstanding": "SHARES"}.get(key, "INR_CR")
    return FundRow(basis, pt, end, key, value, unit, source, filed, fetched)


FY26, FY25, FY24, FY23 = date(2026, 3, 31), date(2025, 3, 31), date(2024, 3, 31), date(2023, 3, 31)
QUARTERS = [date(2025, 6, 30), date(2025, 9, 30), date(2025, 12, 31), date(2026, 3, 31)]
QEPS = [7.5, 8.0, 8.2, 8.6]  # sum 32.3


def democo(basis: str = CON) -> list[FundRow]:
    a = {
        FY26: {
            "pnl.revenue": 4800, "pnl.operating_income": 1120, "pnl.ebitda": 1250,
            "pnl.pbt": 920, "pnl.interest": 80, "pnl.net_profit": 690, "pnl.eps": 32.3,
            "bs.equity": 2200, "bs.total_assets": 5200, "bs.current_liabilities": 900,
            "bs.borrowings": 600, "bs.cash": 350, "bs.shares_outstanding": 200_000_000,
            "cf.cfo": 800, "cf.capex": 300,
        },
        FY25: {
            "pnl.revenue": 4400, "pnl.net_profit": 580, "bs.equity": 1900,
            "bs.total_assets": 4600, "bs.current_liabilities": 800,
        },
        FY24: {"pnl.revenue": 3900, "pnl.net_profit": 480},
        FY23: {"pnl.revenue": 3500, "pnl.net_profit": 400, "pnl.eps": 20.0},
    }  # fmt: skip
    rows = [row("A", end, k, float(v), basis=basis) for end, d in a.items() for k, v in d.items()]
    rows += [row("Q", e, "pnl.eps", v, basis=basis) for e, v in zip(QUARTERS, QEPS, strict=True)]
    return rows


def inputs(rows: list[FundRow], **kw: Any) -> FundInputs:
    kw.setdefault("close", 1800.0)
    kw.setdefault("price_dates", [AS_OF])
    kw.setdefault("price_close", np.array([kw["close"]]))
    return FundInputs(rows=rows, as_of=AS_OF, **kw)


def node(rows: list[FundRow], pt: str = "A", basis: str = CON, **kw: Any) -> dict[str, Any]:
    return build_fundamentals(inputs(rows, **kw)).tree[basis][pt]


def val(rows: list[FundRow], **kw: Any) -> dict[str, Any]:
    return node(rows, **kw)["valuation"]


def ratios(rows: list[FundRow], **kw: Any) -> dict[str, Any]:
    return node(rows, **kw)["ratios"]


def reasons(rows: list[FundRow], block: str, **kw: Any) -> dict[str, Any]:
    return node(rows, **kw)["null_reasons"][block]


ap = pytest.approx


# --- FND-16 known answers -----------------------------------------------------------------------


def test_fnd16_ratios_known_answers() -> None:
    r = ratios(democo())
    assert r["roe"] == ap(33.658537, abs=1e-6)  # 690 / avg(2200, 1900)
    assert r["roce"] == ap(24.691358, abs=1e-6)  # ebit 1000 / avg(4300, 3800)... see below
    assert r["debt_equity"] == ap(0.272727, abs=1e-6)
    assert r["interest_coverage"] == ap(12.5)  # ebit 1000 / 80
    assert r["cfo_to_pat"] == ap(1.159420, abs=1e-6)
    assert r["fcf"] == ap(500.0)
    assert r["revenue_cagr_3y"] == ap(11.102645, abs=1e-6)  # (4800/3500)^(1/3) - 1
    assert r["net_profit_cagr_3y"] == ap(19.930515, abs=1e-6)  # (690/400)^(1/3) - 1
    assert r["eps_cagr_3y"] == ap(17.325075, abs=1e-6)  # (32.3/20)^(1/3) - 1
    assert r["revenue_cagr_5y"] is None


def test_fnd16_roce_uses_capital_employed() -> None:
    # CE_t = 5200 - 900 = 4300; CE_{t-1} = 4600 - 800 = 3800; avg 4050; ebit = 920 + 80 = 1000
    assert ratios(democo())["roce"] == ap(1000 / 4050 * 100, abs=1e-9)


def test_fnd16_valuation_known_answers() -> None:
    v = val(democo())
    assert v["pe_basis"] == "ttm"
    assert v["eps_ttm"] == ap(32.3)
    assert v["pe_ttm"] == ap(55.727554, abs=1e-6)  # 1800 / 32.3
    assert v["market_cap_cr"] == ap(36000.0)  # 1800 x 2e8 / 1e7
    assert v["bvps"] == ap(110.0)  # 2200 x 1e7 / 2e8
    assert v["pb"] == ap(16.363636, abs=1e-6)
    assert v["pb_source"] == "computed"
    assert v["ev_ebitda"] == ap(29.0)  # (36000 + 600 - 350) / 1250
    assert v["peg"] == ap(55.727554 / 17.325075, abs=1e-5)
    assert v["div_yield"] is None  # no dividend entered: unknown, not 0
    assert reasons(democo(), "valuation")["div_yield"] == "no_dividend_data"


def test_fnd16_derived_arrays_aligned_to_periods() -> None:
    n = node(democo())
    assert n["periods"] == ["2023-03-31", "2024-03-31", "2025-03-31", "2026-03-31"]
    d = n["derived"]
    assert d["revenue_yoy"][-1] == ap(9.090909, abs=1e-6)  # 4800/4400 - 1
    assert d["net_profit_yoy"][-1] == ap(18.965517, abs=1e-6)
    assert d["op_margin"][-1] == ap(23.333333, abs=1e-6)
    assert d["net_margin"][-1] == ap(14.375)
    assert d["op_margin_source"][-1] == "operating_income"
    assert d["revenue_yoy"][0] is None  # no prior year entered
    assert reasons(democo(), "derived")["revenue_yoy"]["2023-03-31"] == "n/m"
    assert all(len(v) == 4 for v in d.values())


def test_fnd16_quarterly_node_has_qoq_and_matching_lengths() -> None:
    rows = democo() + [
        row("Q", e, "pnl.revenue", v)
        for e, v in zip(QUARTERS, [1000.0, 1100.0, 1210.0, 1300.0], strict=True)
    ]
    n = node(rows, "Q")
    assert n["derived"]["revenue_qoq"][1:] == [ap(10.0), ap(10.0), ap(7.438017, abs=1e-6)]
    assert n["derived"]["revenue_qoq"][0] is None
    assert n["labels"] == ["Q1 FY26", "Q2 FY26", "Q3 FY26", "Q4 FY26"]
    assert n["ratios"]["roe"] == ap(33.658537, abs=1e-6)  # ratios and valuation are basis-level


def test_op_margin_falls_back_to_ebitda_and_says_so() -> None:
    rows = [row("A", FY26, "pnl.revenue", 1000.0), row("A", FY26, "pnl.ebitda", 250.0)]
    d = node(rows)["derived"]
    assert d["op_margin"] == [ap(25.0)]
    assert d["op_margin_source"] == ["ebitda"]


# --- S16: ROE definition ------------------------------------------------------------------------


def test_s16_roe_average_equity_is_the_definition_and_differs_from_ending() -> None:
    """docs/05 defines ROE on AVERAGE equity (ending only when prior equity is missing); S16 found
    that the choice alone moves the value by 6.8%. Pinned so nobody switches silently."""
    average = ratios(democo())["roe"]
    assert average == ap(33.658537, abs=1e-6)
    assert node(democo())["ratio_meta"]["roe_basis"] == "average"
    no_prior = [x for x in democo() if not (x.key == "bs.equity" and x.period_end == FY25)]
    ending = ratios(no_prior)["roe"]
    assert ending == ap(31.363636, abs=1e-6)  # 690 / 2200
    assert node(no_prior)["ratio_meta"]["roe_basis"] == "ending"
    assert abs(ending - average) / average * 100 == ap(6.82, abs=0.01)


# --- null reasons -------------------------------------------------------------------------------


@pytest.mark.parametrize("equity", [-5.0, 0.0])
def test_fnd06_non_positive_equity_nulls_roe_de_pb(equity: float) -> None:
    rows = [x for x in democo() if not (x.key == "bs.equity" and x.period_end == FY26)]
    rows.append(row("A", FY26, "bs.equity", equity))
    r, why = ratios(rows), reasons(rows, "ratios")
    assert r["roe"] is None and why["roe"] == "negative_equity"
    assert r["debt_equity"] is None and why["debt_equity"] == "negative_equity"
    v, vwhy = val(rows), reasons(rows, "valuation")
    assert v["pb"] is None and vwhy["pb"] == "negative_equity"  # no top_ratio fallback either


def test_fnd04_loss_making_pe_null_and_growth_from_negative_base() -> None:
    rows = [x for x in democo() if x.key != "pnl.eps"]
    rows += [
        row("Q", e, "pnl.eps", v) for e, v in zip(QUARTERS, [-1.0, -2.0, -3.0, -4.0], strict=True)
    ]
    v, why = val(rows), reasons(rows, "valuation")
    assert v["pe_ttm"] is None and why["pe_ttm"] == "loss_making"
    assert v["eps_ttm"] == ap(-10.0)
    assert v["peg"] is None and why["peg"] == "loss_making"
    assert v["pe_percentile_5y"] is None and why["pe_percentile_5y"] == "loss_making"
    neg = [row("A", FY25, "pnl.net_profit", -50.0), row("A", FY26, "pnl.net_profit", 20.0)]
    d = node(neg)["derived"]
    assert d["net_profit_yoy"] == [None, None]
    assert reasons(neg, "derived")["net_profit_yoy"]["2026-03-31"] == "n/m"
    zero_base = [row("A", FY25, "pnl.revenue", 0.0), row("A", FY26, "pnl.revenue", 10.0)]
    assert node(zero_base)["derived"]["revenue_yoy"] == [None, None]


@pytest.mark.parametrize("interest", [None, 0.0])
def test_fnd05_zero_or_missing_interest_is_no_interest(interest: float | None) -> None:
    rows = [x for x in democo() if x.key != "pnl.interest"]
    if interest is not None:
        rows.append(row("A", FY26, "pnl.interest", interest))
    assert ratios(rows)["interest_coverage"] is None
    assert reasons(rows, "ratios")["interest_coverage"] == "no_interest"


def test_zero_debt_company_has_zero_de_and_flag() -> None:
    rows = [x for x in democo() if x.key != "bs.borrowings"] + [
        row("A", FY26, "bs.borrowings", 0.0)
    ]
    assert ratios(rows)["debt_equity"] == 0.0  # a known zero, not an unknown
    assert reasons(rows, "ratios").get("debt_equity") is None


def test_missing_inputs_give_reasons_not_zero() -> None:
    r, why = (
        ratios([row("A", FY26, "pnl.revenue", 100.0)]),
        reasons([row("A", FY26, "pnl.revenue", 100.0)], "ratios"),
    )
    for k in ("roe", "roce", "debt_equity", "cfo_to_pat", "fcf", "interest_coverage"):
        assert r[k] is None and k in why
    assert why["roe"] == "missing_input"


def test_roce_needs_prior_year_and_non_positive_capital_employed() -> None:
    no_prior = [x for x in democo() if x.period_end != FY25 or x.key == "pnl.revenue"]
    assert ratios(no_prior)["roce"] is None
    assert reasons(no_prior, "ratios")["roce"] == "no_prior_period"
    bad = [x for x in democo() if x.key != "bs.current_liabilities"]
    bad += [
        row("A", FY26, "bs.current_liabilities", 6000.0),
        row("A", FY25, "bs.current_liabilities", 6000.0),
    ]
    assert ratios(bad)["roce"] is None
    assert reasons(bad, "ratios")["roce"] == "n/m"


def test_cfo_to_pat_needs_positive_profit_and_avg_needs_three_years() -> None:
    rows = [x for x in democo() if x.key not in ("pnl.net_profit", "cf.cfo")]
    for end, np_, cfo in [
        (FY26, -10.0, 5.0),
        (FY25, 100.0, 80.0),
        (FY24, 100.0, 90.0),
        (FY23, 100.0, 110.0),
    ]:
        rows += [row("A", end, "pnl.net_profit", np_), row("A", end, "cf.cfo", cfo)]
    r, why = ratios(rows), reasons(rows, "ratios")
    assert r["cfo_to_pat"] is None and why["cfo_to_pat"] == "n/m"
    # the loss year drops out of the average: (0.8 + 0.9 + 1.1) / 3
    assert r["cfo_to_pat_avg"] == ap(0.933333, abs=1e-6)
    two = [x for x in rows if x.period_end in (FY26, FY25)]
    assert ratios(two)["cfo_to_pat_avg"] is None
    assert reasons(two, "ratios")["cfo_to_pat_avg"] == "insufficient_history"


def test_cagr_needs_exact_years_and_positive_ends() -> None:
    assert ratios(democo())["revenue_cagr_3y"] == ap(11.102645, abs=1e-6)
    gap = [x for x in democo() if not (x.key == "pnl.revenue" and x.period_end == FY23)]
    assert ratios(gap)["revenue_cagr_3y"] is None
    assert reasons(gap, "ratios")["revenue_cagr_3y"] == "insufficient_history"
    loss = [x for x in democo() if not (x.key == "pnl.revenue" and x.period_end == FY23)]
    loss.append(row("A", FY23, "pnl.revenue", -1.0))
    assert reasons(loss, "ratios")["revenue_cagr_3y"] == "n/m"


def test_fnd07_period_matching_tolerance_is_20_days() -> None:
    def growth(prior_end: date) -> float | None:
        rows = [
            row("A", prior_end, "pnl.revenue", 100.0),
            row("A", date(2026, 3, 31), "pnl.revenue", 150.0),
        ]
        return node(rows)["derived"]["revenue_yoy"][-1]  # type: ignore[no-any-return]

    assert growth(date(2025, 3, 31)) == ap(50.0)
    assert growth(date(2025, 4, 20)) == ap(50.0)  # +20 days: matches
    assert growth(date(2025, 3, 11)) == ap(50.0)  # -20 days: matches
    assert growth(date(2025, 4, 21)) is None  # +21 days: no match
    assert growth(date(2025, 3, 10)) is None  # -21 days: no match
    # previous quarter: 3 months back, 30 Jun -> 31 Mar (clamped month ends)
    qrows = [
        row("Q", date(2026, 3, 31), "pnl.revenue", 100.0),
        row("Q", date(2026, 6, 30), "pnl.revenue", 120.0),
    ]
    assert node(qrows, "Q")["derived"]["revenue_qoq"][-1] == ap(20.0)


def test_fnd01_fiscal_labels() -> None:
    assert fnd.fiscal_label(date(2026, 9, 30), "Q") == "Q2 FY27"
    assert fnd.fiscal_label(date(2026, 3, 31), "Q") == "Q4 FY26"
    assert fnd.fiscal_label(date(2026, 6, 30), "Q") == "Q1 FY27"
    assert fnd.fiscal_label(date(2026, 12, 31), "Q") == "Q3 FY27"
    assert fnd.fiscal_label(date(2026, 3, 31), "A") == "FY26"
    assert fnd.fiscal_label(date(2027, 3, 31), "A") == "FY27"


# --- TTM EPS ------------------------------------------------------------------------------------


def test_fnd08_missing_quarter_falls_back_to_latest_annual_then_null() -> None:
    missing = [x for x in democo() if not (x.period_type == "Q" and x.period_end == QUARTERS[1])]
    v = val(missing)
    assert v["pe_basis"] == "latest_annual"
    assert v["eps_ttm"] == ap(32.3)  # the annual EPS
    assert v["pe_ttm"] == ap(1800 / 32.3)
    none = [x for x in missing if x.key != "pnl.eps"]
    v2 = val(none)
    assert v2["pe_basis"] == "n/a" and v2["pe_ttm"] is None
    assert reasons(none, "valuation")["pe_ttm"] == "missing_input"


def test_ttm_needs_one_source_and_consecutive_quarters() -> None:
    mixed = [x for x in democo() if x.period_type != "Q"]
    for i, (e, v) in enumerate(zip(QUARTERS, QEPS, strict=True)):
        mixed.append(row("Q", e, "pnl.eps", v, source="manual" if i % 2 else "csv_import"))
    assert val(mixed)["pe_basis"] == "latest_annual"  # no single source has 4 quarters
    # a quarter 6 months after the previous one is not consecutive
    gap = [x for x in democo() if x.period_type != "Q"]
    for e, v in zip(
        [date(2025, 6, 30), date(2025, 12, 31), date(2026, 3, 31), date(2026, 6, 30)],
        QEPS,
        strict=True,
    ):
        gap.append(row("Q", e, "pnl.eps", v))
    assert val(gap)["pe_basis"] == "latest_annual"


def test_ttm_uses_latest_four_quarters() -> None:
    rows = democo() + [
        row("Q", date(2025, 3, 31), "pnl.eps", 100.0),
        row("Q", date(2026, 6, 30), "pnl.eps", 9.0),
    ]
    v = val(rows)
    assert v["eps_ttm"] == ap(8.0 + 8.2 + 8.6 + 9.0)
    assert v["eps_period_end"] == "2026-06-30"


# --- corporate-action adjustment (FND-09) --------------------------------------------------------


def test_fnd09_split_after_results_adjusts_eps_bvps_and_shares() -> None:
    # 1:5 split (face value 10 -> 2, multiplier 5) after FY26 results, before today
    split = [Multiplier(date(2026, 5, 4), 5.0)]
    v = val(democo(), multipliers=split)
    assert v["eps_ttm"] == ap(32.3 / 5)
    assert v["pe_ttm"] == ap(1800 / (32.3 / 5))
    assert v["bvps"] == ap(110.0 / 5)  # equity x 1e7 / shares, divided by the multiplier
    assert v["pb"] == ap(1800 / 22.0)
    assert v["market_cap_cr"] == ap(180000.0)  # 1800 x (2e8 x 5 post-split shares) / 1e7
    # a split between FY23 and FY26 divides only the FY23 EPS: (32.3 / (20 / 5))^(1/3) - 1
    mid = [Multiplier(date(2024, 6, 1), 5.0)]
    assert ratios(democo(), multipliers=mid)["eps_cagr_3y"] == ap(
        ((32.3 / (20.0 / 5)) ** (1 / 3) - 1) * 100, abs=1e-9
    )


def test_fnd09_action_before_period_or_after_today_is_ignored() -> None:
    before = [
        Multiplier(date(2026, 3, 31), 5.0)
    ]  # earlier quarters are divided, Q4 (period_end == ex_date) is not
    after = [Multiplier(date(2026, 11, 9), 5.0)]  # ex_date > as_of
    assert (
        val(democo(), multipliers=before)["eps_ttm"] == ap(8.6 + 8.2 + 8.0 + 7.5 / 1) or True
    )  # quarters before the ex_date are divided: checked exactly below
    q = val(democo(), multipliers=before)["eps_ttm"]
    assert q == ap(7.5 / 5 + 8.0 / 5 + 8.2 / 5 + 8.6)  # only Q4 (period_end == ex_date) stays
    assert val(democo(), multipliers=after)["eps_ttm"] == ap(32.3)


def test_dividend_yield_trailing_365_days_split_adjusted() -> None:
    divs = [
        fnd.Dividend(date(2026, 2, 1), 10.0),
        fnd.Dividend(date(2025, 12, 1), 8.0),
        fnd.Dividend(date(2025, 11, 6), 99.0),  # exactly 365 days before as_of: outside
        fnd.Dividend(date(2026, 11, 9), 50.0),  # after as_of: outside
    ]
    v = val(democo(), dividends=divs)
    assert v["div_yield"] == ap(18.0 / 1800 * 100)  # 1.0 %
    split = [Multiplier(date(2026, 1, 1), 2.0)]  # the 1 Dec dividend predates the split
    v2 = val(democo(), dividends=divs, multipliers=split)
    assert v2["div_yield"] == ap((10.0 + 8.0 / 2) / 1800 * 100)


# --- FND-14 market cap, P/B fallback ------------------------------------------------------------


def test_fnd14_missing_shares_nulls_market_cap_dependents_and_pb_falls_back() -> None:
    rows = [x for x in democo() if x.key != "bs.shares_outstanding"]
    v, why = val(rows), reasons(rows, "valuation")
    assert v["market_cap_cr"] is None and why["market_cap_cr"] == "missing_shares_outstanding"
    assert v["ev_ebitda"] is None and why["ev_ebitda"] == "missing_market_cap"
    assert v["pb"] is None and why["pb"] == "missing_input"
    v2 = val(rows, top_pb=(12.5, "screener_import"))
    assert v2["pb"] == ap(12.5) and v2["pb_source"] == "top_ratio (screener_import)"


def test_non_positive_ebitda_gives_null_ev_ebitda() -> None:
    rows = [x for x in democo() if x.key != "pnl.ebitda"] + [row("A", FY26, "pnl.ebitda", -5.0)]
    assert val(rows)["ev_ebitda"] is None
    assert reasons(rows, "valuation")["ev_ebitda"] == "n/m"


def test_peg_only_with_positive_eps_growth() -> None:
    down = [x for x in democo() if not (x.key == "pnl.eps" and x.period_type == "A")]
    down += [row("A", FY23, "pnl.eps", 40.0), row("A", FY26, "pnl.eps", 32.3)]
    assert val(down)["peg"] is None
    assert reasons(down, "valuation")["peg"] == "n/m"


# --- FND-10 financial companies -----------------------------------------------------------------


def test_fnd10_financial_company_gets_only_allowed_metrics() -> None:
    rows = democo() + [row("A", FY26, "pnl.nii", 300.0), row("A", FY25, "pnl.nii", 250.0)]
    res = build_fundamentals(inputs(rows, financial=True))
    n = res.tree[CON]["A"]
    assert n["derived"]["net_profit_yoy"][-1] == ap(18.965517, abs=1e-6)
    assert n["derived"]["nii_yoy"][-1] == ap(20.0)
    for k in ("revenue_yoy", "op_margin", "net_margin"):
        assert n["derived"][k] == [None] * 4
        assert set(n["null_reasons"]["derived"][k].values()) == {"not_applicable_financial"}
    r = n["ratios"]
    assert r["roe"] == ap(33.658537, abs=1e-6) and r["net_profit_cagr_3y"] is not None
    for k in ("roce", "debt_equity", "interest_coverage", "cfo_to_pat", "fcf", "revenue_cagr_3y"):
        assert r[k] is None and n["null_reasons"]["ratios"][k] == "not_applicable_financial"
    assert n["valuation"]["pe_ttm"] == ap(55.727554, abs=1e-6) and n["valuation"]["pb"] is not None
    for k in ("ev_ebitda", "peg", "pe_percentile_5y"):
        assert n["valuation"][k] is None
    assert res.quality["reason"] == "not_applicable_financial" and res.quality["score"] is None
    assert "roce" not in res.screener and "ev_ebitda" not in res.screener
    assert "roe" in res.screener and "pe" in res.screener and "profit_growth_3y" in res.screener


# --- FND-13 P/E percentile ----------------------------------------------------------------------


def weekdays(start: date, end: date) -> list[date]:
    out, d = [], start
    while d <= end:
        if d.weekday() < 5:
            out.append(d)
        d += timedelta(days=1)
    return out


def quarterly_eps(
    first: date, last: date, eps: float, filed_lag: int | None = None
) -> list[FundRow]:
    out: list[FundRow] = []
    e = first
    while e <= last:
        filed = None if filed_lag is None else e + timedelta(days=filed_lag)
        out.append(row("Q", e, "pnl.eps", eps, filed=filed))
        e = fnd.shift_months(e, 3)
        e = e.replace(day=calendar.monthrange(e.year, e.month)[1])  # month ends, no drift
    return out


def pe_inputs(today_close: float | None = None, first_q: date = date(2019, 6, 30)) -> FundInputs:
    days = weekdays(date(2020, 1, 1), AS_OF)
    close = np.arange(1, len(days) + 1, dtype=np.float64)  # 1 .. 1788
    return FundInputs(
        rows=quarterly_eps(first_q, date(2026, 9, 30), 2.5),  # TTM EPS 10 throughout
        as_of=AS_OF,
        close=float(close[-1]) if today_close is None else today_close,
        price_dates=days,
        price_close=close,
    )


def test_fnd13_percentile_top_and_middle_known_answers() -> None:
    # 1305 trading days in (2021-11-06, 2026-11-06]; pe_t = close_t / 10
    top = build_fundamentals(pe_inputs()).tree[CON]["A"]["valuation"]
    assert top["pe_percentile_points"] == 1305
    assert top["pe_ttm"] == ap(178.8)
    # today's own bar ties with itself: (1304 + 0.5) / 1305
    assert top["pe_percentile_5y"] == ap((1304 + 0.5) / 1305 * 100, abs=1e-9)
    mid = build_fundamentals(pe_inputs(today_close=894.5)).tree[CON]["A"]["valuation"]
    assert mid["pe_ttm"] == ap(89.45)
    assert mid["pe_percentile_5y"] == ap(411 / 1305 * 100, abs=1e-9)  # closes 484..894 are below
    assert 0 <= mid["pe_percentile_5y"] <= 100  # a percent number (F07R-8), not a fraction


def test_fnd13_fewer_than_750_points_is_insufficient_history() -> None:
    res = build_fundamentals(pe_inputs(first_q=date(2024, 6, 30)))  # EPS only from late 2025
    n = res.tree[CON]["A"]
    assert n["valuation"]["pe_percentile_5y"] is None
    assert n["null_reasons"]["valuation"]["pe_percentile_5y"] == "insufficient_history"
    assert n["valuation"]["pe_ttm"] is not None  # today's P/E itself is fine


def test_fnd13_eps_is_available_from_filed_on_or_45_days_after_period_end() -> None:
    days = weekdays(date(2020, 1, 1), AS_OF)
    close = np.full(len(days), 100.0)

    def points(rows: list[FundRow]) -> int:
        res = build_fundamentals(
            FundInputs(rows=rows, as_of=AS_OF, close=100.0, price_dates=days, price_close=close)
        )
        return int(res.tree[CON]["A"]["valuation"]["pe_percentile_points"])

    assert points(quarterly_eps(date(2019, 6, 30), date(2026, 9, 30), 2.5)) == 1305
    # results public 400 days after period end: the first TTM window (ends 2020-03-31) is
    # available from 2021-05-05, before the 5Y window starts, so every day has EPS
    assert points(quarterly_eps(date(2019, 6, 30), date(2026, 9, 30), 2.5, filed_lag=400)) == 1305
    # filed 900 days late: the first window is available only from 2022-09-17, so the days of
    # the 5Y window before that have no EPS and are not counted (no look-ahead)
    late = quarterly_eps(date(2019, 6, 30), date(2026, 9, 30), 2.5, filed_lag=900)
    first_available = date(2020, 3, 31) + timedelta(days=900)
    expected = sum(1 for d in days if d > date(2021, 11, 6) and d >= first_available)
    assert points(late) == expected < 1305


def test_fnd13_percentile_ties_take_the_average_rank() -> None:
    from worker.analytics.scores import percentile_in_universe, percentile_of

    assert percentile_of(5.0, [5.0, 5.0, 5.0, 5.0]) == 50.0
    assert percentile_of(1.0, [2.0, 3.0]) == 0.0 and percentile_of(9.0, [2.0, 3.0]) == 100.0
    assert percentile_of(1.0, []) is None
    assert percentile_in_universe(5.0, [5.0, 5.0, 5.0]) == 50.0
    assert percentile_in_universe(1.0, [1.0, 2.0, 3.0]) == 0.0
    assert percentile_in_universe(3.0, [1.0, 2.0, 3.0]) == 100.0
    assert percentile_in_universe(1.0, [1.0]) is None


# --- basis, sources, units, nulls (B05) ----------------------------------------------------------


def test_fnd81_consolidated_preferred_and_each_basis_gets_its_own_tree() -> None:
    rows = democo(CON) + [x for x in democo(STA) if x.period_type == "A" and x.key == "pnl.revenue"]
    res = build_fundamentals(inputs(rows))
    assert set(res.tree) == {CON, STA}
    assert res.auto_basis == CON
    assert res.tree[STA]["A"]["ratios"]["roe"] is None  # standalone never borrows consolidated data
    only_standalone = build_fundamentals(inputs(democo(STA)))
    assert only_standalone.auto_basis == STA and set(only_standalone.tree) == {STA}
    assert only_standalone.screener["roe"] == ap(33.658537, abs=1e-6)


def test_fnd82_source_priority_null_values_and_restated_periods() -> None:
    rows = democo()
    rows.append(row("A", FY26, "pnl.net_profit", 700.0, source="manual"))  # manual wins
    rows.append(row("A", FY26, "pnl.net_profit", 111.0, source="screener_import"))
    rows.append(row("A", FY26, "pnl.revenue", None, source="manual"))  # NULL never wins
    n = node(rows)
    assert n["derived"]["net_margin"][-1] == ap(700 / 4800 * 100)
    assert n["derived"]["op_margin"][-1] == ap(23.333333, abs=1e-6)
    # a restated value entered later by the same source wins
    later = T0 + timedelta(days=1)
    rows.append(row("A", FY26, "pnl.net_profit", 720.0, source="manual", fetched=later))
    assert node(rows)["derived"]["net_margin"][-1] == ap(720 / 4800 * 100)
    # derived rows are never used as inputs
    rows.append(row("A", FY26, "pnl.net_profit", 5.0, source="derived", fetched=later))
    assert node(rows)["derived"]["net_margin"][-1] == ap(720 / 4800 * 100)


def test_fnd83_mixed_units_are_dropped_with_a_warning_not_used() -> None:
    rows = [x for x in democo() if x.key != "pnl.net_profit" or x.period_end != FY26]
    rows.append(row("A", FY26, "pnl.net_profit", 6.9e9, unit="INR"))  # rupees, not crore
    n = node(rows)
    assert "UNIT_MISMATCH:pnl.net_profit" in n["warnings"]
    assert n["derived"]["net_margin"][-1] is None  # the rupee value never reaches the formula
    # ROE falls back to the latest period that has both inputs, and says which one it used
    assert node(rows)["ratio_meta"]["ratio_period"]["roe"] == "2025-03-31"
    eps_bad = [
        row("Q", e, "pnl.eps", v, unit="INR_CR") for e, v in zip(QUARTERS, QEPS, strict=True)
    ]
    assert val(eps_bad)["pe_basis"] == "n/a"


def test_fnd84_partial_history_two_quarters() -> None:
    rows = [
        row("Q", QUARTERS[2], "pnl.revenue", 100.0),
        row("Q", QUARTERS[3], "pnl.revenue", 110.0),
    ]
    n = node(rows, "Q")
    assert n["periods"] == ["2025-12-31", "2026-03-31"]
    assert n["derived"]["revenue_yoy"] == [None, None]  # FND-12: tables render, growth null
    assert n["derived"]["revenue_qoq"] == [None, ap(10.0)]


def test_fnd85_no_owner_data_gives_empty_tree_and_no_data_entered() -> None:
    res = build_fundamentals(inputs([]))
    assert res.tree == {} and res.screener == {}
    assert res.quality["score"] is None and res.quality["reason"] == "no_data_entered"
    assert res.auto_basis is None and res.inputs_fetched_at is None


def test_fnd86_inputs_fetched_at_is_the_newest_entry() -> None:
    rows = democo() + [row("A", FY26, "cf.cfo", 800.0, fetched=T0 + timedelta(days=3))]
    assert build_fundamentals(inputs(rows)).inputs_fetched_at == T0 + timedelta(days=3)


def test_fnd87_nothing_non_finite_reaches_json() -> None:
    rows = democo() + [
        row("A", FY26, "pnl.revenue", float("nan")),
        row("A", FY25, "pnl.net_profit", float("inf")),
        row("Q", QUARTERS[0], "pnl.eps", float("-inf")),
    ]
    res = build_fundamentals(inputs(rows, close=float("nan")))
    json.dumps(res.tree, allow_nan=False)
    json.dumps([res.screener, res.quality], allow_nan=False)
    assert val(rows, close=float("nan"))["pe_ttm"] is None
    json.dumps(build_fundamentals(pe_inputs()).tree, allow_nan=False)


def test_fnd88_zero_revenue_margin_is_n_m_not_inf() -> None:
    rows = [row("A", FY26, "pnl.revenue", 0.0), row("A", FY26, "pnl.net_profit", 5.0)]
    n = node(rows)
    assert n["derived"]["net_margin"] == [None]
    assert n["null_reasons"]["derived"]["net_margin"]["2026-03-31"] == "n/m"


def test_fnd89_screener_keys_come_from_the_auto_basis() -> None:
    res = build_fundamentals(inputs(democo(), close=1800.0))
    s = res.screener
    assert s["pe"] == ap(55.727554, abs=1e-6) and s["pb"] == ap(16.363636, abs=1e-6)
    assert s["market_cap_cr"] == ap(36000.0) and s["ev_ebitda"] == ap(29.0)
    assert s["roe"] == ap(33.658537, abs=1e-6) and s["debt_equity"] == ap(0.272727, abs=1e-6)
    assert s["op_margin"] == ap(23.333333, abs=1e-6) and s["net_margin"] == ap(14.375)
    assert s["rev_growth_1y"] == ap(9.090909, abs=1e-6)  # latest annual YoY
    assert s["rev_growth_3y"] == ap(11.102645, abs=1e-6)  # 3-year CAGR
    assert s["profit_growth_3y"] == ap(19.930515, abs=1e-6)
    assert "rev_growth_5y" not in s and "div_yield" not in s  # unknown: absent, never 0
    assert all(k in fnd.FUNDAMENTAL_SCREENER_KEYS for k in s)


# --- SHP-02..04 ---------------------------------------------------------------------------------


def h(q: date, **kw: float | None) -> HoldingRow:
    base: dict[str, float | None] = dict(
        promoter_pct=None, fii_pct=None, dii_pct=None, mf_pct=None, promoter_pledged_pct=None
    )
    base.update(kw)
    return HoldingRow(q, **base)  # type: ignore[arg-type]


def test_shp02_unknown_pledge_is_absent_and_zero_is_kept() -> None:
    m, _ = fnd.shareholding_metrics([h(date(2026, 9, 30), promoter_pct=50.0)])
    assert "promoter_pledged_pct" not in m
    m0, _ = fnd.shareholding_metrics(
        [h(date(2026, 9, 30), promoter_pct=50.0, promoter_pledged_pct=0.0)]
    )
    assert m0["promoter_pledged_pct"] == 0.0


def test_shp03_no_promoter_still_reports_the_other_holders() -> None:
    m, change = fnd.shareholding_metrics([h(date(2026, 9, 30), fii_pct=20.0, dii_pct=10.0)])
    assert m == {"fii_pct": 20.0, "dii_pct": 10.0} and change is None


def test_shp04_single_quarter_has_no_qoq_and_two_quarters_do() -> None:
    one, _ = fnd.shareholding_metrics([h(date(2026, 9, 30), fii_pct=20.0, mf_pct=5.0)])
    assert "fii_change_qoq" not in one and "mf_change_qoq" not in one
    two, _ = fnd.shareholding_metrics(
        [
            h(date(2026, 6, 30), fii_pct=18.5, mf_pct=5.5),
            h(date(2026, 9, 30), fii_pct=20.0, mf_pct=5.0),
        ]
    )
    assert two["fii_change_qoq"] == ap(1.5) and two["mf_change_qoq"] == ap(-0.5)
    gap, _ = fnd.shareholding_metrics(  # a missing quarter in between: no multi-quarter QoQ (B05-7)
        [h(date(2026, 3, 31), fii_pct=18.5), h(date(2026, 9, 30), fii_pct=20.0)]
    )
    assert "fii_change_qoq" not in gap
    missing_mf, _ = fnd.shareholding_metrics(
        [h(date(2026, 6, 30), mf_pct=None), h(date(2026, 9, 30), mf_pct=5.0)]
    )
    assert "mf_change_qoq" not in missing_mf and missing_mf["mf_pct"] == 5.0


def test_promoter_change_over_one_year_feeds_quality() -> None:
    rows = [
        h(date(2025, 9, 30), promoter_pct=55.0),
        h(date(2026, 6, 30), promoter_pct=52.0),
        h(date(2026, 9, 30), promoter_pct=51.0, promoter_pledged_pct=15.0),
    ]
    _, change = fnd.shareholding_metrics(rows)
    assert change == ap(-4.0)
    res = build_fundamentals(inputs(democo(), holdings=rows))
    comps = {c["key"]: c for c in res.quality["components"]}
    assert comps["promoter_change_1y"]["score"] == ap(20.0)  # (-4 + 5) / 5 x 100
    assert comps["promoter_pledged_pct"]["score"] == ap(50.0)  # 15 on 30 -> 0, 0 -> 100
    assert res.screener["promoter_pledged_pct"] == 15.0
