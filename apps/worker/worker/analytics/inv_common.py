"""Shared pieces of the investment-context analytics (docs/05 section 12.0): the ``INV_*``
settings, the mid-rank percentile, the median and the JSON-safe rounding.

Everything is a description of past prices (no verdict, no score, no target). Pure: no clock, no
database; the database reads live in ``worker.analysis_db``.
"""

from __future__ import annotations

import json
import math
from collections.abc import Collection, Mapping
from dataclasses import dataclass, field
from datetime import date
from typing import Any

import numpy as np
from numpy.typing import NDArray

F64 = NDArray[np.float64]

DIGITS = 4  # percents and ratios; hypothetical INR amounts use 2 (docs/05 12.0)

INSUFFICIENT = "insufficient_history"


@dataclass(frozen=True)
class InvSettings:
    """``app_setting`` ``INV_*`` values with the documented fallbacks (docs/05 12.0)."""

    min_years: int = 3
    small_years: int = 5
    min_windows: int = 20
    min_episodes: int = 3
    small_episodes: int = 10
    sip_min_months: int = 12
    vol_band_low: float = 20.0
    vol_band_high: float = 80.0
    dd_tol: float = 1e-9

    @staticmethod
    def from_mapping(raw: Mapping[str, Any]) -> InvSettings:
        """Build from ``{key: json value}``; a missing, malformed or out-of-range value keeps its
        documented default (never raises)."""
        d = InvSettings()

        def count(key: str, default: int) -> int:
            v = _number(raw.get(key))
            return int(v) if v is not None and v >= 1 and v == int(v) else default

        def real(key: str, default: float, *, low: float, high: float) -> float:
            v = _number(raw.get(key))
            return v if v is not None and low <= v <= high else default

        low = real("INV_VOL_BAND_LOW", d.vol_band_low, low=0.0, high=100.0)
        high = real("INV_VOL_BAND_HIGH", d.vol_band_high, low=0.0, high=100.0)
        if low >= high:
            low, high = d.vol_band_low, d.vol_band_high
        return InvSettings(
            min_years=count("INV_MIN_YEARS", d.min_years),
            small_years=count("INV_SMALL_YEARS", d.small_years),
            min_windows=count("INV_MIN_WINDOWS", d.min_windows),
            min_episodes=count("INV_MIN_EPISODES", d.min_episodes),
            small_episodes=count("INV_SMALL_EPISODES", d.small_episodes),
            sip_min_months=count("INV_SIP_MIN_MONTHS", d.sip_min_months),
            vol_band_low=low,
            vol_band_high=high,
            dd_tol=real("INV_DD_TOL", d.dd_tol, low=0.0, high=1e-3),
        )


SETTING_KEYS: tuple[str, ...] = (
    "INV_MIN_YEARS",
    "INV_SMALL_YEARS",
    "INV_MIN_WINDOWS",
    "INV_MIN_EPISODES",
    "INV_SMALL_EPISODES",
    "INV_SIP_MIN_MONTHS",
    "INV_VOL_BAND_LOW",
    "INV_VOL_BAND_HIGH",
    "INV_DD_TOL",
)


def _number(v: Any) -> float | None:
    if isinstance(v, str):
        try:
            v = json.loads(v)
        except ValueError:
            return None
    if isinstance(v, bool) or not isinstance(v, int | float):
        return None
    return float(v) if math.isfinite(v) else None


@dataclass(frozen=True)
class PeerData:
    """Inputs of the sector-peer ranks (docs/05 12.14.6), read by ``analysis_db``: this stock's
    sector (``None`` = unclassified) and the valid ``adj_close`` bars (ascending) of the tracked
    same-sector peers. ``failed`` means the read raised (the block then says ``compute_error``)."""

    sector: str | None
    closes: Mapping[int, tuple[list[date], F64]] = field(default_factory=dict)
    peers_in_sector: int = 0
    failed: bool = False


@dataclass(frozen=True)
class InvContext:
    """What the blocks need besides the prices: the IST date of the computation (an argument,
    never read from the clock here), the trading holidays and the settings."""

    today: date
    holidays: Collection[date] = field(default_factory=frozenset)
    market_closed: Collection[date] = field(default_factory=frozenset)  # derived from the data
    settings: InvSettings = field(default_factory=InvSettings)
    # Relative strength (docs/05 12.14): the log label and the sector peers' prices.
    symbol: str | None = None
    peers: PeerData | None = None


def r4(v: float) -> float | None:
    """Rounded JSON-safe percent or ratio; nan/inf -> None; never ``-0.0``."""
    if not math.isfinite(v):
        return None
    out = round(float(v), DIGITS)
    return 0.0 if out == 0 else out


def r2(v: float) -> float | None:
    if not math.isfinite(v):
        return None
    out = round(float(v), 2)
    return 0.0 if out == 0 else out


def iso(d: date | None) -> str | None:
    return None if d is None else d.isoformat()


def median(values: F64) -> float:
    """Median; an even count is the mean of the two middle values."""
    return float(np.median(values))


def pctile(x: float, sample: F64) -> float:
    """Mid-rank percentile of ``x`` in ``sample`` (which contains ``x``):
    ``100 * (count(s < x) + 0.5 * count(s == x)) / n``, in [0, 100]."""
    n = len(sample)
    below = int(np.count_nonzero(sample < x))
    equal = int(np.count_nonzero(sample == x))
    return 100.0 * (below + 0.5 * equal) / n
