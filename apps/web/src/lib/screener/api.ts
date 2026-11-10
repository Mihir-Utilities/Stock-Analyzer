import { apiRequest } from "@/lib/api/client";
import {
  compareSchema,
  okSchema,
  peersResponseSchema,
  savedListSchema,
  savedScreenSchema,
  screenerPageSchema,
  type ScreenerPage,
} from "./schemas";
import type { QueryBody, SavedBody } from "./spec";

// B13 routes (docs/03 sections 5, 8, 9). User input never reaches a URL unencoded: symbols and
// names go through `encodeURIComponent`, everything else travels in the JSON body or the query
// builder of the shared client.

type Request = typeof apiRequest;

export const screenerKeys = {
  saved: ["screener", "saved"] as const,
  query: (body: string) => ["screener", "query", body] as const,
  compare: (symbols: string, range: string) => ["compare", symbols, range] as const,
  peers: (symbol: string, add: string, remove: string) =>
    ["stocks", symbol, "peers", add, remove] as const,
};

export interface ScreenerPageResult extends ScreenerPage {
  /** `meta.excluded_for_missing`: per filtered metric, stocks that lack it. */
  excluded: Record<string, number>;
}

export async function runScreen(
  body: QueryBody,
  cursor: string | undefined,
  signal?: AbortSignal,
  request: Request = apiRequest,
): Promise<ScreenerPageResult> {
  const { data, meta } = await request("/screener/query", {
    method: "POST",
    schema: screenerPageSchema,
    body: { ...body, cursor: cursor ?? null },
    signal,
  });
  return { ...data, excluded: meta?.excluded_for_missing ?? {} };
}

export const getSaved = (request: Request = apiRequest) =>
  request("/screener/saved", { schema: savedListSchema }).then((r) => r.data);

/** 201 for a new name, 200 when a screen of that name (case-insensitive) was replaced. */
export const saveScreen = (body: SavedBody, request: Request = apiRequest) =>
  request("/screener/saved", { method: "POST", schema: savedScreenSchema, body }).then(
    (r) => r.data,
  );

export const deleteScreen = (name: string, request: Request = apiRequest) =>
  request(`/screener/saved/${encodeURIComponent(name)}`, {
    method: "DELETE",
    schema: okSchema,
  }).then((r) => r.data);

export const getCompare = (
  symbols: string[],
  range: string,
  signal?: AbortSignal,
  request: Request = apiRequest,
) =>
  request("/compare", {
    schema: compareSchema,
    query: { symbols: symbols.join(","), range },
    signal,
  });

/** `add` and `remove` are temporary overrides for this view (at most 10 symbols each). */
export const getPeers = (
  symbol: string,
  over: { add: string[]; remove: string[] } = { add: [], remove: [] },
  request: Request = apiRequest,
) =>
  request(`/stocks/${encodeURIComponent(symbol)}/peers`, {
    schema: peersResponseSchema,
    query: {
      ...(over.add.length > 0 ? { add: over.add.join(",") } : {}),
      ...(over.remove.length > 0 ? { remove: over.remove.join(",") } : {}),
    },
  }).then((r) => r.data);
