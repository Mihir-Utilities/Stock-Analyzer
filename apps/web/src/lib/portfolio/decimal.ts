import Decimal from "decimal.js";

// Decimal-safe money handling (docs/03 section 1: money strings with 4 decimals; D-P number
// rules). Sums and products NEVER use floats; numbers appear only at the display boundary
// (`lib/format`). PF-12: 0.1 + 0.2 is exactly 0.3000.

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

const PLAIN = /^-?\d+(\.\d+)?$/;

export function toDec(v: string | null | undefined): Decimal | null {
  if (v === null || v === undefined) return null;
  const t = v.trim();
  return PLAIN.test(t) ? new D(t) : null;
}

/** Exact 4-decimal string (API money format). */
export function money4(d: Decimal): string {
  return d.toFixed(4, Decimal.ROUND_HALF_UP);
}

/** Exact sum of known values; `missing` counts null or unparsable ones (never treated as 0). */
export function sumMoney(values: ReadonlyArray<string | null | undefined>): {
  sum: string;
  missing: number;
} {
  let total = new D(0);
  let missing = 0;
  for (const v of values) {
    const d = toDec(v);
    if (d === null) missing += 1;
    else total = total.plus(d);
  }
  return { sum: money4(total), missing };
}

/** `a * b`, exact. Null when either is unknown. */
export function mulMoney(a: string | null | undefined, b: string | null | undefined) {
  const x = toDec(a);
  const y = toDec(b);
  return x === null || y === null ? null : money4(x.times(y));
}

/** Cash effect of a trade (docs/05 8.1): buy = qty*price + fees, sell = qty*price - fees. */
export function tradeAmount(
  side: "buy" | "sell",
  qty: string,
  price: string,
  fees: string,
): string | null {
  const q = toDec(qty);
  const p = toDec(price);
  const f = toDec(fees.trim() === "" ? "0" : fees);
  if (q === null || p === null || f === null) return null;
  const gross = q.times(p);
  return money4(side === "buy" ? gross.plus(f) : gross.minus(f));
}

/** Display bridge: a decimal string as a JS number for `lib/format` only (never summed). */
export function displayNumber(v: string | null | undefined): number | null {
  const d = toDec(v);
  return d === null ? null : d.toNumber();
}

/** Number of decimals worth showing for a quantity (0 for whole shares, up to 4). */
export function qtyDecimals(v: string): number {
  const d = toDec(v);
  if (d === null) return 0;
  return Math.min(4, d.decimalPlaces());
}

/** True when `v` is a plain non-negative decimal with at most `maxDp` decimals. */
export function isPlainDecimal(v: string, maxDp: number): boolean {
  const m = /^\d+(\.(\d+))?$/.exec(v.trim());
  return m !== null && (m[2] ?? "").length <= maxDp;
}

/** Normal-notation string without trailing zeros ("10.0000" -> "10"); input unchanged when unparsable. */
export function plainString(v: string): string {
  const d = toDec(v);
  return d === null ? v : d.toFixed();
}
