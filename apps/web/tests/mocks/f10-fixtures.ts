import type { MockReply } from "./imports-fixtures";

// B13 response shapes (docs/03 sections 5, 8, 9) with fixed dates; no clock, no randomness.

const env = (data: unknown, meta: Record<string, unknown> = {}): MockReply => ({
  status: 200,
  body: { data, meta, warnings: [] },
});

export const UNITS = {
  market_cap_cr: "INR_CR",
  price: "INR",
  pe: "RATIO",
  roe: "PERCENT",
  debt_equity: "RATIO",
  quality_score: "SCORE_0_100",
  sector: "TEXT",
};

export interface ItemOpts {
  values?: Record<string, number | string | null>;
  value_reasons?: Record<string, string>;
  coverage?: number;
  last_updated?: string | null;
  last_updated_source?: string | null;
  stale?: boolean;
  stale_reason?: string | null;
  name?: string;
}

export function item(symbol: string, o: ItemOpts = {}) {
  return {
    symbol,
    name: o.name ?? `${symbol} Ltd`,
    as_of: "2026-11-09",
    values: o.values ?? { roe: 18.5, market_cap_cr: 250000, pe: 24.3, quality_score: 71.2 },
    value_reasons: o.value_reasons ?? {},
    coverage: o.coverage ?? 0.83,
    last_updated: o.last_updated === undefined ? "2026-10-20" : o.last_updated,
    last_updated_source:
      o.last_updated_source === undefined ? "fundamentals" : o.last_updated_source,
    stale: o.stale ?? false,
    stale_reason: o.stale_reason ?? null,
  };
}

export function screener(
  items: unknown[],
  o: { next?: string | null; total?: number | null; excluded?: Record<string, number> } = {},
): MockReply {
  return env(
    {
      items,
      next_cursor: o.next ?? null,
      total: o.total === undefined ? items.length : o.total,
      units: UNITS,
    },
    { excluded_for_missing: o.excluded ?? {} },
  );
}

export const PRESETS = [
  {
    name: "Quality",
    spec: {
      filters: [
        { metric: "roe", op: ">", value: 15 },
        { metric: "debt_equity", op: "<", value: 0.5 },
      ],
      universe: { kind: "equity" },
    },
  },
  {
    name: "Value",
    spec: {
      filters: [{ metric: "pe", op: "between", value: [5, 15] }],
      sort: { metric: "pe", dir: "asc" },
      universe: { kind: "equity" },
    },
  },
];

export function saved(names: string[] = []): MockReply {
  return env({
    items: names.map((name) => ({
      name,
      spec: { filters: [{ metric: "roe", op: ">", value: 20 }], universe: { kind: "equity" } },
      saved_at: "2026-11-01T04:00:00Z",
    })),
    next_cursor: null,
    max_saved: 30,
    presets: PRESETS,
  });
}

export const savedOne = (name: string, status = 201): MockReply => ({
  status,
  body: {
    data: {
      name,
      spec: { filters: [], universe: { kind: "equity" } },
      saved_at: "2026-11-10T04:00:00Z",
    },
    meta: {},
    warnings: [],
  },
});

export const err = (
  status: number,
  code: string,
  message: string,
  details?: unknown,
): MockReply => ({
  status,
  headers: { "X-Request-Id": "req-f10" },
  body: { error: { code, message, request_id: "req-f10", ...(details ? { details } : {}) } },
});

function stamp(stale: boolean) {
  return {
    last_updated: stale ? "2026-05-01" : "2026-10-20",
    last_updated_source: "fundamentals",
    stale,
    stale_reason: stale ? "fundamentals_older_than_120_days" : null,
  };
}

export function compare(
  o: { noCommon?: boolean; staleB?: boolean; shortB?: boolean; noPricesC?: boolean } = {},
): MockReply {
  const dates = o.noCommon ? [] : ["2026-11-03", "2026-11-04", "2026-11-05"];
  const symbols: Array<Record<string, unknown>> = [
    {
      symbol: "TCS",
      name: "Tata Consultancy Services Ltd",
      bars: 250,
      first_date: "2025-11-10",
      last_date: "2026-11-09",
      short_history: false,
      prices_reason: null,
      metrics_as_of: "2026-11-09",
      ...stamp(false),
    },
    {
      symbol: "M&M",
      name: "Mahindra and Mahindra Ltd",
      bars: o.shortB ? 90 : 250,
      first_date: "2025-11-10",
      last_date: "2026-11-09",
      short_history: o.shortB ?? false,
      prices_reason: null,
      metrics_as_of: "2026-11-09",
      ...stamp(o.staleB ?? false),
    },
  ];
  const series: Record<string, number[] | null> = o.noCommon
    ? { TCS: null, "M&M": null }
    : { TCS: [100, 101.5, 103.2], "M&M": [100, 99.1, 102.4] };
  if (o.noPricesC) {
    symbols.push({
      symbol: "INFY",
      name: "Infosys Ltd",
      bars: 0,
      first_date: null,
      last_date: null,
      short_history: true,
      prices_reason: "no_prices_in_range",
      metrics_as_of: "2026-11-09",
      ...stamp(false),
    });
    series["INFY"] = null;
  }
  return env({
    range: "1Y",
    symbols,
    rebased: {
      base_date: o.noCommon ? null : "2026-11-03",
      dates,
      series,
      unit: "INDEX_BASE_100",
      reason: o.noCommon ? "no_common_dates" : null,
    },
    metrics: {
      TCS: { pe: 24.3, roe: 45.1, market_cap_cr: 1250000, debt_equity: null },
      "M&M": { pe: 18.2, roe: 16.4, market_cap_cr: 350000, debt_equity: 0.9 },
      ...(o.noPricesC
        ? { INFY: { pe: 24.3, roe: 30, market_cap_cr: 600000, debt_equity: null } }
        : {}),
    },
    metric_reasons: {
      TCS: { debt_equity: "not_available" },
      "M&M": {},
      ...(o.noPricesC ? { INFY: { debt_equity: "not_available" } } : {}),
    },
    units: { pe: "RATIO", roe: "PERCENT", market_cap_cr: "INR_CR", debt_equity: "RATIO" },
    best: { pe: "M&M", roe: "TCS", debt_equity: null },
  });
}

function peer(symbol: string, origin: string, extra: Record<string, unknown> = {}) {
  return {
    symbol,
    name: `${symbol} Ltd`,
    origin,
    market_cap_cr: 250000,
    ret_1y: 12.5,
    pe: 24.3,
    pb: 6.1,
    roe: 18.5,
    rev_growth_3y: 11.2,
    op_margin: 24,
    debt_equity: null,
    value_reasons: { debt_equity: "not_available" },
    percentile_rank: { pe: 30, roe: 80, debt_equity: null },
    as_of: "2026-11-09",
    last_updated: "2026-10-20",
    last_updated_source: "fundamentals",
    stale: false,
    stale_reason: null,
    ...extra,
  };
}

export function peers(
  o: { note?: string | null; basis?: string; stalePeer?: boolean; added?: string[] } = {},
): MockReply {
  return env({
    symbol: "TCS",
    sector: "Information Technology",
    industry: "IT Services",
    basis: o.basis ?? "industry",
    market_cap_band: "0.25-4",
    note: o.note ?? null,
    units: { market_cap_cr: "INR_CR", pe: "RATIO", roe: "PERCENT", ret_1y: "PERCENT" },
    peers: [
      peer(
        "INFY",
        "auto",
        o.stalePeer
          ? {
              stale: true,
              stale_reason: "no_owner_data",
              last_updated: null,
              last_updated_source: null,
            }
          : {},
      ),
      peer("WIPRO", "auto", { pe: null, value_reasons: { pe: "not_available" } }),
      ...(o.added ?? []).map((s) => peer(s, "added")),
    ],
    self: peer("TCS", "self"),
    percentile_method: "share of values at or below, among the peers and this stock",
  });
}

export const FIXED = { env };
