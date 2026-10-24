import { ApiError } from "@/lib/api/client";
import { getJob, startRefresh } from "./api";

// Refresh flow of docs/06 section 4.3. Broker mode only: in manual price mode (D-1, current) the
// button is hidden and none of this runs. Copy strings are the spec's.

export const REFRESH_POLL_MS = 3_000;
export const REFRESH_TIMEOUT_MS = 180_000;

export const REFRESH_COPY = {
  working: "Refreshing (can take up to a minute)",
  timeout: "Still working; data will update at the next scheduled run.",
  brokerSession: "Broker session expired. Reconnect to update prices.",
  done: "Prices updated.",
} as const;

export const rateLimitedCopy = (minutes: number) =>
  `You refreshed this recently. Try again in ${minutes} min.`;

export type RefreshOutcome =
  | { kind: "ok" }
  | { kind: "rate_limited"; minutes: number }
  | { kind: "broker_session_missing" }
  | { kind: "failed"; message: string }
  | { kind: "timeout" };

export interface RefreshDeps {
  start: (symbol: string) => Promise<number>;
  job: (id: number) => Promise<{ data: { status: string; error?: string | null | undefined } }>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

const realDeps: RefreshDeps = {
  start: startRefresh,
  job: getJob,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
};

const ACTIVE = new Set(["queued", "running"]);

export async function runRefresh(
  symbol: string,
  deps: RefreshDeps = realDeps,
): Promise<RefreshOutcome> {
  let id: number;
  try {
    id = await deps.start(symbol);
  } catch (e) {
    if (e instanceof ApiError && e.code === "RATE_LIMITED") {
      const raw = e.details?.["retry_after_seconds"];
      const seconds = typeof raw === "number" ? raw : (e.retryAfterSeconds ?? 60);
      return { kind: "rate_limited", minutes: Math.max(1, Math.ceil(seconds / 60)) };
    }
    return { kind: "failed", message: e instanceof ApiError ? e.message : "Refresh failed." };
  }
  const started = deps.now();
  while (deps.now() - started < REFRESH_TIMEOUT_MS) {
    await deps.sleep(REFRESH_POLL_MS);
    let job: Awaited<ReturnType<RefreshDeps["job"]>>;
    try {
      job = await deps.job(id);
    } catch (e) {
      return { kind: "failed", message: e instanceof ApiError ? e.message : "Refresh failed." };
    }
    const { status, error } = job.data;
    if (status === "ok") return { kind: "ok" };
    if (!ACTIVE.has(status)) {
      if (error === "broker_session_missing") return { kind: "broker_session_missing" };
      return {
        kind: "failed",
        message: error ? `Refresh ${status}: ${error}` : `Refresh ${status}.`,
      };
    }
  }
  return { kind: "timeout" };
}
