import {
  formatCrore,
  formatDate,
  formatFraction,
  formatInr,
  formatMultiple,
  formatNumber,
  formatPercent,
  unknown,
  type Formatted,
} from "@/lib/format";
import { humanReason } from "@/lib/stock/derive";
import { metricDef } from "./metrics";

// Cell text for screener, compare and peers values. Every number goes through lib/format; an
// unknown value is a dash with its reason, never 0, NaN or Infinity (docs/06 section 3).

const REASON_WORDS: Record<string, string> = {
  not_available: "not available for this stock",
  no_screener_row: "no analytics row yet for this stock",
  no_prices_in_range: "no prices in this range",
  no_common_dates: "these stocks have no trading date in common in this range",
  fewer_than_two_stocks_with_prices: "fewer than two of these stocks have prices in this range",
  no_sector_data: "no sector or industry is on file for this stock",
  no_market_cap: "no market cap is on file for this stock",
};

/** Plain words for an API reason code (screener, compare and peers). */
export function reasonWords(code: string | null | undefined, fallback = "not available"): string {
  if (!code) return fallback;
  return REASON_WORDS[code] ?? humanReason(code, fallback);
}

export function formatMetric(
  key: string,
  value: number | string | null | undefined,
  reasonCode?: string | null,
  unitCode?: string,
): Formatted {
  const reason = reasonWords(reasonCode);
  if (typeof value === "string") {
    return value === "" ? unknown(reason) : { text: value, reason: null, direction: "flat" };
  }
  if (value === null || value === undefined) return unknown(reason);
  const unit = unitCode ?? metricDef(key)?.unit;
  switch (unit) {
    case "INR_CR":
      return formatCrore(value, { reason });
    case "INR":
      return formatInr(value, { reason });
    case "PERCENT":
      return formatPercent(value, { reason });
    case "PERCENT_POINTS": {
      const f = formatNumber(value, { reason, decimals: 2 });
      return f.reason === null && f.direction === "up"
        ? { ...f, text: `+${f.text} pp` }
        : f.reason === null
          ? { ...f, text: `${f.text} pp` }
          : f;
    }
    case "RATIO":
      return formatMultiple(value, { reason });
    case "INDEX_0_100":
    case "SCORE_0_100":
      return formatNumber(value, { reason, decimals: 1 });
    default:
      return formatNumber(value, { reason });
  }
}

export const STALE_REASON_TEXT: Record<string, string> = {
  no_owner_data: "No owner-entered data yet",
  fundamentals_older_than_120_days: "Fundamentals entered more than 120 days ago",
  shareholding_older_than_135_days: "Shareholding is more than 135 days old",
};

export function staleReasonText(code: string | null | undefined): string {
  if (!code) return "Data may be out of date";
  return STALE_REASON_TEXT[code] ?? code.replace(/_/g, " ");
}

export interface Stamp {
  last_updated: string | null;
  last_updated_source: string | null;
  stale: boolean;
  stale_reason: string | null;
}

/** `12 Mar 2026 (fundamentals)` or `No owner data`. The date is the IST date of the owner entry. */
export function stampText(s: Stamp): string {
  const d = formatDate(s.last_updated);
  if (d.reason !== null) return "No owner data";
  return s.last_updated_source ? `${d.text} (${s.last_updated_source})` : d.text;
}

/** Coverage is a fraction 0-1 of the 36 whitelisted metrics. */
export function coverageText(fraction: number): string {
  return formatFraction(fraction, { decimals: 0 }).text;
}
