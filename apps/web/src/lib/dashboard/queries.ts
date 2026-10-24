"use client";

import { useQuery, useQueries } from "@tanstack/react-query";
import { apiRequest } from "@/lib/api/client";
import {
  adminStatusSchema,
  alertEventsSchema,
  brokerStatusSchema,
  marketOverviewSchema,
  portfolioSummarySchema,
  stockEventsSchema,
  watchlistSchema,
} from "./schemas";

// Dashboard data hooks. Stale times follow docs/06 section 1; none of these endpoints retry on a
// 4xx (shouldRetry), so a 501 or 404 shows its reason at once.

export const dashboardKeys = {
  watchlist: ["dashboard", "watchlist"] as const,
  overview: ["dashboard", "market-overview"] as const,
  portfolio: ["dashboard", "portfolio-summary"] as const,
  alerts: ["dashboard", "alert-events"] as const,
  broker: ["dashboard", "broker-status"] as const,
  admin: ["dashboard", "admin-status"] as const,
  events: (symbol: string) => ["dashboard", "events", symbol] as const,
};

export function useWatchlist() {
  return useQuery({
    queryKey: dashboardKeys.watchlist,
    queryFn: ({ signal }) => apiRequest("/watchlist", { schema: watchlistSchema, signal }),
    staleTime: 5 * 60_000,
  });
}

export function useMarketOverview() {
  return useQuery({
    queryKey: dashboardKeys.overview,
    queryFn: ({ signal }) =>
      apiRequest("/market/overview", { schema: marketOverviewSchema, signal }),
    staleTime: 5 * 60_000,
  });
}

export function usePortfolioSummary() {
  return useQuery({
    queryKey: dashboardKeys.portfolio,
    queryFn: ({ signal }) =>
      apiRequest("/portfolio/summary", { schema: portfolioSummarySchema, signal }),
    staleTime: 5 * 60_000,
  });
}

export function useAlertEvents() {
  return useQuery({
    queryKey: dashboardKeys.alerts,
    queryFn: ({ signal }) =>
      apiRequest("/alerts/events", { schema: alertEventsSchema, query: { limit: 5 }, signal }),
    staleTime: 60_000,
  });
}

export function useBrokerStatus() {
  return useQuery({
    queryKey: dashboardKeys.broker,
    queryFn: ({ signal }) => apiRequest("/broker/status", { schema: brokerStatusSchema, signal }),
    staleTime: 60_000,
  });
}

export function useAdminStatus() {
  return useQuery({
    queryKey: dashboardKeys.admin,
    queryFn: ({ signal }) => apiRequest("/admin/status", { schema: adminStatusSchema, signal }),
    staleTime: 60_000,
  });
}

/** Owner-entered calendar entries (next 90 days) for each watchlist symbol. */
export function useUpcomingEvents(symbols: ReadonlyArray<string>) {
  return useQueries({
    queries: symbols.map((symbol) => ({
      queryKey: dashboardKeys.events(symbol),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        apiRequest(`/stocks/${encodeURIComponent(symbol)}/events`, {
          schema: stockEventsSchema,
          signal,
        }),
      staleTime: 60 * 60_000,
    })),
  });
}
