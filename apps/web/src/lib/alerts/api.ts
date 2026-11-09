"use client";

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { apiRequest } from "@/lib/api/client";
import {
  alertEventPageSchema,
  alertPageSchema,
  alertSchema,
  linkCodeSchema,
  meSchema,
  okSchema,
} from "./schemas";

// Hooks for the alert and Telegram routes of docs/03 section 13 (all live since B12).

export const alertKeys = {
  all: ["alerts"] as const,
  list: (status: string) => ["alerts", "list", status] as const,
  events: ["alerts", "events"] as const,
  me: ["auth", "me"] as const,
};

const PAGE = 50;

function invalidateAlerts(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: alertKeys.all });
}

/** `status` empty means all statuses. */
export function useAlerts(status: string) {
  return useInfiniteQuery({
    queryKey: alertKeys.list(status),
    initialPageParam: "",
    queryFn: ({ pageParam, signal }) =>
      apiRequest("/alerts", {
        schema: alertPageSchema,
        query: { status: status || undefined, limit: PAGE, cursor: pageParam || undefined },
        signal,
      }),
    getNextPageParam: (last) => last.data.next_cursor ?? undefined,
  });
}

export function useAlertEvents() {
  return useInfiniteQuery({
    queryKey: alertKeys.events,
    initialPageParam: "",
    queryFn: ({ pageParam, signal }) =>
      apiRequest("/alerts/events", {
        schema: alertEventPageSchema,
        query: { limit: PAGE, cursor: pageParam || undefined },
        signal,
      }),
    getNextPageParam: (last) => last.data.next_cursor ?? undefined,
  });
}

export function useCreateAlert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiRequest("/alerts", { schema: alertSchema, method: "POST", body }),
    onSuccess: () => invalidateAlerts(qc),
  });
}

export function usePatchAlert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: number; body: { status?: "active" | "paused"; params?: unknown } }) =>
      apiRequest(`/alerts/${v.id}`, { schema: alertSchema, method: "PATCH", body: v.body }),
    onSuccess: () => invalidateAlerts(qc),
  });
}

export function useDeleteAlert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apiRequest(`/alerts/${id}`, { schema: okSchema, method: "DELETE" }),
    onSuccess: () => invalidateAlerts(qc),
  });
}

/** `/auth/me`: the only place that says whether a Telegram chat is linked. */
export function useMe(options: { pollMs?: number | false } = {}) {
  return useQuery({
    queryKey: alertKeys.me,
    queryFn: ({ signal }) => apiRequest("/auth/me", { schema: meSchema, signal }),
    staleTime: 30_000,
    refetchInterval: options.pollMs ?? false,
  });
}

export function useCreateLinkCode() {
  return useMutation({
    mutationFn: () => apiRequest("/telegram/link-code", { schema: linkCodeSchema, method: "POST" }),
  });
}

export function useUnlinkTelegram() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiRequest("/telegram/link", { schema: okSchema, method: "DELETE" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: alertKeys.me }),
  });
}

export function useTelegramTest() {
  return useMutation({
    mutationFn: () => apiRequest("/telegram/test", { schema: okSchema, method: "POST" }),
  });
}
