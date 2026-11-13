// Fixed copy and reason wording of the Portfolio risk section (docs/06 6.7b, docs/05 8.6). Facts and
// arithmetic only: no verdict, no target, no forecast. Reason codes of the API become plain English
// here and are never hidden (an unknown code is humanised).

export const RISK_NOTE =
  "How your money is spread and how your portfolio has behaved. Descriptions of today's values and the past, not advice or a forecast.";
export const RISK_PAST_NOTE = "Past behaviour is not a forecast.";
export const RISK_FUNDS_NOTE =
  "Funds are shown as one holding each; what they own inside is not looked through.";
export const STRESS_LABEL =
  "What if this one holding fell and nothing else moved. Arithmetic on today's values, not a forecast.";
export const HISTORY_HOWTO =
  "The line is built from the price moves of what you held each day. Money you add or take out is not counted as gain or loss, so a deposit cannot hide a fall. The value in rupees (shown in the data table) does include your deposits and withdrawals.";
export const RISK_SOURCE =
  "Your transactions with your imported prices (stocks) and AMFI NAV via mfapi.in (funds); price return, dividends excluded for stocks";
export const NOTHING_YET = "Nothing to show yet: add a transaction or import a statement.";
export const UNREADABLE = "The server answer for this block could not be read.";
export const UNCLASSIFIED_HINT = "No sector imported for these holdings";
export const NOT_RECOVERED = "not recovered yet";

const FIXED: Record<string, string> = {
  no_open_holdings: "you hold nothing in this view",
  zero_value: "the holdings have no value",
  no_transactions: "there are no transactions in this view yet",
  no_priced_dates: "no prices or NAVs are imported for what you hold",
  too_few_points: "fewer than two dates have a value",
  no_price: "no valid close has been imported",
  no_nav: "no NAV for this fund yet",
};

function names(list: string): string {
  return list.trim();
}

/** One reason code, or several joined with "; " (`missing_price: A, B; missing_nav: Fund X`). */
export function riskReason(code: string | null | undefined): string | null {
  if (code === null || code === undefined || code === "") return null;
  return code
    .split("; ")
    .map((part) => {
      const fixed = FIXED[part];
      if (fixed) return fixed;
      const m = /^(missing_price|missing_nav|nav_gap): (.+)$/.exec(part);
      if (!m) return part.replace(/_/g, " ");
      const who = names(m[2] ?? "");
      if (m[1] === "missing_price")
        return `${who} ${who.includes(",") ? "have" : "has"} no imported price yet`;
      if (m[1] === "missing_nav") return `${who} ${who.includes(",") ? "have" : "has"} no NAV yet`;
      return `the latest NAV of ${who} is more than 4 days old`;
    })
    .join("; ");
}

/** "Weights unavailable: A has no imported price yet." */
export function weightsUnavailable(code: string | null | undefined): string {
  const r = riskReason(code);
  return r ? `Weights unavailable: ${r}.` : "Weights unavailable.";
}
