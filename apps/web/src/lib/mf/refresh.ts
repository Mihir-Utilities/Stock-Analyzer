import { getMfJob, startMfRefresh } from "./api";
import {
  REFRESH_COPY,
  runRefresh,
  type RefreshDeps,
  type RefreshOutcome,
} from "@/lib/stock/refresh";

// The refresh flow of the stock page (start, poll GET /jobs/{id}, 3 minute cap) reused for
// POST /mf/schemes/{code}/refresh. 429 = cooldown or global limit (minutes shown), 409 = busy.

export const MF_REFRESH_COPY = {
  working: "Refreshing NAV data (can take up to a minute)",
  timeout: REFRESH_COPY.timeout,
  done: "NAV data updated.",
} as const;

const deps: RefreshDeps = {
  start: startMfRefresh,
  job: getMfJob,
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      const done = () => {
        clearTimeout(t);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const t = setTimeout(done, ms);
      signal?.addEventListener("abort", done, { once: true });
    }),
  now: () => Date.now(),
};

export function runMfRefresh(
  code: number,
  signal?: AbortSignal,
  override: RefreshDeps = deps,
): Promise<RefreshOutcome> {
  return runRefresh(String(code), override, signal);
}
