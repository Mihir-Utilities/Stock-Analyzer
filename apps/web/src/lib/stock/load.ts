import { ApiError } from "@/lib/api/client";
import { humanReason } from "./derive";

/** What a card needs to know about one query (one failing card never blanks the page). */
export type Load<T> =
  | { state: "loading" }
  | { state: "error"; message: string; requestId: string | null; retry: () => void }
  | { state: "unavailable"; reason: string }
  | { state: "ready"; data: T; asOf: string | null; stale: boolean };

export interface QueryLike<T> {
  isPending: boolean;
  isError: boolean;
  error: unknown;
  data:
    | {
        data: T | { redirect_symbol: string };
        meta?: { as_of?: string | undefined; stale?: boolean | undefined } | undefined;
      }
    | undefined;
  refetch: () => unknown;
}

const UNAVAILABLE_COPY: Record<string, string> = {
  no_prices_imported: "no prices imported for this stock",
  no_history: "fewer than 60 valid price bars (insufficient history)",
};

export function toLoad<T extends object>(q: QueryLike<T>): Load<T> {
  if (q.isPending) return { state: "loading" };
  if (q.isError) {
    const e = q.error;
    if (e instanceof ApiError && e.code === "DATA_UNAVAILABLE") {
      const r = e.details?.["reason"];
      const code = typeof r === "string" ? r : "";
      return {
        state: "unavailable",
        reason: UNAVAILABLE_COPY[code] ?? humanReason(code, e.message),
      };
    }
    return {
      state: "error",
      message: e instanceof ApiError ? e.message : "This card could not be loaded.",
      requestId: e instanceof ApiError ? e.requestId : null,
      retry: () => void q.refetch(),
    };
  }
  const d = q.data?.data;
  if (!d || "redirect_symbol" in d) return { state: "loading" };
  return {
    state: "ready",
    data: d,
    asOf: q.data?.meta?.as_of ?? null,
    stale: q.data?.meta?.stale === true,
  };
}
