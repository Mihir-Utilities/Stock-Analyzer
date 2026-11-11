"use client";

import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { apiRequest } from "@/lib/api/client";
import { invalidatePortfolio } from "./api";
import {
  mfMappingListSchema,
  mfMappingSchema,
  mfTxnDeletedSchema,
  mfTxnPageSchema,
  mfTxnSchema,
  viewSummarySchema,
} from "./mf-schemas";
import type { MfAttempt, MfTxnBody } from "./mf-form";
import type { PortfolioView } from "./view";

// Hooks for the D-MF routes (docs/03 section 12a). The UI sends `view` explicitly (MFH-14). Every
// write invalidates the whole portfolio prefix (summary of every view, holdings, lists) and the
// dashboard snapshot.

export const mfKeys = {
  view: (view: PortfolioView, includeExited: boolean) =>
    ["portfolio", "summary", "view", view, includeExited] as const,
  txns: (f: MfTxnFilters) => ["portfolio", "mf-txns", f] as const,
  txnsAll: ["portfolio", "mf-txns"] as const,
  mappings: ["portfolio", "mf-mappings"] as const,
};

export function usePortfolioView(view: PortfolioView, includeExited: boolean) {
  return useQuery({
    queryKey: mfKeys.view(view, includeExited),
    queryFn: ({ signal }) =>
      apiRequest("/portfolio/summary", {
        schema: viewSummarySchema,
        query: { view, include_exited: includeExited },
        signal,
      }),
    staleTime: 60_000,
    // Switching views keeps the previous view's data on screen while the next one loads (6.7a).
    placeholderData: keepPreviousData,
  });
}

export interface MfTxnFilters {
  schemeCode: string;
  folio: string;
  type: string;
  from: string;
  to: string;
  source: string;
}

export const EMPTY_FILTERS: MfTxnFilters = {
  schemeCode: "",
  folio: "",
  type: "",
  from: "",
  to: "",
  source: "",
};

const PAGE = 50;

export function validSchemeCode(v: string): string | undefined {
  if (!/^\d+$/.test(v)) return undefined;
  const n = Number(v);
  return n >= 1 && n <= 2147483647 ? String(n) : undefined;
}

export function useMfTxns(f: MfTxnFilters) {
  return useInfiniteQuery({
    queryKey: mfKeys.txns(f),
    initialPageParam: "",
    queryFn: ({ pageParam, signal }) =>
      apiRequest("/portfolio/mf/txns", {
        schema: mfTxnPageSchema,
        query: {
          // the API takes an int32 >= 1 (422 otherwise): anything else is not sent
          scheme_code: validSchemeCode(f.schemeCode),
          folio: f.folio.trim() || undefined,
          type: f.type || undefined,
          from: f.from || undefined,
          to: f.to || undefined,
          source: f.source || undefined,
          limit: PAGE,
          cursor: pageParam || undefined,
        },
        signal,
      }),
    getNextPageParam: (last) => last.data.next_cursor ?? undefined,
  });
}

export function useCreateMfTxn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { body: MfTxnBody; attempt: MfAttempt }) =>
      apiRequest("/portfolio/mf/txns", {
        schema: mfTxnSchema,
        method: "POST",
        body: v.body,
        headers: { "Idempotency-Key": v.attempt.key },
      }),
    onSuccess: () => invalidatePortfolio(qc),
  });
}

export function usePatchMfTxn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: number; body: Partial<MfTxnBody> }) =>
      apiRequest(`/portfolio/mf/txns/${v.id}`, {
        schema: mfTxnSchema,
        method: "PATCH",
        body: v.body,
      }),
    onSuccess: () => invalidatePortfolio(qc),
  });
}

export function useDeleteMfTxn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      apiRequest(`/portfolio/mf/txns/${id}`, { schema: mfTxnDeletedSchema, method: "DELETE" }),
    onSuccess: () => invalidatePortfolio(qc),
  });
}

export function useMfMappings(enabled = true) {
  return useQuery({
    queryKey: mfKeys.mappings,
    enabled,
    queryFn: ({ signal }) =>
      apiRequest("/portfolio/mf/fund-mappings", { schema: mfMappingListSchema, signal }),
    staleTime: 60_000,
  });
}

/** `PUT /portfolio/mf/fund-mappings` (docs/03 12a, MFH-23). `remap` is explicit and rewrites rows. */
export async function putMapping(body: { fund_name: string; scheme_code: number; remap: boolean }) {
  const r = await apiRequest("/portfolio/mf/fund-mappings", {
    method: "PUT",
    body,
    schema: mfMappingSchema,
  });
  return r.data;
}
