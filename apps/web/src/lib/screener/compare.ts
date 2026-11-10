export const COMPARE_RANGES = ["1M", "3M", "6M", "1Y", "3Y", "5Y", "MAX"] as const;
export type CompareRange = (typeof COMPARE_RANGES)[number];
export const DEFAULT_COMPARE_RANGE: CompareRange = "1Y";
export const MIN_COMPARE = 2;
export const MAX_COMPARE = 5;

/** Same charset as the server (`^[A-Za-z0-9&._-]{1,20}$`, docs/03 section 8; M&M, BAJAJ-AUTO). */
export const COMPARE_SYMBOL = /^[A-Za-z0-9&._-]{1,20}$/;

export type ParsedSymbols = { ok: true; symbols: string[] } | { ok: false; error: string };

/** 2 to 5 distinct symbols, comma or space separated, upper-cased (CMP-03). */
export function parseSymbols(raw: string): ParsedSymbols {
  const parts = raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (parts.some((s) => !COMPARE_SYMBOL.test(s))) {
    return {
      ok: false,
      error:
        "Symbols use letters, digits and & . _ - only, up to 20 characters, separated by commas.",
    };
  }
  const symbols = [...new Set(parts.map((s) => s.toUpperCase()))];
  if (symbols.length > MAX_COMPARE) {
    return { ok: false, error: `Compare at most ${MAX_COMPARE} stocks.` };
  }
  if (symbols.length < MIN_COMPARE) {
    return { ok: false, error: `Enter ${MIN_COMPARE} to ${MAX_COMPARE} different symbols.` };
  }
  return { ok: true, symbols };
}

export function parseRange(raw: string | null): CompareRange {
  return (COMPARE_RANGES as ReadonlyArray<string>).includes(raw ?? "")
    ? (raw as CompareRange)
    : DEFAULT_COMPARE_RANGE;
}

export const BEST_HEURISTIC_NOTE =
  "Best follows a fixed rule for each metric (for example a lower P/E or a higher ROE is better). It is a simple heuristic, not advice. Metrics such as market cap have no best.";
