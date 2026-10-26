"use client";

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { apiRequest } from "@/lib/api/client";
import { dashboardKeys } from "@/lib/dashboard/queries";
import {
  adjustmentSchema,
  adjustmentsSchema,
  deletedSchema,
  holidaysSchema,
  portfolioSummarySchema,
  txnPageSchema,
  txnSchema,
  watchEntrySchema,
  watchlistFullSchema,
} from "./schemas";
import type { Attempt, TxnBody } from "./txn-form";

// Hooks for the 11 routes F11 uses (docs/03 sections 11 and 12). Every write invalidates the
// portfolio, adjustments, transactions, watchlist and the dashboard cards that show them.

export const portfolioKeys = {
  all: ["portfolio"] as const,
  summary: (includeExited: boolean) => ["portfolio", "summary", includeExited] as const,
  txns: (symbol: string) => ["portfolio", "txns", symbol] as const,
  adjustments: ["portfolio", "adjustments"] as const,
  holidays: (year: number) => ["portfolio", "holidays", year] as const,
  watchlist: ["watchlist", "full"] as const,
};

export function invalidatePortfolio(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: portfolioKeys.all });
  void qc.invalidateQueries({ queryKey: dashboardKeys.portfolio });
  void qc.invalidateQueries({ queryKey: dashboardKeys.watchlist });
}

export function invalidateWatchlist(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: portfolioKeys.watchlist });
  void qc.invalidateQueries({ queryKey: dashboardKeys.watchlist });
}

export function usePortfolioSummaryFull(includeExited: boolean) {
  return useQuery({
    queryKey: portfolioKeys.summary(includeExited),
    queryFn: ({ signal }) =>
      apiRequest("/portfolio/summary", {
        schema: portfolioSummarySchema,
        query: { include_exited: includeExited },
        signal,
      }),
    staleTime: 60_000,
  });
}

const PAGE = 50;

export function useTxns(symbol: string) {
  return useInfiniteQuery({
    queryKey: portfolioKeys.txns(symbol),
    initialPageParam: "",
    queryFn: ({ pageParam, signal }) =>
      apiRequest("/portfolio/txns", {
        schema: txnPageSchema,
        query: { symbol: symbol || undefined, limit: PAGE, cursor: pageParam || undefined },
        signal,
      }),
    getNextPageParam: (last) => last.data.next_cursor ?? undefined,
  });
}

export function useAdjustments() {
  return useQuery({
    queryKey: portfolioKeys.adjustments,
    queryFn: ({ signal }) =>
      apiRequest("/portfolio/adjustments", { schema: adjustmentsSchema, signal }),
    staleTime: 60_000,
  });
}

/** Holiday list for the weekend/holiday warning; a 501 or `year_loaded=false` means weekends only. */
export function useHolidays(year: number | null) {
  return useQuery({
    queryKey: portfolioKeys.holidays(year ?? 0),
    enabled: year !== null,
    retry: false,
    queryFn: ({ signal }) =>
      apiRequest("/market/holidays", {
        schema: holidaysSchema,
        query: { year: year ?? 0 },
        signal,
      }),
    staleTime: 6 * 3_600_000,
  });
}

export function useCreateTxn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { body: TxnBody; attempt: Attempt }) =>
      apiRequest("/portfolio/txns", {
        schema: txnSchema,
        method: "POST",
        body: v.body,
        headers: { "Idempotency-Key": v.attempt.key },
      }),
    onSuccess: () => invalidatePortfolio(qc),
  });
}

export function usePatchTxn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: number; body: Partial<TxnBody> }) =>
      apiRequest(`/portfolio/txns/${v.id}`, { schema: txnSchema, method: "PATCH", body: v.body }),
    onSuccess: () => invalidatePortfolio(qc),
  });
}

export function useDeleteTxn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      apiRequest(`/portfolio/txns/${id}`, { schema: deletedSchema, method: "DELETE" }),
    onSuccess: () => invalidatePortfolio(qc),
  });
}

export interface OverrideBody {
  symbol: string;
  effective_date: string;
  qty_multiplier: string;
  note?: string;
}

export function useCreateAdjustment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: OverrideBody) =>
      apiRequest("/portfolio/adjustments", { schema: adjustmentSchema, method: "POST", body }),
    onSuccess: () => invalidatePortfolio(qc),
  });
}

export function useWatchlistFull() {
  return useQuery({
    queryKey: portfolioKeys.watchlist,
    queryFn: ({ signal }) => apiRequest("/watchlist", { schema: watchlistFullSchema, signal }),
    staleTime: 60_000,
  });
}

export function useAddWatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { symbol: string; note: string }) =>
      apiRequest("/watchlist", {
        schema: watchEntrySchema,
        method: "POST",
        body: { type: "stock", symbol: v.symbol, note: v.note },
      }),
    onSuccess: () => invalidateWatchlist(qc),
  });
}

export function usePatchWatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: number; note: string }) =>
      apiRequest(`/watchlist/${v.id}`, {
        schema: watchEntrySchema,
        method: "PATCH",
        body: { note: v.note },
      }),
    onSuccess: () => invalidateWatchlist(qc),
  });
}

export function useRemoveWatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      apiRequest(`/watchlist/${id}`, { schema: deletedSchema, method: "DELETE" }),
    onSuccess: () => invalidateWatchlist(qc),
  });
}
