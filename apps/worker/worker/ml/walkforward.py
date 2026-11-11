"""Walk-forward folds with embargo/purge (docs/05 10.2, 10.4). Pure functions on the calendar."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date

import numpy as np
from numpy.typing import NDArray

I64 = NDArray[np.int64]
BoolArr = NDArray[np.bool_]


def month_key(d: date) -> int:
    return d.year * 12 + (d.month - 1)


@dataclass(frozen=True)
class Fold:
    index: int
    start: int  # first calendar index of the validation window (inclusive)
    end: int  # one past the last calendar index (exclusive)


def make_folds(
    calendar: Sequence[date], *, init_months: int = 36, fold_months: int = 3
) -> list[Fold]:
    """Expanding-window folds: the first ``init_months`` calendar months are training only, then
    consecutive ``fold_months`` validation windows. Only complete windows are used: the window's
    last month must be strictly before the month of the last calendar date, so a half-finished
    month never forms a fold."""
    if not calendar:
        return []
    keys = [month_key(d) for d in calendar]
    first, last = keys[0], keys[-1]
    folds: list[Fold] = []
    j = 0
    while True:
        m0 = first + init_months + j * fold_months
        m1 = m0 + fold_months  # exclusive
        if m1 > last:  # window's last month (m1 - 1) must be < last month
            break
        start = next((i for i, k in enumerate(keys) if k >= m0), None)
        end = next((i for i, k in enumerate(keys) if k >= m1), len(keys))
        if start is not None and start < end:
            folds.append(Fold(len(folds), start, end))
        j += 1
    return folds


def train_mask(labeled: BoolArr, label_end: I64, fold_start: int) -> BoolArr:
    """Training rows for a fold: labeled rows whose whole label window ends before the validation
    window starts. This is the embargo and the purge in one rule (a training row ``t`` is
    dropped when its row ``t + h`` falls on or after ``fold_start``)."""
    out: BoolArr = labeled & (label_end < fold_start)
    return out


def valid_mask(labeled: BoolArr, date_idx: I64, fold: Fold) -> BoolArr:
    out: BoolArr = labeled & (date_idx >= fold.start) & (date_idx < fold.end)
    return out
