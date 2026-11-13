// Contract-shaped `analysis.relative_strength` (docs/03 section 4a.RST) built from the golden
// vectors of docs/05 12.14 (RA1/RA2/RP2). Illustrative; no network.

export type Pair = [string, number | null];

/** `n` consecutive calendar dates (ISO) ending on 2024-02-15, as the `analysis.drawdown` pairs the card reads. */
export function drawdownPairs(n: number): Pair[] {
  const end = Date.UTC(2024, 1, 15);
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(end - (n - 1 - i) * 86_400_000);
    return [d.toISOString().slice(0, 10), -(i % 4)] as Pair;
  });
}

const windows = [
  {
    key: "1m",
    rows: 21,
    base_date: "2024-01-12",
    stock_pct: -3.1,
    index_pct: 0.9,
    excess_pp: -4.0,
    reason: null,
  },
  {
    key: "3m",
    rows: 63,
    base_date: "2023-11-14",
    stock_pct: 6.25,
    index_pct: 2.25,
    excess_pp: 4.0,
    reason: null,
  },
  {
    key: "6m",
    rows: 126,
    base_date: "2023-08-10",
    stock_pct: 12.5,
    index_pct: 8.0,
    excess_pp: 4.5,
    reason: null,
  },
  {
    key: "1y",
    rows: 252,
    base_date: null,
    stock_pct: null,
    index_pct: null,
    excess_pp: null,
    reason: "insufficient_overlap",
  },
];

export function vsIndex(n: number, over: Record<string, unknown> = {}) {
  return {
    index_code: "NIFTY50",
    index_as_of: "2024-02-15",
    index_rows: 2465,
    aligned_rows: n - 2,
    first_aligned: "2023-12-07",
    last_aligned: "2024-02-15",
    dropped_stock_dates: 2,
    dropped_index_dates: 3,
    windows,
    years: [
      {
        year: 2023,
        kind: "full",
        base_date: "2022-12-30",
        end_date: "2023-12-29",
        stock_pct: 12.0,
        index_pct: 19.4,
        excess_pp: -7.4,
      },
      {
        year: 2024,
        kind: "ytd",
        base_date: "2023-12-29",
        end_date: "2024-02-15",
        stock_pct: -10.0,
        index_pct: 10.0,
        excess_pp: -20.0,
      },
    ],
    rolling_year: {
      windows: 76,
      independent_periods: 1,
      share_beat_pct: 61.84,
      median_excess_pp: 3.2,
      small_sample: true,
      reason: null,
    },
    ratio_rebased: Array.from({ length: n }, (_, i) => (i % 17 === 5 ? null : 100 + i * 0.1)),
    ratio_base_date: "2023-12-07",
    ratio_reason: null,
    ...over,
  };
}

export function vsPeers(over: Record<string, unknown> = {}) {
  const row = (
    key: string,
    rows: number,
    rank: number | null,
    extra: Record<string, unknown> = {},
  ) => ({
    key,
    rows,
    stock_pct: 4.2,
    n_peers: rank === null ? 2 : 5,
    n_total: rank === null ? null : 6,
    rank,
    percentile: rank === null ? null : 75.0,
    peer_median_pct: rank === null ? null : 1.9,
    vs_median_pp: rank === null ? null : 2.3,
    base_date: rank === null ? null : "2023-11-14",
    small_sample: rank !== null,
    reason: rank === null ? "too_few_peers" : null,
    ...extra,
  });
  return {
    sector: "Banks",
    as_of: "2024-02-15",
    peers_in_sector: 6,
    excluded: 1,
    windows: [row("3m", 63, 2), row("6m", 126, 3, { small_sample: false }), row("1y", 252, null)],
    ...over,
  };
}

export function relativeStrength(n: number, over: Record<string, unknown> = {}) {
  return {
    as_of: "2024-02-15",
    bars: 330,
    basis: "price return (adj_close), excludes dividends",
    vs_index: vsIndex(n),
    vs_index_reason: null,
    vs_peers: vsPeers(),
    vs_peers_reason: null,
    ...over,
  };
}
