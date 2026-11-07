import { formatDate, formatInr, formatNumber } from "@/lib/format";
import { multiplierOf } from "./action-patch";
import type { CorporateAction } from "./schemas";

// Text for the Events timeline (docs/06 6.4 Events). Pure; every number and date goes through
// lib/format. Nothing is invented: a row with missing numbers says so.

export const TYPE_LABEL: Record<string, string> = {
  split: "Split",
  bonus: "Bonus",
  dividend: "Dividend",
  rights: "Rights issue",
  buyback: "Buyback",
  merger: "Merger",
  demerger: "Demerger",
  other: "Other",
  split_or_bonus: "Possible split or bonus",
};

export const STATUS_LABEL: Record<string, string> = {
  confirmed: "Confirmed",
  detected: "Detected, needs your decision",
  rejected: "Rejected",
};

export const SOURCE_LABEL: Record<string, string> = {
  manual: "entered by you",
  csv_import: "from a CSV import",
  detected: "found by the app from the price history",
};

/** Types the worker never applies to prices (ACT-08, ACT-20): shown as "review needed". */
const NOT_APPLIED = new Set(["rights", "buyback", "merger", "demerger", "split_or_bonus"]);

export function humanize(code: string): string {
  const t = code.replaceAll("_", " ").trim();
  return t === "" ? "Event" : t.charAt(0).toUpperCase() + t.slice(1);
}

export function typeLabel(type: string): string {
  return TYPE_LABEL[type] ?? humanize(type);
}

export function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? humanize(status);
}

/** `10 to 2 (multiplier 5)`, `1 for 1 bonus (multiplier 2)`, `₹10.00 per share`. */
export function actionTitle(a: CorporateAction): string {
  const n = a.ratio_num;
  const d = a.ratio_den;
  const hasRatio = typeof n === "number" && typeof d === "number";
  if (a.type === "split" || a.type === "bonus") {
    if (!hasRatio) return `${typeLabel(a.type)}: ratio not recorded`;
    const m = multiplierOf(a.type, n, d);
    const mult = m === null ? "" : ` (multiplier ${formatNumber(m, { decimals: 4 }).text})`;
    return a.type === "split"
      ? `Split, old face value ${formatNumber(n, { decimals: 4 }).text} to new ${formatNumber(d, { decimals: 4 }).text}${mult}`
      : `Bonus, ${formatNumber(n, { decimals: 4 }).text} new for every ${formatNumber(d, { decimals: 4 }).text} held${mult}`;
  }
  if (a.type === "split_or_bonus") {
    return hasRatio && n > 0 && d > 0
      ? `Possible split or bonus: the price fell to ${formatNumber(n, { decimals: 4 }).text} for every ${formatNumber(d, { decimals: 4 }).text} (implied multiplier ${formatNumber(d / n, { decimals: 4 }).text})`
      : "Possible split or bonus: ratio not recorded";
  }
  if (a.type === "dividend") {
    return typeof a.amount_per_share === "number"
      ? `Dividend ${formatInr(a.amount_per_share).text} per share`
      : "Dividend: amount not recorded";
  }
  return typeLabel(a.type);
}

export function actionDetail(a: CorporateAction): string {
  const parts: string[] = [];
  parts.push(`Source: ${SOURCE_LABEL[a.source ?? ""] ?? (a.source ? a.source : "not stated")}`);
  if (a.record_date) parts.push(`Record date ${formatDate(a.record_date).text}`);
  if (a.purpose_text) parts.push(a.purpose_text);
  if (a.status === "confirmed" && NOT_APPLIED.has(a.type)) {
    parts.push("Review needed: this type is never applied to prices automatically.");
  }
  if (a.status === "rejected") {
    parts.push("Rejected: it is not applied and is not detected again for this date.");
  }
  return parts.join(". ");
}

export function sortActions(list: ReadonlyArray<CorporateAction>): CorporateAction[] {
  return [...list].sort((a, b) =>
    a.ex_date < b.ex_date ? 1 : a.ex_date > b.ex_date ? -1 : b.id - a.id,
  );
}

export const FUTURE_EX_NOTE =
  "Future ex-date: nothing is applied to prices until that date has arrived.";

export function isHttpUrl(u: string): boolean {
  return /^https?:\/\/\S+$/i.test(u);
}
