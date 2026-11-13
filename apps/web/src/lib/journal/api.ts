"use client";

import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { apiRequest } from "@/lib/api/client";
import type { NoteAttempt, NoteBody } from "./form";
import { deletedSchema, journalNoteSchema, journalPageSchema } from "./schemas";

// Hooks for the decision-journal routes of docs/03 section 13a.

export const journalKeys = {
  all: (symbol: string) => ["journal", symbol] as const,
  list: (symbol: string, status: string) => ["journal", symbol, "list", status] as const,
};

const PAGE = 50;

function invalidate(qc: QueryClient, symbol: string): void {
  void qc.invalidateQueries({ queryKey: journalKeys.all(symbol) });
}

/** `status` empty means all notes. */
export function useJournal(symbol: string, status: "" | "open" | "reviewed") {
  return useInfiniteQuery({
    queryKey: journalKeys.list(symbol, status),
    initialPageParam: "",
    queryFn: ({ pageParam, signal }) =>
      apiRequest(`/stocks/${encodeURIComponent(symbol)}/journal`, {
        schema: journalPageSchema,
        query: { status: status || undefined, limit: PAGE, cursor: pageParam || undefined },
        signal,
      }),
    getNextPageParam: (last) => last.data.next_cursor ?? undefined,
  });
}

export function useCreateNote(symbol: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { body: NoteBody; attempt: NoteAttempt }) =>
      apiRequest(`/stocks/${encodeURIComponent(symbol)}/journal`, {
        schema: journalNoteSchema,
        method: "POST",
        body: v.body,
        headers: { "Idempotency-Key": v.attempt.key },
      }),
    onSuccess: () => invalidate(qc, symbol),
  });
}

export interface NotePatch {
  note?: string;
  review_on?: string | null;
  status?: "open" | "reviewed";
  portfolio_txn_id?: number | null;
}

export function usePatchNote(symbol: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: number; body: NotePatch }) =>
      apiRequest(`/journal/${v.id}`, { schema: journalNoteSchema, method: "PATCH", body: v.body }),
    onSuccess: () => invalidate(qc, symbol),
  });
}

export function useDeleteNote(symbol: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      apiRequest(`/journal/${id}`, { schema: deletedSchema, method: "DELETE" }),
    onSuccess: () => invalidate(qc, symbol),
  });
}
