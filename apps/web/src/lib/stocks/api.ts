import { z } from "zod";
import { apiRequest } from "@/lib/api/client";

// GET /stocks (docs/03 section 3, B03): alphabetical without `q`, ranked with it, keyset cursor.
// The browse page shows only what this list returns; it never fans out per-row requests.

type Request = typeof apiRequest;

export const STOCK_KINDS = ["equity", "etf", "reit", "invit", "sme", "other"] as const;
export const STOCK_STATUSES = ["active", "suspended", "delisted", "symbol_changed"] as const;
export const BROWSE_PAGE_SIZE = 50;

const text = z.string().nullable().optional();

export const stockRowSchema = z.object({
  id: z.number(),
  symbol: z.string(),
  name: z.string(),
  isin: text,
  series: text,
  sector: text,
  industry: text,
  company_type: text,
  status: z.string(),
  instrument_kind: z.string(),
  tracked: z.boolean(),
});
export type StockRow = z.infer<typeof stockRowSchema>;

const pageSchema = z.object({
  items: z.array(stockRowSchema),
  next_cursor: z.string().nullable().optional(),
});
export type StockPage = z.infer<typeof pageSchema>;

export interface BrowseParams {
  q: string;
  kind: string;
  status: string;
  sector: string;
}

export const stocksKeys = {
  list: (p: BrowseParams) => ["stocks", "browse", p] as const,
};

/** `q` must be 1-100 characters after trimming (else 422), so an empty box sends no `q`. */
export async function listStocks(
  p: BrowseParams,
  cursor: string | undefined,
  signal?: AbortSignal,
  request: Request = apiRequest,
): Promise<StockPage> {
  const q = p.q.trim();
  const sector = p.sector.trim();
  const { data } = await request("/stocks", {
    schema: pageSchema,
    query: {
      limit: BROWSE_PAGE_SIZE,
      kind: p.kind,
      status: p.status,
      ...(q ? { q } : {}),
      ...(sector ? { sector } : {}),
      ...(cursor ? { cursor } : {}),
    },
    signal,
  });
  return data;
}
