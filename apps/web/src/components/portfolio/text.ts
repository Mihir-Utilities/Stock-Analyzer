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
  under_one_year: "XIRR is shown after the first year",
  no_nav: "No NAV for this fund yet",
  no_previous_nav: "there is no earlier NAV to compare with",
  nav_stale: "the latest NAV is more than 4 days old",
  no_purchases: "there is no purchase to compare with",
  no_open_holdings: "there are no open holdings",
  not_defined_for_view: "not defined for this view",
  "n/m": "not meaningful: the cost base is zero",
  unreadable: "the server answer for this figure could not be read",
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

/** "You: +2.0 pts vs Nifty" (your XIRR minus the benchmark's, in percentage points); zero is unsigned. */
export function benchmarkDeltaText(diffPts: number): string {
  const body = formatNumber(Math.abs(diffPts), { decimals: 1 }).text;
  const sign = Number(body.replace(/,/g, "")) === 0 ? "" : diffPts > 0 ? "+" : "-";
  return `You: ${sign}${body} pts vs Nifty`;
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
  NAV_STALE: "NAV is stale",
  SCHEME_MAY_BE_MERGED: "Scheme may have been merged",
  IDCW_PAYOUTS_NOT_RECORDED: "IDCW payouts not recorded",
  NAV_FEED_STARTS_AFTER_TXN: "NAV history starts after a transaction",
};

// ---- mutual fund views (docs/06 6.7a, docs/05 8.5) -------------------------------------------

/** Attribution on every MF value (docs/03 12a; SAF-03). */
export const MF_NAV_SOURCE = "NAV data: AMFI, via mfapi.in";
/** Where units and amounts come from. */
export const MF_STATEMENT_SOURCE = "your statement or entries";
export const MF_VIEW_SOURCE = `${MF_STATEMENT_SOURCE}; ${MF_NAV_SOURCE}`;
export const ALL_VIEW_SOURCE = `Your transactions, your statement or entries, and imported prices; ${MF_NAV_SOURCE}`;

export const PRICE_RETURN_LABEL = "price return (excludes dividends)";
export const TOTAL_RETURN_LABEL = "total return (includes IDCW payouts)";
export const BASIS_LINE = "Stocks: price return. Mutual funds: total return.";
export const NO_AVERAGE_FOOTNOTE =
  "XIRR cannot be added or averaged; each row uses only its own cash flows.";
export const NOT_ADD_UP_SENTENCE =
  "The three views need not add up: each uses only its own cash flows, and XIRR cannot be added or averaged.";

/** "missing_nav: A, B; missing_price: C" into names per kind; unknown text passes through. */
export function missingNames(reason: string | null | undefined): {
  nav: string[];
  price: string[];
  other: string | null;
} {
  const out = { nav: [] as string[], price: [] as string[], other: null as string | null };
  if (reason === null || reason === undefined || reason === "") return out;
  const rest: string[] = [];
  for (const part of reason.split(";").map((x) => x.trim())) {
    const m = /^(missing_nav|missing_price)\s*:\s*(.*)$/.exec(part);
    if (!m) {
      if (part) rest.push(part);
      continue;
    }
    const names = (m[2] ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    (m[1] === "missing_nav" ? out.nav : out.price).push(...names);
  }
  out.other = rest.length > 0 ? rest.join("; ") : null;
  return out;
}

/** Reason text for a null total: 'Value unavailable: {names} have no NAV yet.' (never a partial sum). */
export function valueUnavailable(reason: string | null | undefined): string {
  const m = missingNames(reason);
  const parts: string[] = [];
  if (m.nav.length > 0) parts.push(`${m.nav.join(", ")} have no NAV yet`);
  if (m.price.length > 0) parts.push(`${m.price.join(", ")} have no price yet`);
  if (parts.length > 0) return `Value unavailable: ${parts.join("; ")}.`;
  const other = reasonText(m.other ?? reason);
  return other
    ? `Value unavailable: ${other}.`
    : "Value unavailable: no price or NAV is available.";
}

/** Names of the holdings that block a total, for the partial-data banner. */
export function unpricedNames(reason: string | null | undefined): string[] {
  const m = missingNames(reason);
  return [...m.nav, ...m.price];
}

const PLAN: Record<string, string> = { direct: "Direct", regular: "Regular" };
const OPTION: Record<string, string> = { growth: "Growth", idcw: "IDCW" };

/** Plan and option are always spelled out (never guessed): unknown stays "unknown". */
export function planLabel(p: string): string {
  return PLAN[p] ?? "Plan unknown";
}
export function optionLabel(o: string): string {
  return OPTION[o] ?? "Option unknown";
}

/** Exact copy of docs/06 section 9. */
export const UNDER_ONE_YEAR_COPY =
  "XIRR is shown after the first year. Absolute return is shown instead.";
export const NO_MF_TXNS_COPY =
  "No mutual fund transactions yet. Import your broker's MF statement or add a transaction.";
export const SWITCH_NOT_SUPPORTED_COPY =
  "Switches and merger/bonus entries are not supported yet. Enter a switch as a redemption plus a purchase.";
