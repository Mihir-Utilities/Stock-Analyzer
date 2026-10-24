// Mock API answers for the import screens, shaped after openapi.yaml and docs/03 sections 4 and 14
// (contract-first: the UI is developed against these, not against a running API). No network.

export interface MockReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export const ok = (data: unknown, status = 200): MockReply => ({
  status,
  body: {
    data,
    meta: { as_of: "2026-10-24T09:00:00Z", source: "import", stale: false },
    warnings: [],
  },
});

export const fail = (
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): MockReply => ({ status, body: { error: { code, message, ...(details ? { details } : {}) } } });

export const pricesPreview = [
  {
    symbol: "TCS",
    date: "2026-10-20",
    open: 4000,
    high: 4050,
    low: 3990,
    close: 4040,
    volume: 1200,
  },
  {
    symbol: "TCS",
    date: "2026-10-21",
    open: 4040,
    high: 4100,
    low: 4030,
    close: 4090,
    volume: 1500,
  },
];

export const validPrices = {
  upload_id: "11111111-1111-4111-8111-111111111111",
  upload_group: null,
  rows: 2,
  preview: pricesPreview,
  errors: [],
  warnings: [],
  error_count: 0,
  warning_count: 0,
  estimated_growth_mb: 0.0002,
  prices_already_adjusted: null,
};

export const invalidPrices = {
  ...validPrices,
  upload_id: "22222222-2222-4222-8222-222222222222",
  rows: 3,
  preview: [pricesPreview[0]],
  errors: [
    { row: 3, column: "close", message: "close must be a number greater than 0" },
    { row: 5, column: "date", message: "date 05-10-26 is ambiguous; use YYYY-MM-DD" },
  ],
  error_count: 2,
};

export const headerErrorPrices = {
  ...validPrices,
  upload_id: "33333333-3333-4333-8333-333333333333",
  rows: 0,
  preview: [],
  errors: [
    {
      row: 0,
      column: "",
      message:
        'Wrong column names: unknown column "px". Expected: symbol,date,open,high,low,close,volume. Template: /api/v1/imports/templates/prices',
    },
  ],
  error_count: 1,
};

export const validInstruments = {
  upload_id: "44444444-4444-4444-8444-444444444444",
  upload_group: null,
  rows: 2,
  preview: [
    { symbol: "TCS", name: "Tata Consultancy Services Ltd", action: "insert" },
    { symbol: "INFY", name: "Infosys Ltd", action: "update" },
  ],
  errors: [],
  warnings: [{ row: 3, column: "isin", message: 'isin "X" is not a valid ISIN; stored as empty' }],
  error_count: 0,
  warning_count: 1,
  estimated_growth_mb: null,
  prices_already_adjusted: null,
};

export const commitOk = {
  batch_id: 7,
  inserted: 2,
  updated: 0,
  renamed: 0,
  post_import_job_id: 14,
  warnings: [] as string[],
};

export const adjustmentRawLikely = {
  bars: [
    ["2026-06-11", 2000],
    ["2026-06-12", 1000],
  ],
  ratio: 0.5,
  nearest_fraction: "1/2",
  hint: "raw_likely",
};

export const dbStatus = (sizeMb: number, warn?: string) =>
  ok({
    sources: [],
    jobs: [],
    db: { size_mb: sizeMb, ...(warn ? { warn_level: warn } : {}) },
  });

export const stockIndex = ok({
  generated_at: "2026-10-24T08:00:00Z",
  count: 3,
  items: [
    [1, "TCS", "Tata Consultancy Services Ltd", 2],
    [2, "INFY", "Infosys Ltd", 2],
    [3, "IDLE", "Untracked Ltd", 0],
  ],
});

export const trimPreview = {
  per_symbol: [
    { symbol: "TCS", rows: 120 },
    { symbol: "INFY", rows: 80 },
  ],
  total_rows: 200,
  estimated_mb_freed: 0.02,
};
