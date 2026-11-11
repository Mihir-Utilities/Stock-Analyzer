import { z } from "zod";
import { holdingSchema, type Holding, type PortfolioSummary } from "./schemas";

// Response shapes of docs/03 section 12a (summary views, MF holdings, MF transactions, fund-name
// mappings). Degrade per field: every optional field falls back to null on a bad value, the
// heavy sections are validated row by row where they are drawn, so one bad field or row never
// blanks a view. Money fields are decimal STRINGS with 4 decimals, percent fields are percent
// numbers, unknown values are null with a sibling `*_reason`, never 0.

const s = z.string().nullish().catch(null);
const n = z.number().nullish().catch(null);
const b = z.boolean().nullish().catch(null);

/** Parse a raw section; null when it is missing or unreadable (the section then shows its own error). */
export function readSection<T extends z.ZodType>(schema: T, raw: unknown): z.infer<T> | null {
  if (raw === undefined || raw === null) return null;
  const r = schema.safeParse(raw);
  return r.success ? r.data : null;
}

/** Parse rows one by one: readable rows are kept, `bad` counts the rest. `ok` is false for a non-array. */
export function readRows<T extends z.ZodType>(
  schema: T,
  raw: unknown,
): { ok: boolean; rows: z.infer<T>[]; bad: number } {
  if (!Array.isArray(raw)) return { ok: raw === undefined || raw === null, rows: [], bad: 0 };
  const rows: z.infer<T>[] = [];
  let bad = 0;
  for (const item of raw) {
    const r = schema.safeParse(item);
    if (r.success) rows.push(r.data);
    else bad += 1;
  }
  return { ok: true, rows, bad };
}

export const mfHoldingSchema = z.object({
  scheme_code: z.number(),
  scheme_name: z.string().catch("Unnamed scheme"),
  fund_house: s,
  category: s,
  plan: z.string().catch("unknown"),
  option: z.string().catch("unknown"),
  isin: s,
  folio: s,
  folios: z.array(z.string()).nullish().catch(null),
  units: z.string().catch(""),
  avg_cost: s,
  invested: z.string().catch(""),
  nav: s,
  nav_date: s,
  nav_stale: b,
  nav_reason: s,
  market_value: s,
  unrealized_pnl: s,
  unrealized_pct: n,
  unrealized_pct_reason: s,
  realized_pnl: s,
  idcw_income: s,
  day_change: s,
  day_change_reason: s,
  weight_pct: n,
  xirr_pct: n,
  xirr_reason: s,
  absolute_return_pct: n,
  first_txn_date: s,
  span_days: n,
  exited: b,
  flags: z.array(z.string()).nullish().catch(null),
  source: s,
});
export type MfHolding = z.infer<typeof mfHoldingSchema>;

export const mfTotalsSchema = z.object({
  invested: s,
  market_value: s,
  market_value_reason: s,
  unrealized_pnl: s,
  unrealized_pct: n,
  realized_pnl: s,
  idcw_income: s,
  total_pnl: s,
  total_pnl_reason: s,
  purchase_cash: s,
  day_change: s,
  day_change_reason: s,
});

export const mfHoldingsResponseSchema = z.object({
  items: z.unknown(),
  totals: z.unknown().optional(),
});

export const shareSchema = z.object({ key: z.string(), weight_pct: z.number() });
export type Share = z.infer<typeof shareSchema>;

export const breakdownRowSchema = z.object({
  asset_class: z.string(),
  invested: s,
  market_value: s,
  market_value_reason: s,
  unrealized_pnl: s,
  realized_pnl: s,
  idcw_income: s,
  total_pnl: s,
  xirr_pct: n,
  xirr_reason: s,
  absolute_return_pct: n,
  as_of: s,
  stale: b,
});
export type BreakdownRow = z.infer<typeof breakdownRowSchema>;

/**
 * `GET /portfolio/summary?view=` (docs/03 12a). Fields of the pre-D-MF contract keep their meaning;
 * the new fields are additive. The sections below are `unknown` here and read where drawn
 * (readRows / readSection), which is what keeps one malformed section from blanking the page.
 */
export const viewSummarySchema = z.object({
  view: s,
  as_of: s,
  asset_classes_present: z.array(z.string()).nullish().catch(null),
  totals: z
    .object({
      invested: s,
      market_value: s,
      market_value_reason: s,
      unrealized_pnl: s,
      unrealized_pct: n,
      unrealized_pct_reason: s,
      realized_pnl: s,
      day_change: s,
      day_change_reason: s,
      idcw_income: s,
      total_pnl: s,
      total_pnl_reason: s,
      purchase_cash: s,
    })
    .catch({
      invested: null,
      market_value: null,
      market_value_reason: null,
      unrealized_pnl: null,
      unrealized_pct: null,
      unrealized_pct_reason: null,
      realized_pnl: null,
      day_change: null,
      day_change_reason: null,
      idcw_income: null,
      total_pnl: null,
      total_pnl_reason: null,
      purchase_cash: null,
    }),
  returns: z
    .object({
      xirr_pct: n,
      xirr_reason: s,
      absolute_return_pct: n,
      absolute_return_basis: s,
      span_days: n,
      first_flow_date: s,
    })
    .catch({
      xirr_pct: null,
      xirr_reason: "unreadable",
      absolute_return_pct: null,
      absolute_return_basis: null,
      span_days: null,
      first_flow_date: null,
    }),
  benchmark: z
    .object({
      code: s,
      xirr_pct: n,
      reason: s,
      level_as_of: s,
      note: s,
    })
    .nullish()
    .catch(null),
  holdings: z.unknown().optional(),
  mf_holdings: z.unknown().optional(),
  breakdown: z.unknown().optional(),
  allocation_by_stock: z.unknown().optional(),
  allocation_by_sector: z.unknown().optional(),
  allocation_by_scheme: z.unknown().optional(),
  allocation_by_category: z.unknown().optional(),
  allocation_by_asset_class: z.unknown().optional(),
  allocation_excludes_unpriced: b,
  estimated_dividends: z.unknown().optional(),
});
export type ViewSummary = z.infer<typeof viewSummarySchema>;

export const equityHoldingRowSchema = holdingSchema;
export type EquityHolding = Holding;

export const mfTxnSchema = z.object({
  id: z.number(),
  scheme_code: z.number(),
  scheme_name: z.string().catch("Unnamed scheme"),
  isin: s,
  plan: z.string().catch("unknown"),
  option: z.string().catch("unknown"),
  // An unreadable folio or stamp duty is null (shown as a dash), never an empty text or 0.
  folio: s,
  txn_type: z.string(),
  txn_date: z.string(),
  units: z.string(),
  nav: z.string(),
  amount: z.string(),
  stamp_duty: s,
  external_ref: s,
  source: z.string().catch("manual"),
  import_batch_id: n,
  note: s,
});
export type MfTxn = z.infer<typeof mfTxnSchema>;

export const mfTxnPageSchema = z.object({
  items: z.array(z.unknown()),
  next_cursor: z.string().nullish().catch(null),
});

/** Delete answer: `warnings[]` is a plain list (docs/03 12a); create/patch warnings ride in the envelope. */
export const mfTxnDeletedSchema = z.object({
  deleted: z.number(),
  warnings: z.array(z.unknown()).nullish().catch(null),
});

export const mfMappingSchema = z.object({
  fund_name: z.string(),
  fund_name_key: s,
  scheme_code: z.number(),
  scheme_name: z.string().catch("Unnamed scheme"),
  plan: z.string().catch("unknown"),
  option: z.string().catch("unknown"),
  isin: s,
  rows: z.number().catch(0),
  created_at: s,
  updated_at: s,
  audit_note: s,
});
export type MfMapping = z.infer<typeof mfMappingSchema>;

export const mfMappingListSchema = z.object({ items: z.array(z.unknown()) });

const dividendsSchema = z.object({
  amount: s,
  label: s,
  items: z
    .array(
      z.object({
        symbol: z.string(),
        ex_date: z.string(),
        qty: z.string(),
        amount_per_share: z.string(),
        amount: z.string(),
        qty_as_of: s,
      }),
    )
    .nullish()
    .catch(null),
});

/** Everything of a view read section by section: what is readable is used, the rest is named. */
export interface ReadView {
  /** The pre-D-MF shape the stock components take (holdings, allocation, dividends). */
  legacy: PortfolioSummary;
  mfHoldings: MfHolding[];
  breakdown: BreakdownRow[];
  allocScheme: Share[];
  allocCategory: Share[];
  allocClass: Share[];
  /** Sections that were present but unreadable, by name; rows dropped are counted in `badRows`. */
  unreadable: string[];
  badRows: number;
}

/**
 * `view` decides what the stock components get as their totals. In `all` the API totals are the
 * stocks plus the funds, so the stock sleeve takes its own row of `breakdown` (an unknown figure is
 * null, never a combined one); in `equity` the totals are the stock totals already.
 */
export function readView(v: ViewSummary, view: "all" | "equity" | "mf" = "equity"): ReadView {
  const unreadable: string[] = [];
  let badRows = 0;
  const rows = <T extends z.ZodType>(name: string, schema: T, raw: unknown): z.infer<T>[] => {
    const r = readRows(schema, raw);
    if (!r.ok) unreadable.push(name);
    badRows += r.bad;
    return r.rows;
  };
  const holdings = rows("stock holdings", holdingSchema, v.holdings);
  const allocStock = rows("stock allocation", shareSchema, v.allocation_by_stock);
  const allocSector = rows("sector allocation", shareSchema, v.allocation_by_sector);
  const mfHoldings = rows("mutual fund holdings", mfHoldingSchema, v.mf_holdings);
  const breakdown = rows("breakdown", breakdownRowSchema, v.breakdown);
  const allocScheme = rows("scheme allocation", shareSchema, v.allocation_by_scheme);
  const allocCategory = rows("category allocation", shareSchema, v.allocation_by_category);
  const allocClass = rows("asset class allocation", shareSchema, v.allocation_by_asset_class);
  const divRaw = readSection(dividendsSchema, v.estimated_dividends);
  if (v.estimated_dividends !== undefined && v.estimated_dividends !== null && divRaw === null) {
    unreadable.push("estimated dividends");
  }
  const eq = breakdown.find((r) => r.asset_class === "equity");
  const t =
    view === "all"
      ? {
          invested: eq?.invested ?? null,
          market_value: eq?.market_value ?? null,
          market_value_reason: eq?.market_value_reason ?? null,
          unrealized_pnl: eq?.unrealized_pnl ?? null,
          unrealized_pct: null,
          realized_pnl: eq?.realized_pnl ?? null,
          day_change: null,
          day_change_reason: null,
        }
      : v.totals;
  // Without a readable realised figure the stock components must not sum, so unrealised goes null too.
  const realizedKnown = typeof t.realized_pnl === "string";
  const legacy: PortfolioSummary = {
    as_of: v.as_of ?? null,
    currency: "INR",
    holdings,
    totals: {
      invested: t.invested ?? "",
      market_value: t.market_value ?? null,
      market_value_reason: t.market_value_reason ?? null,
      unrealized_pnl: realizedKnown ? (t.unrealized_pnl ?? null) : null,
      unrealized_pct: t.unrealized_pct ?? null,
      realized_pnl: t.realized_pnl ?? "",
      day_change: t.day_change ?? null,
      day_change_reason: t.day_change_reason ?? null,
    },
    returns: {
      xirr_pct: v.returns.xirr_pct ?? null,
      xirr_reason: v.returns.xirr_reason ?? null,
      absolute_return_pct: v.returns.absolute_return_pct ?? null,
      absolute_return_basis: v.returns.absolute_return_basis ?? null,
    },
    benchmark: {
      code: v.benchmark?.code ?? null,
      xirr_pct: v.benchmark?.xirr_pct ?? null,
      reason: v.benchmark?.reason ?? null,
      level_as_of: v.benchmark?.level_as_of ?? null,
      note: v.benchmark?.note ?? null,
    },
    allocation_by_stock: allocStock,
    allocation_by_sector: allocSector,
    // In All the flag also covers unpriced funds; the stock sections only care about stocks.
    allocation_excludes_unpriced:
      view === "all"
        ? holdings.some(
            (h) => !h.exited && (h.market_value === null || h.market_value === undefined),
          )
        : (v.allocation_excludes_unpriced ?? null),
    estimated_dividends: {
      amount: divRaw?.amount ?? null,
      label: divRaw?.label ?? null,
      items: divRaw?.items ?? null,
    },
  };
  return {
    legacy,
    mfHoldings,
    breakdown,
    allocScheme,
    allocCategory,
    allocClass,
    unreadable,
    badRows,
  };
}
