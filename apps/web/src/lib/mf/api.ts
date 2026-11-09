import { z } from "zod";
import { apiRequest, ApiError } from "@/lib/api/client";
import {
  categoriesSchema,
  compareSchema,
  detailSchema,
  navSchema,
  searchSchema,
  sipSchema,
  startedSchema,
  watchFundsSchema,
} from "./schemas";

// The browser only talks to the same-origin API; mfapi.in and AMFI are never called from here
// (CLAUDE.md section 7).

export interface SearchParams {
  q: string;
  category: string;
  fundHouse: string;
  plan: "direct" | "regular" | "any";
  option: "growth" | "idcw" | "any";
  includeAll: boolean;
  group: boolean;
}

export const SEARCH_PAGE_SIZE = 25;

export const mfKeys = {
  search: (p: SearchParams) => ["mf", "search", p] as const,
  categories: ["mf", "categories"] as const,
  detail: (code: number) => ["mf", code, "detail"] as const,
  nav: (code: number, range: string) => ["mf", code, "nav", range] as const,
  compare: (codes: string, range: string) => ["mf", "compare", codes, range] as const,
  watch: (code: number) => ["watchlist", "mf", code] as const,
};

export function searchQuery(p: SearchParams, cursor: string | undefined) {
  return {
    q: p.q.trim() || undefined,
    category: p.category || undefined,
    fund_house: p.fundHouse.trim() || undefined,
    plan: p.plan === "any" ? undefined : p.plan,
    option: p.option === "any" ? undefined : p.option,
    include_all: p.includeAll ? true : undefined,
    group: p.group ? true : undefined,
    limit: SEARCH_PAGE_SIZE,
    cursor,
  };
}

export const searchSchemes = (p: SearchParams, cursor: string | undefined, signal?: AbortSignal) =>
  apiRequest("/mf/schemes", {
    schema: searchSchema,
    query: searchQuery(p, cursor),
    ...(signal ? { signal } : {}),
  });

export const getCategories = () => apiRequest("/mf/categories", { schema: categoriesSchema });

export const getScheme = (code: number) =>
  apiRequest(`/mf/schemes/${code}`, { schema: detailSchema });

export const getNav = (code: number, range: string) =>
  apiRequest(`/mf/schemes/${code}/nav`, { schema: navSchema, query: { range } });

/** SIP simulation; the amount goes out as typed text (at most 2 decimals), never as a float. */
export const getSip = (code: number, amount: string, start: string, day: number, end?: string) =>
  apiRequest(`/mf/schemes/${code}/sip`, {
    schema: sipSchema,
    query: { amount, start, day, end: end || undefined },
  });

export const getCompare = (codes: string, range: string) =>
  apiRequest("/mf/compare", { schema: compareSchema, query: { codes, range } });

const jobSchema = z.object({
  id: z.number(),
  status: z.string(),
  error: z.string().nullable().optional(),
});

export const getMfJob = (id: number, signal?: AbortSignal) =>
  apiRequest(`/jobs/${id}`, { schema: jobSchema, ...(signal ? { signal } : {}) });

export const BUSY_COPY = "A refresh for this fund is already running. Try again in a minute.";

/** POST /mf/schemes/{code}/refresh: 202 a new job, 200 the already active job (same shape). */
export async function startMfRefresh(code: string): Promise<number> {
  try {
    const r = await apiRequest(`/mf/schemes/${encodeURIComponent(code)}/refresh`, {
      method: "POST",
      schema: startedSchema,
    });
    const id = r.data.job_id ?? r.data.id;
    if (id === undefined) throw new Error("refresh answered without a job id");
    return id;
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      throw new ApiError("BUSY", BUSY_COPY, 409, e.details, e.requestId);
    }
    throw e;
  }
}

// ---- watchlist star (docs/03 section 11: {type:"mf", code}) ------------------------------------

export async function getMfWatchId(code: number): Promise<number | null> {
  const r = await apiRequest("/watchlist", { schema: watchFundsSchema });
  return r.data.funds.find((f) => f.code === code)?.id ?? null;
}

export async function addMfWatch(code: number): Promise<void> {
  await apiRequest("/watchlist", {
    method: "POST",
    body: { type: "mf", code },
    schema: z.unknown(),
  });
}

export async function removeMfWatch(id: number): Promise<void> {
  await apiRequest(`/watchlist/${id}`, { method: "DELETE", schema: z.unknown() });
}
