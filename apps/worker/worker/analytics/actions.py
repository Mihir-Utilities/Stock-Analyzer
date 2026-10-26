"""Split/bonus detector, soft one-day-drop flag and history adjustment factors.

Spec: docs/01 section 3.7 (detection, soft flag D-O), docs/05 section 8.2 (multipliers,
adjustment rule), decision D-T (volume average over the prior 20 bars, excluding day t).
Pure functions: no database, no clock, no network.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import date
from decimal import Decimal

# docs/01 3.7: price ratios r = C_t / C_{t-1} the detector recognises, as (num, den) of r.
FRACTIONS: tuple[tuple[int, int], ...] = (
    (1, 2),
    (1, 3),
    (1, 4),
    (1, 5),
    (1, 10),
    (1, 20),
    (2, 3),
    (3, 4),
    (4, 5),
    (5, 6),
)

LOW_CONFIDENCE_GAP_DAYS = 14  # about 10 trading days; see Detection.low_confidence

EPS = 1e-9  # boundary values (exactly 3%, exactly -20%) must not flip on float noise

FLAG_LARGE_DROP = "large_one_day_drop"
WARN_UNCONFIRMED = "UNCONFIRMED_ACTION"
WARN_CONFLICT = "ADJUSTMENT_CONFLICT"
WARN_DUPLICATE_ACTION = "ADJUSTMENT_DUPLICATE_ACTION"


@dataclass(frozen=True)
class DetectorConfig:
    """Thresholds of docs/01 3.7; configurable, tuned on real files in spike S8."""

    trigger: float = 0.35  # |C_t/C_{t-1} - 1| must exceed this
    tolerance: float = 0.03  # r within 3% (relative) of a listed fraction
    volume_multiple: float = 1.5  # volume_t > 1.5 x the prior-bars average
    volume_window: int = 20  # prior bars, excluding day t (D-T)
    soft_drop: float = 0.20  # C_t/C_{t-1} - 1 <= -0.20 raises the soft notice (D-O)
    fractions: tuple[tuple[int, int], ...] = FRACTIONS


@dataclass(frozen=True)
class Bar:
    trade_date: date
    close: float
    volume: int
    src_adjusted: bool = False
    suspect: bool = False  # failed a sanity rule (docs/01 3.5): never part of the volume average


@dataclass(frozen=True)
class Detection:
    ex_date: date
    ratio: float  # observed C_t / C_{t-1}
    ratio_num: int  # matched fraction of the price ratio (e.g. 1/2)
    ratio_den: int
    prev_date: date
    conflict: bool  # bar t or bar t-1 was imported as already adjusted (ADJUSTMENT_CONFLICT)

    @property
    def change_pct(self) -> float:
        return (self.ratio - 1.0) * 100.0

    @property
    def low_confidence(self) -> bool:
        """Interim assumption (docs/OPEN_QUESTIONS.md D03R-1): the two compared stored bars are
        more than ``LOW_CONFIDENCE_GAP_DAYS`` calendar days apart, so the "jump" may be a data
        hole rather than a split. Informational only; it never changes the trigger."""
        return (self.ex_date - self.prev_date).days > LOW_CONFIDENCE_GAP_DAYS


@dataclass(frozen=True)
class SoftFlag:
    flag_type: str
    trade_date: date
    change_pct: float  # negative, e.g. -33.3


def normalize_bars(bars: Iterable[Bar]) -> list[Bar]:
    """One bar per date (the last one wins, as an upsert would), ascending, close > 0 only.

    A duplicate row in a feed must never be counted twice (BRK-19).
    """
    by_date: dict[date, Bar] = {}
    for bar in bars:
        if bar.close > 0:
            by_date[bar.trade_date] = bar
    return [by_date[d] for d in sorted(by_date)]


def match_fraction(ratio: float, cfg: DetectorConfig) -> tuple[int, int] | None:
    """The listed fraction within the tolerance of ``ratio`` (the closest one), else None."""
    best: tuple[float, tuple[int, int]] | None = None
    for num, den in cfg.fractions:
        err = abs(ratio / (num / den) - 1.0)
        if err <= cfg.tolerance + EPS and (best is None or err < best[0]):
            best = (err, (num, den))
    return None if best is None else best[1]


def _prior_window(series: Sequence[Bar], i: int, cfg: DetectorConfig) -> list[Bar]:
    """The prior ``volume_window`` non-suspect bars before index ``i`` (day t excluded, D-T).

    Suspect bars are excluded from the average (docs/05 section 1); they stay in the price series
    because the >50% jump rule marks the split-day bar itself ``suspect`` (docs/01 3.5).
    """
    picked: list[Bar] = []
    for j in range(i - 1, -1, -1):
        if not series[j].suspect:
            picked.append(series[j])
            if len(picked) == cfg.volume_window:
                break
    return picked


def _volume_ok(window: Sequence[Bar], volume: int, cfg: DetectorConfig) -> bool:
    if len(window) < cfg.volume_window:
        return False  # not enough history to judge a volume spike (assumption D03-A1)
    avg = sum(b.volume for b in window) / len(window)
    return avg > 0 and volume > cfg.volume_multiple * avg


def detect_splits(bars: Iterable[Bar], cfg: DetectorConfig | None = None) -> list[Detection]:
    """Candidate splits/bonuses (docs/01 3.7). Never applied; the owner confirms."""
    cfg = cfg or DetectorConfig()
    series = normalize_bars(bars)
    found: list[Detection] = []
    for i in range(1, len(series)):
        prev, cur = series[i - 1], series[i]
        ratio = cur.close / prev.close
        if abs(ratio - 1.0) <= cfg.trigger + EPS:
            continue
        fraction = match_fraction(ratio, cfg)
        if fraction is None:
            continue  # reverse splits (ratio > 1.35) never match: ACT-13
        window = _prior_window(series, i, cfg)  # prior non-suspect bars, excluding day t
        if not _volume_ok(window, cur.volume, cfg):
            continue
        found.append(
            Detection(
                ex_date=cur.trade_date,
                ratio=ratio,
                ratio_num=fraction[0],
                ratio_den=fraction[1],
                prev_date=prev.trade_date,
                conflict=prev.src_adjusted or cur.src_adjusted,
            )
        )
    return found


def soft_drop_flags(
    bars: Iterable[Bar],
    detected_dates: Iterable[date] = (),
    cfg: DetectorConfig | None = None,
) -> list[SoftFlag]:
    """One-day drops of 20% or more that did not become a detection (D-O, ACT-15).

    Creates nothing in ``corporate_action``; the caller shows a dismissible notice.
    ``detected_dates`` are the ex-dates the main trigger flagged (or that already have an action).
    """
    cfg = cfg or DetectorConfig()
    skip = set(detected_dates)
    series = normalize_bars(bars)
    flags: list[SoftFlag] = []
    for i in range(1, len(series)):
        cur = series[i]
        change = cur.close / series[i - 1].close - 1.0
        if change <= -cfg.soft_drop + EPS and cur.trade_date not in skip:
            flags.append(SoftFlag(FLAG_LARGE_DROP, cur.trade_date, change * 100.0))
    return flags


def qty_multiplier(
    action_type: str, ratio_num: Decimal | None, ratio_den: Decimal | None
) -> Decimal | None:
    """docs/05 8.2: split = num/den; bonus = (num + den)/den. Other types: None (never applied)."""
    if ratio_num is None or ratio_den is None or ratio_den <= 0 or ratio_num <= 0:
        return None
    if action_type == "split":
        return ratio_num / ratio_den
    if action_type == "bonus":
        return (ratio_num + ratio_den) / ratio_den
    return None


def adjustment_steps(
    actions: Iterable[tuple[date, Decimal]], as_of: date
) -> list[tuple[date, Decimal]]:
    """Cumulative price factors per ex-date boundary (docs/05 8.2).

    ``actions`` are confirmed (ex_date, qty multiplier) pairs; ex_dates after ``as_of`` are not
    applied (ACT-10). Returns ``[(ex_date_i, factor_i)]`` ascending where a bar with
    ``ex_date_{i-1} <= t < ex_date_i`` has ``adj_close = close x factor_i`` and bars on or after
    the last ex_date keep factor 1. Same-day actions combine.
    """
    per_day: dict[date, Decimal] = {}
    for ex_date, mult in actions:
        if ex_date <= as_of and mult > 0:
            per_day[ex_date] = per_day.get(ex_date, Decimal(1)) * mult
    days = sorted(per_day)
    steps: list[tuple[date, Decimal]] = []
    for i, day in enumerate(days):
        factor = Decimal(1)
        for later in days[i:]:
            factor /= per_day[later]
        steps.append((day, factor))
    return steps


def adj_close(
    close: float, trade_date: date, src_adjusted: bool, steps: Sequence[tuple[date, Decimal]]
) -> float:
    """Reference implementation of the per-bar rule (D-K); the SQL UPDATE must agree."""
    if src_adjusted:
        return close
    for ex_date, factor in steps:
        if trade_date < ex_date:
            return close * float(factor)
    return close
