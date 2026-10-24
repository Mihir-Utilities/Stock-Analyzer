import { z } from "zod";
import { apiRequest, type ApiResult } from "@/lib/api/client";
import {
  eventsSchema,
  fundamentalsSchema,
  indicatorsSchema,
  linksSchema,
  pricesSchema,
  profileSchema,
  watchlistSchema,
} from "./schemas";

const sym = (symbol: string) => `/stocks/${encodeURIComponent(symbol)}`;

export const stockKeys = {
  profile: (symbol: string) => ["stocks", symbol, "profile"] as const,
  prices: (symbol: string, range: string) => ["stocks", symbol, "prices", range] as const,
  indicators: (symbol: string) => ["stocks", symbol, "indicators"] as const,
  events: (symbol: string) => ["stocks", symbol, "events"] as const,
  fundamentals: (symbol: string) => ["stocks", symbol, "fundamentals"] as const,
  links: (symbol: string) => ["stocks", symbol, "links"] as const,
  watchlist: ["watchlist"] as const,
};

export const getProfile = (symbol: string) => apiRequest(sym(symbol), { schema: profileSchema });

/** The Overview and header use the adjusted 1Y series (docs/06 section 6.4: mini chart 1Y). */
export const getPrices = (symbol: string, range = "1Y") =>
  apiRequest(`${sym(symbol)}/prices`, { schema: pricesSchema, query: { range, adjusted: true } });

export const getIndicators = (symbol: string) =>
  apiRequest(`${sym(symbol)}/indicators`, { schema: indicatorsSchema });

export const getEvents = (symbol: string) =>
  apiRequest(`${sym(symbol)}/events`, { schema: eventsSchema });

export const getFundamentals = (symbol: string) =>
  apiRequest(`${sym(symbol)}/fundamentals`, { schema: fundamentalsSchema });

export const getLinks = (symbol: string) =>
  apiRequest(`${sym(symbol)}/links`, { schema: linksSchema });

export type Fetched<T extends (...a: never[]) => Promise<unknown>> = Awaited<ReturnType<T>>;
export type ProfileResult = Fetched<typeof getProfile>;
export type PricesResult = Fetched<typeof getPrices>;
export type IndicatorsResult = Fetched<typeof getIndicators>;
export type EventsResult = Fetched<typeof getEvents>;
export type FundamentalsResult = Fetched<typeof getFundamentals>;
export type LinksResult = Fetched<typeof getLinks>;
export type { ApiResult };

// ---- watchlist star (docs/03 section 11) ----------------------------------------------------

export async function getWatchlistId(symbol: string): Promise<number | null> {
  const r = await apiRequest("/watchlist", { schema: watchlistSchema });
  return r.data.stocks.find((s) => s.symbol.toUpperCase() === symbol.toUpperCase())?.id ?? null;
}

export async function addToWatchlist(symbol: string): Promise<void> {
  await apiRequest("/watchlist", {
    method: "POST",
    body: { type: "stock", symbol, note: "" },
    schema: z.unknown(),
  });
}

export async function removeFromWatchlist(id: number): Promise<void> {
  await apiRequest(`/watchlist/${id}`, { method: "DELETE", schema: z.unknown() });
}

// ---- refresh (broker mode only; inactive while the app runs in manual price mode, D-1) --------

const jobSchema = z.object({
  id: z.number(),
  status: z.string(),
  error: z.string().nullable().optional(),
});
const startedSchema = z.object({ job_id: z.number().optional(), id: z.number().optional() });

export async function startRefresh(symbol: string): Promise<number> {
  const r = await apiRequest(`${sym(symbol)}/refresh`, { method: "POST", schema: startedSchema });
  const id = r.data.job_id ?? r.data.id;
  if (id === undefined) throw new Error("refresh answered without a job id");
  return id;
}

export const getJob = (id: number) => apiRequest(`/jobs/${id}`, { schema: jobSchema });
