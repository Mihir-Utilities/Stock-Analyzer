// ASSUMPTION F13a-n: F03 owns `format.ts`. Until it is merged, the import screens format numbers
// through this thin helper only; replace the bodies with calls to `format.ts` and delete this file.
// Unknown values (null, NaN, Infinity) are never shown as 0: they render the dash.

export const UNKNOWN = "—";

const countFmt = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });

export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return UNKNOWN;
  return countFmt.format(n);
}

/** Megabytes with a unit; very small values keep two decimals so 0.01 MB is not shown as 0. */
export function formatMb(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return UNKNOWN;
  const digits = n !== 0 && Math.abs(n) < 0.1 ? 2 : 1;
  return `${n.toFixed(digits)} MB`;
}

export function formatRatio(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return UNKNOWN;
  return n.toFixed(4);
}

export function formatPercentOf(part: number, whole: number): string {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return UNKNOWN;
  return `${((part / whole) * 100).toFixed(1)}%`;
}

/** Cell text for the preview table: empty cells stay empty (shown as the dash), never 0. */
export function formatCell(v: unknown): string {
  if (v === null || v === undefined || v === "") return UNKNOWN;
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : UNKNOWN;
  if (typeof v === "string" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}
