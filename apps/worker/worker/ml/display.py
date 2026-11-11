"""Per-stock display rules, buckets, band conversion and outcome resolution
(docs/05 10.6, 10.7; docs/03 section 6). Pure functions; the clock and the holiday set are
arguments so tests never depend on the wall clock."""

from __future__ import annotations

import math
from collections.abc import Collection
from dataclasses import dataclass
from datetime import date, timedelta

MIN_BARS = 504
MIN_ADV_CR = 0.5
ACTION_WINDOW_TD = 5
FRESH_TD = 3

# docs/03 section 6 enum
NOT_BETTER = "model_not_better_than_baseline"
INSUFFICIENT_HISTORY = "insufficient_history"
LOW_LIQUIDITY = "low_liquidity"
NEAR_ACTION = "near_corporate_action"
NO_MODEL = "no_model"
STALE = "stale_data"


def is_trading_day(d: date, holidays: Collection[date]) -> bool:
    return d.weekday() < 5 and d not in holidays


def trading_days_between(a: date, b: date, holidays: Collection[date]) -> int:
    """Trading days in the half-open interval ``(a, b]``; 0 when ``b <= a``."""
    n = 0
    d = a
    while d < b:
        d += timedelta(days=1)
        if is_trading_day(d, holidays):
            n += 1
    return n


def last_trading_day(on_or_before: date, holidays: Collection[date]) -> date:
    d = on_or_before
    while not is_trading_day(d, holidays):
        d -= timedelta(days=1)
    return d


@dataclass(frozen=True)
class DisplayInput:
    bars: int
    adv_value_cr: float | None
    last_bar: date
    as_of: date  # the prediction's date (the last bar used)
    today: date  # IST date of the run
    holidays: frozenset[date]
    action_dates: tuple[date, ...]  # ex-dates of detected/confirmed actions (not rejected)
    unconfirmed_action: bool
    model_state: str  # active_pass | gated | none


def hidden_reason(inp: DisplayInput) -> str | None:
    """The first failing rule in the order of docs/05 10.6, else ``None`` (shown)."""
    if inp.bars < MIN_BARS:
        return INSUFFICIENT_HISTORY
    if inp.adv_value_cr is None or not math.isfinite(inp.adv_value_cr):
        return LOW_LIQUIDITY
    if inp.adv_value_cr < MIN_ADV_CR:
        return LOW_LIQUIDITY
    if inp.unconfirmed_action or _near_action(inp):
        return NEAR_ACTION
    expected = last_trading_day(inp.today, inp.holidays)
    if trading_days_between(inp.last_bar, expected, inp.holidays) > FRESH_TD:
        return STALE
    if inp.model_state == "none":
        return NO_MODEL
    if inp.model_state != "active_pass":
        return NOT_BETTER
    return None


def stock_level_reason(inp: DisplayInput) -> str | None:
    """Reasons that depend on the stock rather than the model (no p_up is stored for them)."""
    reason = hidden_reason(inp)
    return None if reason in (None, NO_MODEL, NOT_BETTER) else reason


def _near_action(inp: DisplayInput) -> bool:
    for ex in inp.action_dates:
        if ex <= inp.as_of:
            near = trading_days_between(ex, inp.as_of, inp.holidays) <= ACTION_WINDOW_TD
        else:
            near = trading_days_between(inp.as_of, ex, inp.holidays) <= ACTION_WINDOW_TD
        if near:
            return True
    return False


def bucket(p_up: float) -> str:
    """docs/03 section 6: <0.40, 0.40-0.47, 0.47-0.53, 0.53-0.60, >0.60."""
    if p_up < 0.40:
        return "strongly_down"
    if p_up < 0.47:
        return "slightly_down"
    if p_up <= 0.53:
        return "neutral"
    if p_up <= 0.60:
        return "slightly_up"
    return "strongly_up"


def band_returns(sigma: float, h: int, z_q: tuple[float, float, float]) -> tuple[float, ...]:
    """Volatility-scaled band back to simple-return fractions: ``exp(sigma*sqrt(h)*q_z) - 1``
    (the model works in log returns; realized returns are simple, docs/05 10.7)."""
    scale = sigma * math.sqrt(h)
    return tuple(math.expm1(scale * q) for q in z_q)


@dataclass(frozen=True)
class Outcome:
    realized_return: float
    direction_correct: bool | None
    in_band: bool | None


def resolve_outcome(
    *,
    ref_close: float,
    later_close: float,
    p_up: float | None,
    q10: float | None,
    q90: float | None,
) -> Outcome:
    """docs/05 10.7: ``realized = C_{t+h}/C_t - 1``; ``direction_correct = (realized > 0) ==
    (p_up >= 0.5)``; ``in_band = q10 <= realized <= q90``. Unknown inputs give ``None``."""
    realized = later_close / ref_close - 1.0
    correct = None if p_up is None else (realized > 0) == (p_up >= 0.5)
    in_band = None if q10 is None or q90 is None else q10 <= realized <= q90
    return Outcome(realized, correct, in_band)
