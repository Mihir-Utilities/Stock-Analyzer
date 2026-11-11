"""D07 walk-forward folds: ML-03 (embargo / purge, no overlap) and the fold schedule."""

from __future__ import annotations

from datetime import date

import numpy as np
import pytest
from mlgen import make_panel_inputs, weekdays

from worker.ml.features import build_panel
from worker.ml.walkforward import make_folds, month_key, train_mask, valid_mask


def test_fold_schedule_36_months_then_3_month_windows() -> None:
    cal = weekdays(1700)  # about 78 months from 2018-01
    folds = make_folds(cal)
    assert len(folds) >= 12
    first = month_key(cal[0])
    assert month_key(cal[folds[0].start]) == first + 36  # first 36 months are training only
    for a, b in zip(folds, folds[1:], strict=False):
        assert a.end == b.start  # contiguous, never overlapping
        assert month_key(cal[b.start]) - month_key(cal[a.start]) == 3
    # a half-finished last month never forms a fold
    assert month_key(cal[folds[-1].end - 1]) < month_key(cal[-1])


def test_no_folds_without_enough_history() -> None:
    assert make_folds(weekdays(600)) == []
    assert make_folds([]) == []


def test_fold_windows_are_calendar_months() -> None:
    cal = [date(2020 + (m // 12), m % 12 + 1, 1) for m in range(18)]  # one date per month
    f = make_folds(cal, init_months=6, fold_months=3)
    assert [(x.index, x.start, x.end) for x in f] == [(0, 6, 9), (1, 9, 12), (2, 12, 15)]


# ML-03
@pytest.mark.parametrize("h", [5, 21])
def test_ml03_embargo_and_purge_leave_no_overlap(h: int) -> None:
    stocks, market = make_panel_inputs(n_stocks=4, n_days=900, seed=8, with_market=False)
    panel = build_panel(stocks, market, horizons=(h,))
    lab = panel.labeled(h)
    folds = make_folds(panel.calendar, init_months=15, fold_months=3)
    assert len(folds) >= 4
    purged_somewhere = False
    for fold in folds:
        tm = train_mask(lab, panel.label_end[h], fold.start)
        vm = valid_mask(lab, panel.date_idx, fold)
        assert tm.any() and vm.any()
        # every training label window ends strictly before the validation window starts
        assert panel.label_end[h][tm].max() < fold.start
        assert panel.date_idx[tm].max() <= fold.start - h  # an embargo of at least h trading days
        assert panel.date_idx[vm].min() >= fold.start
        # a naive split (features before the fold) would have leaked label windows
        naive = lab & (panel.date_idx < fold.start)
        leaked = naive & ~tm
        purged_somewhere |= bool(leaked.any())
        assert (panel.label_end[h][leaked] >= fold.start).all()
        # the purged rows are exactly the last h rows of each stock before the fold
        assert leaked.sum() == h * len(stocks)
    assert purged_somewhere


def test_unlabeled_rows_never_enter_training_or_validation() -> None:
    stocks, market = make_panel_inputs(n_stocks=3, n_days=700, seed=9, with_market=False)
    panel = build_panel(stocks, market, horizons=(5,))
    lab = panel.labeled(5)
    assert (~lab).any()
    fold = make_folds(panel.calendar, init_months=15, fold_months=3)[-1]
    assert not (train_mask(lab, panel.label_end[5], fold.start) & ~lab).any()
    assert not (valid_mask(lab, panel.date_idx, fold) & ~lab).any()
    assert np.isfinite(panel.y_ret[5][lab]).all()
