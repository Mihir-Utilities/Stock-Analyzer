"""Month, year and running-period returns and the month-of-year seasonality (docs/05 12.1, 12.2).

A month is the calendar month. It is **closed** when ``today`` (IST, an argument) is after its
last day; it is **complete** when the imported prices reach its last expected trading day
(weekends, the holidays file and the market-closed days derived from the data). Only closed,
complete months with a base enter a statistic; the month of ``today`` is the running month (month
to date, never counted). Price return only.
"""

from __future__ import annotations

import calendar
import math
from collections.abc import Collection, Mapping
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

import numpy as np

from worker.analytics.inv_common import F64, InvSettings, iso, median, r4
from worker.ml.display import last_trading_day

HEATMAP_YEARS = 10
# Market-closed days derived from the data (docs/05 12.1, D-INV3).
CLOSED_MIN_ACTIVE = 3  # tracked instruments with bars in the month, and with bars in the period
CLOSED_MAX_RUN = 5  # a longer run of bar-less weekdays is a data outage, not exchange closures

GAP_BEFORE = "gap_before"
NO_BASE = "no_base"
INCOMPLETE = "incomplete_month_data"
NO_BAR_THIS_MONTH = "no_bar_this_month"
TOO_FEW_YEARS = "too_few_years"
TOO_FEW_MONTHS = "too_few_months"


def _idx(d: date) -> int:
    return d.year * 12 + d.month - 1


def _ym(idx: int) -> tuple[int, int]:
    y, m0 = divmod(idx, 12)
    return y, m0 + 1


def last_expected_trading_day(idx: int, holidays: Collection[date]) -> date:
    """The last day of the month that is not a weekend or a holiday (docs/05 12.1)."""
    y, m = _ym(idx)
    return last_trading_day(date(y, m, calendar.monthrange(y, m)[1]), holidays)


def derive_closed_days(day_counts: Mapping[date, int], first: date) -> frozenset[date]:
    """Weekdays on which the market was closed, judged from the data itself (docs/05 12.1, D-INV3).

    ``day_counts`` maps a date to the number of tracked instruments with a valid bar on it. A
    weekday on or after ``first`` is *closed* when all of these hold: no tracked instrument has a
    bar on it; at least ``CLOSED_MIN_ACTIVE`` instruments have bars in the same calendar month
    (else the month is too thin to tell a holiday from missing data); a later day has bars (the
    newest import is never presumed closed); and it is not part of a run of more than
    ``CLOSED_MAX_RUN`` consecutive bar-less weekdays (a long outage is missing data). With fewer
    than ``CLOSED_MIN_ACTIVE`` instruments in the period the result is empty (the holidays file
    alone decides)."""
    live = {d: n for d, n in day_counts.items() if n > 0 and d >= first}
    if not live:
        return frozenset()
    by_month: dict[int, int] = {}
    for d, n in live.items():
        by_month[_idx(d)] = max(by_month.get(_idx(d), 0), n)
    if max(live.values()) < CLOSED_MIN_ACTIVE:
        return frozenset()
    last = max(live)
    out: set[date] = set()
    run: list[date] = []

    def flush() -> None:
        if 0 < len(run) <= CLOSED_MAX_RUN:
            out.update(x for x in run if by_month.get(_idx(x), 0) >= CLOSED_MIN_ACTIVE)
        run.clear()

    d = first
    while d < last:
        if d.weekday() < 5:
            if d in live:
                flush()
            else:
                run.append(d)
        d += timedelta(days=1)
    flush()
    return frozenset(out)


@dataclass(frozen=True)
class MonthReturn:
    value: float | None  # unrounded percent: "green" is decided on this value (INV-7)
    reason: str | None


class MonthModel:
    """Month-end closes of the valid bars and the closed/complete status of every month."""

    def __init__(
        self,
        dates: list[date],
        close: F64,
        today: date,
        holidays: Collection[date] = frozenset(),
        closed: Collection[date] = frozenset(),
    ) -> None:
        self.end_date: dict[int, date] = {}
        self.end_close: dict[int, float] = {}
        for d, c in zip(dates, close, strict=True):
            self.end_date[_idx(d)] = d  # dates ascend: the last write is the month's last bar
            self.end_close[_idx(d)] = float(c)
        self.first_idx = _idx(dates[0])
        self.first_date = dates[0]
        self.n_bars = len(dates)
        self.last_idx = _idx(dates[-1])
        self.today_idx = _idx(today)
        self.today = today
        self.last_date = dates[-1]
        self.last_close = float(close[-1])
        self.holidays = holidays
        off = frozenset(holidays) | frozenset(closed)  # holidays file + market-closed days
        self._complete = {
            i: d >= last_expected_trading_day(i, off) for i, d in self.end_date.items()
        }

    def has_bars(self, idx: int) -> bool:
        return idx in self.end_date

    def is_closed(self, idx: int) -> bool:
        return idx < self.today_idx

    def complete(self, idx: int) -> bool:
        return self._complete.get(idx, False)

    def months_excluded_incomplete(self) -> int:
        """Closed months with bars that are incomplete (in no statistic, docs/05 12.1)."""
        return sum(1 for i in self.end_date if self.is_closed(i) and not self._complete[i])

    def _base_problem(self, idx: int) -> str | None:
        """Why month ``idx`` has no month-end base (None when it has one)."""
        prev = idx - 1
        if prev in self.end_date:
            return None if self._complete[prev] else GAP_BEFORE
        return NO_BASE if idx == self.first_idx else GAP_BEFORE

    def month_return(self, idx: int) -> MonthReturn:
        """Return of a month with bars strictly before today's month (docs/05 12.1)."""
        if not self.complete(idx):
            return MonthReturn(None, INCOMPLETE)
        problem = self._base_problem(idx)
        if problem is not None:
            return MonthReturn(None, problem)
        return MonthReturn((self.end_close[idx] / self.end_close[idx - 1] - 1.0) * 100.0, None)

    def mtd(self) -> MonthReturn:
        """Month to date of today's calendar month."""
        if self.last_idx != self.today_idx:
            return MonthReturn(None, NO_BAR_THIS_MONTH)
        problem = self._base_problem(self.today_idx)
        if problem is not None:
            return MonthReturn(None, problem)
        base = self.end_close[self.today_idx - 1]
        return MonthReturn((self.last_close / base - 1.0) * 100.0, None)

    def closed_returns(self) -> list[tuple[int, int, float]]:
        """``(year, month, percent)`` of every closed, complete month with a return, ascending."""
        out: list[tuple[int, int, float]] = []
        for i in sorted(self.end_date):
            if i >= self.today_idx:
                continue
            ret = self.month_return(i)
            if ret.value is not None:
                out.append((*_ym(i), ret.value))
        return out


def month_cells(model: MonthModel) -> tuple[list[list[Any]], list[list[Any]]]:
    """The heatmap cells ``[year, month, pct|None]`` of the last ``HEATMAP_YEARS`` calendar years
    and ``[year, month, reason]`` for every null cell. The first month of the history has no base
    and no cell; the running month shows its month to date."""
    cutoff = _ym(model.last_idx)[0] - HEATMAP_YEARS
    cells: list[list[Any]] = []
    reasons: list[list[Any]] = []
    for i in sorted(model.end_date):
        y, m = _ym(i)
        if y <= cutoff or i == model.first_idx or i > model.today_idx:
            continue
        res = model.mtd() if i == model.today_idx else model.month_return(i)
        cells.append([y, m, None if res.value is None else r4(res.value)])
        if res.value is None:
            reasons.append([y, m, res.reason])
    return cells, reasons


def _year_row(model: MonthModel, y: int, *, exact: bool) -> dict[str, Any] | None:
    first_year = _ym(model.first_idx)[0]
    running = y == model.today.year
    if running and _ym(model.last_idx)[0] != y:
        return None  # the running year has no bar yet: no row, nothing invented
    last_m = _ym(model.last_idx)[1]
    kind = "ytd" if running else ("partial_first" if y == first_year else "full")

    base_idx = model.first_idx if y == first_year else _idx(date(y - 1, 12, 1))
    end_idx = None if kind == "ytd" else _idx(date(y, 12, 1))
    if kind == "ytd":
        covered = last_m - (_ym(model.first_idx)[1] if y == first_year else 0)
    elif kind == "partial_first":
        covered = 12 - _ym(model.first_idx)[1]
    else:
        covered = 12

    row: dict[str, Any] = {
        "year": y,
        "return_pct": None,
        "return_pct_reason": None,
        "kind": kind,
        "months_covered": covered,
        "base_date": iso(model.end_date.get(base_idx)),
        "end_date": iso(model.last_date if end_idx is None else model.end_date.get(end_idx)),
    }
    if covered <= 0:  # the first month is also the last month of its year: no later month
        row["return_pct_reason"] = NO_BASE
        row["months_covered"] = 0
        return row
    for idx in (base_idx, end_idx):
        if idx is None:
            continue
        if not model.has_bars(idx):
            row["return_pct_reason"] = GAP_BEFORE
            return row
        if not model.complete(idx):
            row["return_pct_reason"] = INCOMPLETE
            return row
    end = model.last_close if end_idx is None else model.end_close[end_idx]
    pct = (end / model.end_close[base_idx] - 1.0) * 100.0
    row["return_pct"] = pct if exact else r4(pct)
    return row


def year_rows(model: MonthModel, *, exact: bool = False) -> list[dict[str, Any]]:
    """Every calendar year of the history (ascending); ``year_returns`` shows the last ten.
    ``exact`` keeps the unrounded percent (statistics and the chain-identity test)."""
    out: list[dict[str, Any]] = []
    if model.n_bars < 2:
        return out
    for y in range(_ym(model.first_idx)[0], min(model.today.year, _ym(model.last_idx)[0]) + 1):
        row = _year_row(model, y, exact=exact)
        if row is not None:
            out.append(row)
    return out


def year_returns(model: MonthModel) -> list[dict[str, Any]]:
    cutoff = _ym(model.last_idx)[0] - HEATMAP_YEARS
    return [r for r in year_rows(model) if r["year"] > cutoff]


def stats(pairs: list[tuple[int, float]], settings: InvSettings) -> dict[str, Any]:
    """Statistics of ``(year, pct)`` pairs: share green (strictly > 0 on the unrounded value),
    average, median, best and worst (ties: the earlier year)."""
    pairs = sorted(pairs)
    n = len(pairs)
    shown = n >= settings.min_years
    if n == 0:
        return {
            "n": 0,
            "n_green": 0,
            "green_pct": None,
            "green_pct_reason": TOO_FEW_YEARS,
            "avg_pct": None,
            "median_pct": None,
            "best": None,
            "worst": None,
            "small_sample": True,
        }
    vals = np.array([p for _, p in pairs], dtype=np.float64)
    n_green = int(np.count_nonzero(vals > 0.0))
    best = max(pairs, key=lambda t: (t[1], -t[0]))
    worst = min(pairs, key=lambda t: (t[1], t[0]))
    return {
        "n": n,
        "n_green": n_green,
        "green_pct": r4(100.0 * n_green / n) if shown else None,
        "green_pct_reason": None if shown else TOO_FEW_YEARS,
        "avg_pct": r4(float(vals.mean())),
        "median_pct": r4(median(vals)),
        "best": {"pct": r4(best[1]), "year": best[0]},
        "worst": {"pct": r4(worst[1]), "year": worst[0]},
        "small_sample": n < settings.small_years,
    }


def best_worst(
    months: list[dict[str, Any]], settings: InvSettings
) -> tuple[dict[str, Any] | None, dict[str, Any] | None, str | None]:
    """Best and worst calendar month by median among months with ``share_shown`` (INV-20); needs
    at least two such months. Ties: the earlier calendar month."""
    eligible = [
        (int(m["month"]), float(m["median_pct"]), int(m["n_years"]))
        for m in months
        if m["n_years"] >= settings.min_years
    ]
    if len(eligible) < 2:
        return None, None, TOO_FEW_MONTHS
    b = max(eligible, key=lambda t: (t[1], -t[0]))
    w = min(eligible, key=lambda t: (t[1], t[0]))
    return (
        {"month": b[0], "median_pct": b[1], "n_years": b[2]},
        {"month": w[0], "median_pct": w[1], "n_years": w[2]},
        None,
    )


def seasonality(model: MonthModel, bars: int, settings: InvSettings) -> dict[str, Any]:
    """``analysis.seasonality`` (docs/05 12.2, docs/03 4a): all available history."""
    by_month: dict[int, list[tuple[int, float]]] = {m: [] for m in range(1, 13)}
    for y, m, pct in model.closed_returns():
        by_month[m].append((y, pct))
    months: list[dict[str, Any]] = []
    for m in range(1, 13):
        s = stats(by_month[m], settings)
        months.append(
            {
                "month": m,
                "n_years": s["n"],
                "n_green": s["n_green"],
                "green_pct": s["green_pct"],
                "green_pct_reason": s["green_pct_reason"],
                "avg_pct": s["avg_pct"],
                "median_pct": s["median_pct"],
                "best": s["best"],
                "worst": s["worst"],
                "small_sample": s["small_sample"],
            }
        )
    best_month, worst_month, reason = best_worst(months, settings)

    full_years = [
        (int(r["year"]), float(r["return_pct"]))
        for r in year_rows(model, exact=True)
        if r["kind"] == "full" and r["return_pct"] is not None
    ]
    ys = stats(full_years, settings)
    years = {
        "n": ys["n"],
        "n_green": ys["n_green"],
        "green_pct": ys["green_pct"],
        "green_pct_reason": ys["green_pct_reason"],
        "avg_pct": ys["avg_pct"],
        "median_pct": ys["median_pct"],
        "best": ys["best"],
        "worst": ys["worst"],
        "small_sample": ys["small_sample"],
    }

    mtd = model.mtd()
    ty, tm = _ym(model.today_idx)
    base_idx = model.today_idx - 1
    has_base = mtd.value is not None
    running = {
        "year": ty,
        "month": tm,
        "mtd_return_pct": None if mtd.value is None else r4(mtd.value),
        "mtd_reason": mtd.reason,
        "base_date": iso(model.end_date.get(base_idx)) if has_base else None,
        "as_of": model.last_date.isoformat(),
    }
    span = (model.last_date - model.first_date).days / 365.25
    return {
        "as_of": model.last_date.isoformat(),
        "bars": bars,
        "first_bar": model.first_date.isoformat(),
        "last_bar": model.last_date.isoformat(),
        "years_of_history": round(span, 1) if math.isfinite(span) else None,
        "min_years": settings.min_years,
        "small_sample_years": settings.small_years,
        "running": running,
        "months": months,
        "best_month": best_month,
        "worst_month": worst_month,
        "best_worst_reason": reason,
        "years": years,
        "months_excluded_incomplete": model.months_excluded_incomplete(),
    }
