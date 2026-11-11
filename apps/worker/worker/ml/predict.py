"""Turns the latest feature rows into prediction rows with the per-stock display rules
(docs/05 10.6). Pure: models, calendar and clock are arguments."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import date

import numpy as np

from worker.ml import display as dp
from worker.ml.features import Panel
from worker.ml.models import ScoringModel

UNIVERSE_MIN_BARS = 750  # docs/05 10.1: the training/ranking universe


@dataclass(frozen=True)
class StockInfo:
    symbol: str
    instrument_id: int
    bars: int
    last_bar: date
    ref_close: float  # adj_close at the last bar
    adv_value_cr: float | None
    action_dates: tuple[date, ...]
    unconfirmed_action: bool


@dataclass(frozen=True)
class PredRow:
    symbol: str
    instrument_id: int
    horizon: int
    as_of: date
    ref_close: float
    p_up: float | None
    ret_q10: float | None
    ret_q50: float | None
    ret_q90: float | None
    shown: bool
    hidden_reason: str | None


def build_predictions(
    panel: Panel,
    stocks: Mapping[str, StockInfo],
    models: Mapping[int, ScoringModel | None],
    model_state: Mapping[int, str],
    *,
    today: date,
    holidays: frozenset[date],
) -> list[PredRow]:
    """One row per (stock, horizon). ``model_state[h]`` is ``active_pass``, ``gated`` (an active
    model whose guardrail is off: values are stored for tracking, never shown), ``failed``
    (only a failing candidate exists) or ``none``."""
    sym_index = {s: i for i, s in enumerate(panel.symbols)}
    rows: list[PredRow] = []
    for h, state in sorted(model_state.items()):
        if state == "none":
            continue  # no model_run to reference; the API reports `no_model`
        model = models.get(h)
        usable = (
            model is not None
            and model.names == panel.names
            and state
            in (
                "active_pass",
                "gated",
            )
        )
        eff_state = state if usable else ("failed" if state != "active_pass" else "none")
        for info in stocks.values():
            si = sym_index.get(info.symbol)
            pos: int | None = None
            if si is not None:
                hit = np.flatnonzero((panel.stock == si) & (panel.row_in_stock == info.bars - 1))
                pos = int(hit[0]) if len(hit) else None
            inp = dp.DisplayInput(
                bars=info.bars,
                adv_value_cr=info.adv_value_cr,
                last_bar=info.last_bar,
                as_of=info.last_bar,
                today=today,
                holidays=holidays,
                action_dates=info.action_dates,
                unconfirmed_action=info.unconfirmed_action,
                model_state=eff_state,
            )
            reason = dp.hidden_reason(inp)
            if pos is None and reason in (None, dp.NO_MODEL, dp.NOT_BETTER):
                # not in the ranking universe or the latest bar has incomplete features
                reason = dp.INSUFFICIENT_HISTORY if info.bars < UNIVERSE_MIN_BARS else dp.STALE
            values: tuple[float, float, float, float] | None = None
            stock_level = reason is not None and reason not in (dp.NO_MODEL, dp.NOT_BETTER)
            if pos is not None and model is not None and usable and not stock_level:
                x = panel.X[pos : pos + 1]
                p = float(model.p_up(x)[0])
                z = model.z_band(x)[0]
                q10, q50, q90 = dp.band_returns(
                    float(panel.sigma[pos]), h, (float(z[0]), float(z[1]), float(z[2]))
                )
                values = (p, q10, q50, q90)
            rows.append(
                PredRow(
                    info.symbol,
                    info.instrument_id,
                    h,
                    info.last_bar,
                    info.ref_close,
                    None if values is None else values[0],
                    None if values is None else values[1],
                    None if values is None else values[2],
                    None if values is None else values[3],
                    reason is None,
                    reason,
                )
            )
    return rows
