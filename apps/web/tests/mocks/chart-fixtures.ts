// Contract-shaped answers for the Chart and Analysis tabs (docs/03 section 4, D05a-A6 and B04-7:
// series as [date, value] pairs with null warm-ups, analysis arrays aligned to the series dates,
// histogram / month_year / calendar passed through). Illustrative numbers only. No network.

import { ok, type MockReply } from "./imports-fixtures";
import * as fx from "./stock-fixtures";

type Pair = [string, number | null];

const roll = (dates: string[], warm: number, f: (i: number) => number): Pair[] =>
  dates.map((d, i) => [d, i < warm ? null : Math.round(f(i) * 10000) / 10000]);

/** Indicators with full series over the same dates as `fx.bars(n)`. */
export function indicatorsWithSeries(n = 70, over: Record<string, unknown> = {}): MockReply {
  const b = fx.bars(n);
  const dates = b.map((x) => x[0]);
  const close = (i: number) => b[i]?.[4] ?? 0;
  const mean = (i: number, w: number) => {
    let s = 0;
    for (let k = i - w + 1; k <= i; k++) s += close(k);
    return s / w;
  };
  const last = n - 1;
  const base = fx.indicatorsFull();
  const data = base.body as { data: Record<string, unknown>; meta: unknown; warnings: unknown };
  const d = data.data;
  const tech = d["technicals"] as Record<string, unknown>;
  const dd = dates.map((x, i): Pair => [x, i === 0 ? 0 : -Math.round((i % 7) * 0.4 * 100) / 100]);
  const calendar = {
    dates: dates.slice(-30),
    values: dates
      .slice(-30)
      .map((_, i) => (i % 5 === 3 ? null : Math.round((i % 4) * 0.3 * 100) / 100 - 0.3)),
  };
  return ok({
    ...d,
    technicals: {
      ...tech,
      sma20: mean(last, 20),
      sma50: mean(last, 50),
      sma200: null,
      ema20: close(last) - 1,
      macd: 0.5,
      macd_signal: 0.4,
      macd_hist: 0.1,
      bb_pos: 0.75,
      atr14: 2,
      adx14: 25,
      plus_di14: 30,
      minus_di14: 12,
      stoch_k: 60,
      stoch_d: 55,
      obv: 123456,
      volume_z20: 1.2,
      high_52w: 130,
      low_52w: 90,
      dist_52w_high_pct: -11.5,
      golden_cross: false,
      death_cross: false,
      support: [{ price: 101.5, touches: 3 }],
      resistance: [{ price: 118, touches: 2 }],
    },
    null_reasons: {
      ...(d["null_reasons"] as object),
      sma200: "insufficient_history",
      beta_252: "no_benchmark",
    },
    series: {
      sma20: roll(dates, 19, (i) => mean(i, 20)),
      sma50: roll(dates, 49, (i) => mean(i, 50)),
      sma200: roll(dates, 199, (i) => mean(i, 200)),
      ema20: roll(dates, 19, (i) => close(i) - 0.7),
      rsi14: roll(dates, 14, (i) => 40 + (i % 30)),
      macd: {
        macd: roll(dates, 25, (i) => (i % 9) / 10),
        signal: roll(dates, 34, (i) => (i % 9) / 12),
        hist: roll(dates, 34, (i) => (i % 5) / 20 - 0.1),
      },
      bollinger: {
        upper: roll(dates, 19, (i) => mean(i, 20) + 3),
        middle: roll(dates, 19, (i) => mean(i, 20)),
        lower: roll(dates, 19, (i) => mean(i, 20) - 3),
      },
      adx14: {
        adx: roll(dates, 27, () => 25),
        plus_di: roll(dates, 14, () => 30),
        minus_di: roll(dates, 14, () => 12),
      },
      stochastic: {
        k: roll(dates, 13, (i) => 30 + (i % 50)),
        d: roll(dates, 15, (i) => 35 + (i % 40)),
      },
    },
    analysis: {
      drawdown: dd,
      rolling_vol_21: roll(dates, 21, (i) => 18 + (i % 5)),
      rolling_vol_63: roll(dates, 63, (i) => 20 + (i % 3)),
      rolling_beta_252: dates.map((x): Pair => [x, null]),
      return_histogram: {
        edges: [-2, -1, 0, 1, 2],
        counts: [3, 20, 25, 5],
        n: 53,
        unit: "percent",
      },
      month_year: [
        [2025, 11, 2.5],
        [2025, 12, -1.25],
        [2026, 1, 4.1],
        [2026, 2, null],
        [2026, 3, -6.8],
      ],
      calendar,
    },
    ...over,
  });
}

/** Weekly candles: the API answers meta.interval 1w above 2,000 daily bars. */
export function pricesWeekly(): MockReply {
  const r = fx.prices({ n: 120 }) as MockReply;
  const body = r.body as { meta: Record<string, unknown> };
  return { ...r, body: { ...body, meta: { ...body.meta, interval: "1w" } } };
}

/** `n` bars of a steady series for one stock (used for the 2,000-point test). */
export function manyBars(n: number) {
  const out: Array<[string, number, number, number, number, number]> = [];
  const start = Date.UTC(2018, 0, 1);
  for (let i = 0; i < n; i++) {
    const c = 100 + Math.sin(i / 20) * 10 + i * 0.01;
    out.push([
      new Date(start + i * 86_400_000).toISOString().slice(0, 10),
      c - 0.3,
      c + 1,
      c - 1,
      c,
      1000 + (i % 50),
    ]);
  }
  return out;
}
