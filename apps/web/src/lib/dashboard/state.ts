import { ApiError } from "@/lib/api/client";
import { formatDate } from "@/lib/format";
import type { WatchFund, WatchStock } from "./schemas";

/** Formatted as-of date for the chips, or null (chip says "unknown") when no date is known. */
export function asOfText(value: string | null | undefined): string | null {
  const d = formatDate(value ?? null);
  return d.reason === null ? d.text : null;
}

// Pure helpers for the dashboard: turning API failures into honest card states, the staleness
// rule for the last price import, and movers. No formatting here (that is lib/format).

export type Unavailable = { state: "empty" | "error"; message: string };

/** `details.reason` values the API documents (docs/03 section 1 and 4), in plain English. */
const REASONS: Record<string, string> = {
  no_prices_imported: "no prices have been imported yet",
  no_history: "there is no price history yet",
  no_nav_yet: "no NAV has been stored yet",
  backfill_pending: "history is still being loaded",
};

/**
 * 501 NOT_IMPLEMENTED and 404 DATA_UNAVAILABLE are expected states while the server is built
 * out: they render as an empty card with the reason, never as fake data. Anything else is an
 * error with the request id, so the owner can quote it.
 */
export function describeError(error: unknown, what: string): Unavailable {
  if (error instanceof ApiError) {
    if (error.status === 501 || error.code === "NOT_IMPLEMENTED") {
      return {
        state: "empty",
        message: `${what} is not available yet: this server feature has not been built.`,
      };
    }
    if (error.code === "DATA_UNAVAILABLE") {
      const raw = error.details?.["reason"];
      const reason = typeof raw === "string" ? (REASONS[raw] ?? null) : null;
      return {
        state: "empty",
        message: reason
          ? `${what} is not available: ${reason}.`
          : `${what} is not available: the server has no data for it yet.`,
      };
    }
    const id = error.requestId ? ` Request id: ${error.requestId}.` : "";
    if (error.code === "TIMEOUT" || error.code === "NETWORK") {
      return { state: "error", message: `${what} could not be loaded: ${error.message}${id}` };
    }
    return { state: "error", message: `${what} could not be loaded.${id}` };
  }
  return { state: "error", message: `${what} could not be loaded.` };
}

/** API money fields are decimal strings; null stays null (an unknown is never shown as 0). */
export function parseMoney(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** IST calendar date (YYYY-MM-DD) of an instant. */
export function istDate(now: Date): string {
  return new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

/**
 * Last weekday on or before today (IST). The web app has no holiday list, so a trading holiday
 * can make a correct import look one day old; the chip then says "stale" conservatively
 * (assumption F04-4).
 */
export function expectedLastTradingDate(now: Date): string {
  const d = new Date(`${istDate(now)}T00:00:00Z`);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** ISO dates compare as strings. A missing date is "unknown", reported as not stale. */
export function isOlderThanExpected(barDate: string | null, now: Date): boolean {
  if (barDate === null) return false;
  return barDate.slice(0, 10) < expectedLastTradingDate(now);
}

/** Latest as-of date over the given ISO dates; null when none is known. */
export function latestDate(dates: ReadonlyArray<string | null | undefined>): string | null {
  let best: string | null = null;
  for (const d of dates) {
    if (!d) continue;
    const day = d.slice(0, 10);
    if (best === null || day > best) best = day;
  }
  return best;
}

export function lastPriceImportDate(stocks: ReadonlyArray<WatchStock>): string | null {
  return latestDate(stocks.map((s) => s.ltp_as_of));
}

export function lastNavDate(funds: ReadonlyArray<WatchFund>): string | null {
  return latestDate(funds.map((f) => f.nav_date));
}

/** Watchlist stocks with a known day change, largest gain first / largest loss first. */
export function topMovers(
  stocks: ReadonlyArray<WatchStock>,
  n: number,
): { gainers: WatchStock[]; losers: WatchStock[] } {
  const known = stocks.filter(
    (s): s is WatchStock & { change_pct: number } =>
      typeof s.change_pct === "number" && Number.isFinite(s.change_pct),
  );
  const gainers = known
    .filter((s) => s.change_pct > 0)
    .sort((a, b) => b.change_pct - a.change_pct)
    .slice(0, n);
  const losers = known
    .filter((s) => s.change_pct < 0)
    .sort((a, b) => a.change_pct - b.change_pct)
    .slice(0, n);
  return { gainers, losers };
}
