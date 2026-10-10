#!/usr/bin/env python3
"""Spike S16 (docs/08), part that needs no owner data: known-answer checks of the docs/05 section 5
formulas on a FICTIONAL company ("DEMOCO", numbers authored here, INR crore unless stated).

The real S16 compares computed ratios with a company's published ratios; that needs the owner's
figures and is recorded as BLOCKED-OWNER in docs/SPIKE_RESULTS.md. This script proves the
formulas as written are internally consistent, shows the null rules, and quantifies how much the
choice of definition alone (average vs ending equity) moves a ratio, which is what the +/-2%
criterion will be fighting.

Usage: python scripts/spikes/s16_ratio_checks.py   (exit 1 on any mismatch)
"""

from __future__ import annotations

import sys
from decimal import Decimal as D

# ---- spec formulas (docs/05 section 5), Decimal, None = null ----------------------------------


def roe(np_: D, eq_t: D, eq_prev: D | None) -> tuple[D | None, str]:
    if eq_t <= 0:
        return None, "n/m"
    if eq_prev is None or eq_prev <= 0:
        return np_ / eq_t * 100, "ending"
    return np_ / ((eq_t + eq_prev) / 2) * 100, "average"


def roce(ebit: D, ce_t: D, ce_prev: D) -> D | None:
    avg = (ce_t + ce_prev) / 2
    return None if avg <= 0 else ebit / avg * 100


def debt_equity(borrowings: D, equity: D) -> D | None:
    return None if equity <= 0 else borrowings / equity


def interest_coverage(ebit: D, interest: D | None) -> D | None:
    return None if not interest else ebit / interest


def cagr(end: D, start: D, years: int) -> D | None:
    if end <= 0 or start <= 0:
        return None
    return ((end / start) ** (D(1) / D(years)) - 1) * 100


def growth(x: D, prev: D | None) -> D | None:
    return None if prev is None or prev <= 0 else (x / prev - 1) * 100


FAILS: list[str] = []


def check(name: str, got: D | None, want: str | None, tol: str = "0.0001") -> None:
    if want is None:
        ok = got is None
    else:
        ok = got is not None and abs(got - D(want)) <= D(tol)
    print(f"{'ok  ' if ok else 'FAIL'} {name}: got {got if got is None else round(got, 6)} want {want}")
    if not ok:
        FAILS.append(name)


# FY26 inputs
net_profit, pbt, interest, ebitda, revenue, op_income = D(690), D(920), D(80), D(1250), D(4800), D(1120)
equity_t, equity_prev = D(2200), D(1900)
assets_t, curliab_t, assets_prev, curliab_prev = D(5200), D(900), D(4600), D(800)
borrowings, cash, shares = D(600), D(350), D(200_000_000)
cfo = D(800)
ebit = pbt + interest  # docs/05: ebit = pbt + interest
close = D(1800)
quarter_eps = [D("8.6"), D("8.2"), D("8.0"), D("7.5")]

check("ebit", ebit, "1000")
r, basis = roe(net_profit, equity_t, equity_prev)
check("ROE average equity %", r, "33.658537", "0.000001")  # 690 / 2050
assert basis == "average"
check("ROCE %", roce(ebit, assets_t - curliab_t, assets_prev - curliab_prev), "24.691358", "0.000001")  # 1000 / 4050
check("debt/equity", debt_equity(borrowings, equity_t), "0.272727", "0.000001")
check("interest coverage", interest_coverage(ebit, interest), "12.5")
check("operating margin %", op_income / revenue * 100, "23.333333", "0.000001")
check("net margin %", net_profit / revenue * 100, "14.375")
check("cfo_to_pat", cfo / net_profit, "1.159420", "0.000001")
check("3y revenue CAGR % (3500 -> 4800)", cagr(D(4800), D(3500), 3), "11.102645", "0.000001")  # 1.11102645 ** 3 = 1.371429 = 4800/3500
ttm = sum(quarter_eps)
check("TTM EPS", ttm, "32.3")
check("PE", close / ttm, "55.727554", "0.000001")
bvps = equity_t * D(10_000_000) / shares  # crore -> INR
check("BVPS (INR)", bvps, "110")
check("PB", close / bvps, "16.363636", "0.000001")
mcap = close * shares / D(10_000_000)
check("market cap (INR cr)", mcap, "36000")
check("EV/EBITDA", (mcap + borrowings - cash) / ebitda, "29")

# null rules
check("ROE with equity <= 0", roe(net_profit, D(-5), equity_prev)[0], None)
r2, b2 = roe(net_profit, equity_t, None)
check("ROE prior equity missing -> ending basis", r2, "31.363636", "0.000001")
assert b2 == "ending"
check("interest coverage with interest 0", interest_coverage(ebit, D(0)), None)
check("interest coverage with interest missing", interest_coverage(ebit, None), None)
check("YoY growth with non-positive base", growth(D(100), D(-20)), None)
check("CAGR with non-positive start", cagr(D(100), D(0), 3), None)
check("D/E with equity 0", debt_equity(borrowings, D(0)), None)

# definition sensitivity: how far does average vs ending equity move ROE?
ending = net_profit / equity_t * 100
avg = r
rel = abs(ending - avg) / avg * 100
print(f"info ROE ending {round(ending, 3)} vs average {round(avg, 3)}: {round(rel, 2)}% relative difference from definition alone")
if rel <= 2:
    print("warn: definition difference is within the 2% criterion; the check would not expose it")

if FAILS:
    print("FAILED:", FAILS)
    sys.exit(1)
print("all checks passed")
