"""Scores (docs/05 section 6): trend, risk and quality, each with components and coverage (D05b).

Pure functions. A score is ``None`` with a ``reason`` when it cannot be computed; the components
are always listed so the UI can show what was and was not available.
"""

from __future__ import annotations

import math
from collections.abc import Hashable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, TypeVar

K = TypeVar("K", bound=Hashable)

TREND_MIN_BARS = 200
RISK_MIN_BARS = 252
RISK_MIN_UNIVERSE = 20
RISK_MIN_COMPONENTS = 3
QUALITY_MIN_COVERAGE = 0.6

# (key, label, weight, anchor_low -> 0, anchor_high -> 100); lower-is-better has low > high.
QUALITY_COMPONENTS: tuple[tuple[str, str, float, float, float], ...] = (
    ("roe", "ROE", 15.0, 5.0, 25.0),
    ("roce", "ROCE", 10.0, 8.0, 30.0),
    ("revenue_cagr_3y", "Revenue CAGR 3Y", 12.5, 0.0, 20.0),
    ("net_profit_cagr_3y", "Net profit CAGR 3Y", 12.5, 0.0, 25.0),
    ("debt_equity", "Debt/Equity (lower is better)", 10.0, 2.0, 0.1),
    ("interest_coverage", "Interest coverage", 10.0, 1.5, 8.0),
    ("cfo_to_pat_avg", "CFO/PAT 5Y average", 15.0, 0.3, 1.0),
    ("promoter_pledged_pct", "Promoter pledge % (lower is better)", 10.0, 30.0, 0.0),
    ("promoter_change_1y", "Promoter holding change 1Y (points)", 5.0, -5.0, 0.0),
)

RISK_WEIGHTS: tuple[tuple[str, str, float], ...] = (
    ("vol_252", "Volatility 252d", 0.35),
    ("maxdd_3y", "Max drawdown 3Y (absolute)", 0.25),
    ("beta_252", "Beta 252d (negative counted as 0)", 0.20),
    ("illiquidity", "Illiquidity (100 - percentile of 60-day traded value)", 0.20),
)


def _num(v: Any) -> float | None:
    """JSON-safe float: None, non-numbers, NaN and inf become None."""
    if v is None or isinstance(v, bool):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def interpolate(x: float, anchor_low: float, anchor_high: float) -> float:
    """Linear 0..100 between the anchors, clipped (works for lower-is-better anchors)."""
    return min(100.0, max(0.0, (x - anchor_low) / (anchor_high - anchor_low) * 100.0))


def percentile_in_universe(value: float, population: Sequence[float]) -> float | None:
    """Percentile rank (0-100) of ``value`` among ``population`` that contains it.

    ``(below + 0.5 * other_equal) / (n - 1) * 100``: the lowest value is 0, the highest 100, ties
    share the average rank (D05b-4). ``None`` when the population has fewer than 2 values.
    """
    n = len(population)
    if n < 2:
        return None
    below = sum(1 for p in population if p < value)
    equal = sum(1 for p in population if p == value) - 1
    return (below + 0.5 * equal) / (n - 1) * 100.0


def percentile_of(value: float, population: Sequence[float]) -> float | None:
    """Percentile of ``value`` among ``population`` that does not contain it (the P/E history).

    ``(below + 0.5 * equal) / n * 100``; ``None`` for an empty population.
    """
    n = len(population)
    if n == 0:
        return None
    below = sum(1 for p in population if p < value)
    equal = sum(1 for p in population if p == value)
    return (below + 0.5 * equal) / n * 100.0


# --- 6.1 trend ----------------------------------------------------------------------------------


def trend_label(score: int) -> str:
    if score <= 20:
        return "strong_down"
    if score <= 40:
        return "down"
    if score <= 60:
        return "sideways"
    if score <= 80:
        return "up"
    return "strong_up"


def trend_score(snap: Mapping[str, Any]) -> dict[str, Any]:
    """docs/05 6.1 from a price snapshot (``build_snapshot`` output)."""
    bars = int(snap.get("bars", 0))
    if bars < TREND_MIN_BARS:
        return {
            "score": None,
            "label": None,
            "reason": "insufficient_history",
            "coverage": 0.0,
            "components": [],
        }
    t = snap["technicals"]
    trading = snap["returns"]["trading"]
    close = _num(snap.get("last_close"))
    sma50, sma200 = _num(t.get("sma50")), _num(t.get("sma200"))
    adx, plus_di, minus_di = (
        _num(t.get("adx14")),
        _num(t.get("plus_di14")),
        _num(t.get("minus_di14")),
    )
    hist = _num(t.get("macd_hist"))
    ret21, ret126 = _num(trading.get("ret_1m")), _num(trading.get("ret_6m"))

    def gt(a: float | None, b: float | None) -> bool | None:
        return None if a is None or b is None else a > b

    adx_ok: bool | None
    if adx is None or plus_di is None or minus_di is None:
        adx_ok = None
    else:
        adx_ok = adx > 20 and plus_di > minus_di
    specs: list[tuple[str, str, int, bool | None, float | None]] = [
        ("close_gt_sma50", "Close above SMA50", 20, gt(close, sma50), close),
        ("close_gt_sma200", "Close above SMA200", 20, gt(close, sma200), close),
        ("sma50_gt_sma200", "SMA50 above SMA200", 20, gt(sma50, sma200), sma50),
        ("ret_21_gt_0", "21-day return above 0", 10, gt(ret21, 0.0), ret21),
        ("ret_126_gt_0", "126-day return above 0", 10, gt(ret126, 0.0), ret126),
        ("adx_trend", "ADX14 above 20 and +DI above -DI", 10, adx_ok, adx),
        ("macd_hist_gt_0", "MACD histogram above 0", 10, gt(hist, 0.0), hist),
    ]
    components = [
        {
            "key": k,
            "label": label,
            "max_points": mx,
            "points": mx if met else 0,
            "met": met,  # None = the input was unknown (counted as 0 points)
            "value": v,
        }
        for k, label, mx, met, v in specs
    ]
    score = sum(mx if met else 0 for _, _, mx, met, _ in specs)
    return {
        "score": score,
        "label": trend_label(score),
        "reason": None,
        "coverage": 1.0,
        "components": components,
    }


# --- 6.2 risk -----------------------------------------------------------------------------------


@dataclass(frozen=True)
class RiskInput:
    bars: int
    vol_252: float | None
    maxdd_3y: float | None
    beta_252: float | None
    adv_value_60_cr: float | None


def risk_label(score: float) -> str:
    if score < 33:
        return "low"
    if score <= 66:
        return "medium"
    return "high"


def _risk_values(r: RiskInput) -> dict[str, float | None]:
    dd, beta = _num(r.maxdd_3y), _num(r.beta_252)
    return {
        "vol_252": _num(r.vol_252),
        "maxdd_3y": None if dd is None else abs(dd),
        "beta_252": None if beta is None else max(beta, 0.0),
        "illiquidity": _num(r.adv_value_60_cr),  # ranked on traded value, then inverted
    }


def _null_risk(reason: str, universe: int) -> dict[str, Any]:
    return {
        "score": None,
        "label": None,
        "reason": reason,
        "coverage": 0.0,
        "components": [],
        "universe_size": universe,
    }


def risk_scores(universe: Mapping[K, RiskInput]) -> dict[K, dict[str, Any]]:
    """docs/05 6.2 for every stock of the universe (percentiles are relative to this universe)."""
    eligible = {k: r for k, r in universe.items() if r.bars >= RISK_MIN_BARS}
    out: dict[K, dict[str, Any]] = {}
    for k in universe:
        if k not in eligible:
            out[k] = _null_risk("insufficient_history", len(eligible))
    if len(eligible) < RISK_MIN_UNIVERSE:
        for k in eligible:
            out[k] = _null_risk("universe_too_small", len(eligible))
        return out
    values = {k: _risk_values(r) for k, r in eligible.items()}
    pops = {
        comp: [x for x in (v[comp] for v in values.values()) if x is not None]
        for comp, _, _ in RISK_WEIGHTS
    }
    for k, v in values.items():
        comps: list[dict[str, Any]] = []
        used = 0.0
        acc = 0.0
        for comp, label, weight in RISK_WEIGHTS:
            x = v[comp]
            pct = None if x is None else percentile_in_universe(x, pops[comp])
            contrib = None if pct is None else (100.0 - pct if comp == "illiquidity" else pct)
            comps.append(
                {
                    "key": comp,
                    "label": label,
                    "value": x,
                    "percentile": contrib,
                    "weight": weight,
                    "available": contrib is not None,
                }
            )
            if contrib is not None:
                used += weight
                acc += weight * contrib
        n_avail = sum(1 for c in comps if c["available"])
        if n_avail < RISK_MIN_COMPONENTS:
            res = _null_risk("insufficient_data", len(eligible))
            res["components"] = comps
            res["coverage"] = round(used, 6)
            out[k] = res
            continue
        score = acc / used
        out[k] = {
            "score": score,
            "label": risk_label(score),
            "reason": None,
            "coverage": round(used, 6),
            "components": comps,
            "universe_size": len(eligible),
        }
    return out


# --- 6.3 quality --------------------------------------------------------------------------------


def quality_score(
    values: Mapping[str, float | None], *, financial: bool, no_debt: bool
) -> dict[str, Any]:
    """docs/05 6.3. ``values`` maps component keys to the metric value (None = unknown).

    A company without borrowings skips the interest-coverage component; its D/E component is
    100 even when equity is not positive (the ratio itself is then null).
    """
    if financial:
        return {
            "score": None,
            "label": None,
            "reason": "not_applicable_financial",
            "coverage": 0.0,
            "components": [],
        }
    comps: list[dict[str, Any]] = []
    used = 0.0
    acc = 0.0
    for key, label, weight, lo, hi in QUALITY_COMPONENTS:
        x = _num(values.get(key))
        skipped = key == "interest_coverage" and no_debt
        if skipped:
            score = None
        elif key == "debt_equity" and no_debt:
            score = 100.0  # docs/05 6.3: no debt -> D/E component 100, even if equity <= 0
        else:
            score = None if x is None else interpolate(x, lo, hi)
        comps.append(
            {
                "key": key,
                "label": label,
                "value": x,
                "weight": weight,
                "score": score,
                "available": score is not None,
                "anchors": [lo, hi],
            }
        )
        if score is not None:
            used += weight
            acc += weight * score
    coverage = used / 100.0
    if coverage < QUALITY_MIN_COVERAGE:
        return {
            "score": None,
            "label": None,
            "reason": "insufficient_data",
            "coverage": coverage,
            "components": comps,
        }
    return {
        "score": acc / used,
        "label": None,
        "reason": None,
        "coverage": coverage,
        "components": comps,
    }
