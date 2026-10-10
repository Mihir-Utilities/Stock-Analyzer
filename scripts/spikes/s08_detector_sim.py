#!/usr/bin/env python3
"""Spike S08 (docs/08): split/bonus detector tuning on SYNTHETIC candles.

No market data is downloaded or used. Prices and volumes are generated here from a seeded random
model that the spike author wrote, so the numbers measure the *mechanics* of the rule in
docs/01 section 3.7 (and how its thresholds interact), not real-world false-positive rates.
Re-run with owner-imported price files for the real S8 verdict (see docs/SPIKE_RESULTS.md).

Usage: python scripts/spikes/s08_detector_sim.py [--seed N]
"""

from __future__ import annotations

import argparse
import math
import random
from dataclasses import dataclass

FRACTIONS = {
    "1/2": 1 / 2,
    "1/3": 1 / 3,
    "1/4": 1 / 4,
    "1/5": 1 / 5,
    "1/10": 1 / 10,
    "1/20": 1 / 20,
    "2/3": 2 / 3,
    "3/4": 3 / 4,
    "4/5": 4 / 5,
    "5/6": 5 / 6,
}
BARS = 1250  # about 5 trading years


@dataclass(frozen=True)
class Params:
    trigger: float = 0.35  # |C_t/C_{t-1} - 1| must exceed this
    tolerance: float = 0.03  # relative distance to a fraction
    volume_mult: float = 1.5  # volume vs mean of the previous 20 bars
    fractions: tuple[str, ...] = tuple(FRACTIONS)


def detect(close: list[float], volume: list[int], p: Params) -> list[int]:
    """Indices t flagged by the rule in docs/01 section 3.7 (20-day mean excludes day t: ASSUMPTION)."""
    hits = []
    for t in range(21, len(close)):
        r = close[t] / close[t - 1]
        if abs(r - 1) <= p.trigger:
            continue
        if not any(abs(r / FRACTIONS[f] - 1) <= p.tolerance for f in p.fractions):
            continue
        avg = sum(volume[t - 20 : t]) / 20
        if volume[t] > p.volume_mult * avg:
            hits.append(t)
    return hits


def make_stock(rng: random.Random, events: list[tuple[int, float, float]], crashes: list[tuple[int, float]]):
    """Return (close, volume). events: (bar, ratio, volume multiple); crashes: (bar, ratio) genuine moves."""
    sigma = rng.uniform(0.012, 0.025)
    base_vol = rng.uniform(2e5, 5e6)
    price = rng.uniform(50, 3000)
    ev = {b: (r, m) for b, r, m in events}
    cr = dict(crashes)
    close, vol = [], []
    for t in range(BARS):
        # Student-t (df=3) shocks, capped at +/-12% to mimic circuit limits
        z = rng.gauss(0, 1) / math.sqrt(rng.gammavariate(1.5, 2.0) / 3)
        ret = max(-0.12, min(0.12, sigma * z))
        v = base_vol * math.exp(rng.gauss(0, 0.35))
        if t in ev:
            r, m = ev[t]
            price *= r
            v *= m / r if r < 1 else m  # share count multiplies after a split
        elif t in cr:
            price *= cr[t]
            v *= rng.uniform(3, 8)
        else:
            price *= 1 + ret
            if abs(ret) > 0.06:
                v *= rng.uniform(1.5, 3)
        close.append(price)
        vol.append(int(v))
    return close, vol


def build_universe(seed: int):
    rng = random.Random(seed)
    # 15 known events across 30 stocks: 13 reachable by the rule, 2 deliberately unreachable (1:2 bonus, 4:5)
    plan = ["1/2"] * 4 + ["1/3", "1/4"] + ["1/5"] * 3 + ["1/10"] * 3 + ["1/20"] + ["2/3", "4/5"]
    event_stock = rng.sample(range(30), len(plan))
    stocks = []
    known = []
    for s in range(30):
        events = []
        crashes = []
        for i, st in enumerate(event_stock):
            if st == s:
                bar = rng.randint(200, BARS - 100)
                ratio = FRACTIONS[plan[i]] * rng.uniform(0.985, 1.015)  # price drifts a little on ex-date
                # event-day volume multiple of the 20-day average; ~8% of events are quiet (<1.5x)
                mult = rng.choice([1.2, 1.3]) if rng.random() < 0.08 else rng.uniform(1.8, 4.0)
                events.append((bar, ratio, mult))
                known.append((s, bar, plan[i], ratio))
        # genuine large non-split moves: 1 in 3 stocks has a -36..-46% crash on heavy volume
        if rng.random() < 0.34:
            crashes.append((rng.randint(100, BARS - 50), rng.uniform(0.54, 0.64)))
        # genuine 50% crash (indistinguishable from a 1:1 bonus by price alone): 2 stocks only
        if s in (5, 17):
            crashes.append((rng.randint(100, BARS - 50), rng.uniform(0.49, 0.51)))
        stocks.append(make_stock(rng, events, crashes))
    return stocks, known


def evaluate(stocks, known, p: Params):
    reachable = [k for k in known if FRACTIONS[k[2]] <= 0.65]
    found = 0
    missed = []
    known_idx = {(s, b) for s, b, _, _ in known}
    fp = 0
    for s, (close, vol) in enumerate(stocks):
        hits = set(detect(close, vol, p))
        for st, bar, name, _ in known:
            if st == s and bar in hits and FRACTIONS[name] <= 0.65:
                found += 1
        fp += sum(1 for h in hits if (s, h) not in known_idx)
    for st, bar, name, ratio in known:
        hits = detect(*stocks[st], p)
        if FRACTIONS[name] <= 0.65 and bar not in hits:
            missed.append((name, round(ratio, 3)))
    unreachable_found = sum(
        1 for st, bar, name, _ in known if FRACTIONS[name] > 0.65 and bar in detect(*stocks[st], p)
    )
    return {
        "reachable_events": len(reachable),
        "reachable_found": found,
        "recall": round(found / len(reachable), 3),
        "missed": missed,
        "false_positives": fp,
        "fp_per_30_stock_years": round(fp / (len(stocks) * BARS / 250) * 30, 2),
        "unreachable_found": unreachable_found,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=20261010)
    args = ap.parse_args()
    stocks, known = build_universe(args.seed)
    print(f"seed={args.seed} stocks={len(stocks)} bars={BARS} known events={len(known)} (synthetic)")
    base = Params()
    grid = {
        "spec (0.35 / 3% / 1.5x)": base,
        "trigger 0.30": Params(trigger=0.30),
        "trigger 0.20 (opens 3/4,4/5,5/6)": Params(trigger=0.20),
        "tolerance 2%": Params(tolerance=0.02),
        "tolerance 5%": Params(tolerance=0.05),
        "volume 1.0x": Params(volume_mult=1.0),
        "volume 2.0x": Params(volume_mult=2.0),
        "no volume rule": Params(volume_mult=0.0),
        "only reachable fractions": Params(fractions=("1/2", "1/3", "1/4", "1/5", "1/10", "1/20")),
    }
    for name, p in grid.items():
        res = evaluate(stocks, known, p)
        print(f"{name:36s} recall {res['recall']:.3f} ({res['reachable_found']}/{res['reachable_events']}) "
              f"FP {res['false_positives']} ({res['fp_per_30_stock_years']}/30 stock-yrs) unreachable_found {res['unreachable_found']} missed {res['missed']}")


if __name__ == "__main__":
    main()
