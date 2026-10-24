import { z } from "zod";
import { apiRequest } from "@/lib/api/client";
import { FLAG, type IndexItem } from "./rank";

// Search endpoints (docs/03 sections 3 and 14), zod-validated. The browser only talks to the
// same-origin /api rewrite; the Go API never calls third parties for these.

type Request = typeof apiRequest;

const stockIndexSchema = z.object({
  generated_at: z.string(),
  count: z.number(),
  items: z.array(z.tuple([z.number(), z.string(), z.string(), z.number()])),
});

export async function fetchStockIndex(
  request: Request = apiRequest,
  signal?: AbortSignal,
): Promise<{ generatedAt: string; items: IndexItem[] }> {
  const { data } = await request("/stocks/index", { schema: stockIndexSchema, signal });
  return { generatedAt: data.generated_at, items: data.items };
}

const stockSearchSchema = z.object({
  items: z.array(
    z.object({
      id: z.number(),
      symbol: z.string(),
      name: z.string(),
      status: z.string().optional(),
      instrument_kind: z.string().optional(),
    }),
  ),
});

/** Server fallback when the index cannot be loaded: GET /stocks?q= . */
export async function searchStocksServer(
  q: string,
  request: Request = apiRequest,
  signal?: AbortSignal,
): Promise<IndexItem[]> {
  const { data } = await request("/stocks", {
    schema: stockSearchSchema,
    query: { q, limit: 12 },
    signal,
  });
  return data.items.map((s) => {
    let flags = 0;
    if (s.status === "suspended") flags |= FLAG.suspended;
    if (s.status === "delisted") flags |= FLAG.delisted;
    if (s.instrument_kind !== undefined && s.instrument_kind !== "equity") flags |= FLAG.nonEquity;
    return [s.id, s.symbol, s.name, flags] as const;
  });
}

const fundSearchSchema = z.object({
  items: z.array(
    z.object({
      code: z.number(),
      name: z.string(),
      fund_house: z.string().nullable().optional(),
      category: z.string().nullable().optional(),
    }),
  ),
});

export interface FundHit {
  code: number;
  name: string;
  sub: string;
}

export const FUND_RESULT_LIMIT = 6;

/** Funds via the server (trigram search on `mf_scheme`); the palette debounces calls by 250 ms. */
export async function searchFunds(
  q: string,
  request: Request = apiRequest,
  signal?: AbortSignal,
): Promise<FundHit[]> {
  const { data } = await request("/mf/schemes", {
    schema: fundSearchSchema,
    query: { q, limit: FUND_RESULT_LIMIT },
    signal,
  });
  return data.items.map((f) => ({
    code: f.code,
    name: f.name,
    sub: [f.fund_house, f.category].filter((x): x is string => !!x).join(" | "),
  }));
}
