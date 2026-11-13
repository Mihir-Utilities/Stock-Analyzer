"""RST-X01: REAL worker output is the fixture the Go ``ExpandIndicators`` test and the web date
mapping test read (``fixtures/relative_strength/real_*.json``): the three layers agree on how
``relative_strength.ratio_rebased`` lines up with ``series.dates`` and the ``analysis.drawdown``
pairs. ``RST_REGEN=1 pytest tests/test_relative_strength_contract.py`` rewrites the fixtures."""

from __future__ import annotations

import json
import os
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from worker.analytics.inv_common import PeerData
from worker.analytics.snapshot import Bars, build_snapshot

FIXTURES = Path(__file__).resolve().parents[3] / "fixtures" / "relative_strength"


def real_extract(n: int) -> dict[str, Any]:
    start = date(2021, 1, 4)
    days: list[date] = []
    d = start
    while len(days) < n:
        if d.weekday() < 5:
            days.append(d)
        d += timedelta(days=1)
    rng = np.random.default_rng(11)
    c = 100 * np.cumprod(1 + rng.normal(0.0004, 0.01, n))
    bars = Bars(days, c, c, c * 1.01, c * 0.99, np.full(n, 1e6))
    # the index misses every 13th stock date and has an extra date, so there are gaps
    idx = {x: 1000.0 + 2 * i for i, x in enumerate(days) if i % 13 != 7}
    idx[date(2021, 1, 9)] = 1006.0  # a Saturday: an index-only date
    peers = PeerData(
        sector="Banks",
        closes={i: (days, c * (1 + 0.01 * i)) for i in (1, 2, 3)},
        peers_in_sector=3,
    )
    from worker.analytics.inv_common import InvContext

    snap = build_snapshot(bars, idx, inv_ctx=InvContext(today=days[-1], peers=peers, symbol="REAL"))
    assert snap is not None
    json.dumps(snap, allow_nan=False)
    return {
        "series": {"format": "columnar", "dates": snap["series"]["dates"]},
        "analysis": {
            "format": "columnar",
            "drawdown": snap["analysis"]["drawdown"],
            "relative_strength": snap["analysis"]["relative_strength"],
        },
    }


@pytest.mark.parametrize("n", [120, 800])
def test_rst_x01_fixture_is_real_worker_output(n: int) -> None:
    got = real_extract(n)
    path = FIXTURES / f"real_{n}.json"
    if os.environ.get("RST_REGEN"):
        FIXTURES.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(got, separators=(",", ":")) + "\n", encoding="utf-8")
    want = json.loads(path.read_text(encoding="utf-8"))
    assert got == want, (
        "stale fixture: run RST_REGEN=1 pytest tests/test_relative_strength_contract.py"
    )
    rs = got["analysis"]["relative_strength"]
    ratio = rs["vs_index"]["ratio_rebased"]
    assert len(ratio) == len(got["series"]["dates"]) == len(got["analysis"]["drawdown"])
    assert len(got["series"]["dates"]) == min(n, 750)
    assert (
        ratio.count(None) > 0
        and ratio[ratio.index(next(x for x in ratio if x is not None))] == 100.0
    )
