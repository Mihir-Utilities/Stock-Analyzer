import { formatInr, formatNumber, formatPercent, type Formatted } from "@/lib/format";
import { displayNumber, qtyDecimals } from "@/lib/portfolio/decimal";

// Display helpers for the portfolio screens. All text comes from lib/format; API money strings are
// bridged to numbers only here, at the display boundary (never summed as floats).

export const PORTFOLIO_SOURCE = "Your transactions and imported prices";
export const MANUAL_PRICE_NOTE =
  "Manual price mode: LTP is the latest valid close from your imported price files, not a live quote.";

const REASONS: Record<string, string> = {
  no_price: "no valid close has been imported",
  no_previous_close: "there is no earlier close to compare with",
  corporate_action_in_window: "a split or bonus lies between the last two closes",
  no_transactions: "there are no transactions yet",
  period_too_short: "the period is under 30 days, so only the absolute return is meaningful",
  no_sign_change: "the cash flows have no sign change, so XIRR is not defined",
  insufficient_flows: "at least one outflow and one inflow are needed",
  benchmark_unavailable: "no Nifty 50 series has been imported",
  benchmark_series_starts_after_first_transaction:
    "the Nifty 50 series starts after your first transaction",
  no_outflow: "there is no purchase to compare with",
  missing_price: "a holding has no imported price",
};

/** Plain-English reason for an API `*_reason` code (unknown codes are humanised, never hidden). */
export function reasonText(code: string | null | undefined): string | undefined {
  if (code === null || code === undefined || code === "") return undefined;
  return REASONS[code] ?? code.replace(/_/g, " ");
}

export function inr(v: string | null | undefined, o: { signed?: boolean; reason?: string } = {}) {
  return formatInr(displayNumber(v), {
    ...(o.signed ? { signed: true } : {}),
    ...(o.reason ? { reason: o.reason } : {}),
  });
}

export function qty(v: string): string {
  return formatNumber(displayNumber(v), { decimals: qtyDecimals(v) }).text;
}

export function pct(v: number | null | undefined, signed = false, reason?: string): Formatted {
  return formatPercent(v, { ...(signed ? { signed: true } : {}), ...(reason ? { reason } : {}) });
}

const FLAG_TEXT: Record<string, string> = {
  price_before_action: "price converted to current units for a later split or bonus (estimate)",
};

export function flagText(flag: string): string {
  return FLAG_TEXT[flag] ?? flag.replace(/_/g, " ");
}

/** Banner prefix per warning code; the server message follows. */
export const WARNING_LABEL: Record<string, string> = {
  REVIEW_NEEDED: "Review needed",
  UNCONFIRMED_ACTION: "Unconfirmed corporate action",
  HOLDINGS_INCONSISTENT: "Holdings look inconsistent",
  MISSING_PRICE: "Missing price",
  DELISTED_HOLDING: "Delisted or suspended holding",
};
