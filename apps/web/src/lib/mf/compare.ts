export type ParsedCodes = { ok: true; codes: number[] } | { ok: false; error: string };

/** 2 to 5 distinct positive whole-number scheme codes (docs/03 section 10, MF-94). */
export function parseCodes(raw: string): ParsedCodes {
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (parts.some((s) => !/^\d{1,10}$/.test(s) || Number(s) < 1)) {
    return { ok: false, error: "Scheme codes are positive whole numbers separated by commas." };
  }
  const codes = parts.map(Number);
  if (new Set(codes).size !== codes.length) {
    return { ok: false, error: "Each scheme code can be used once." };
  }
  if (codes.length < 2 || codes.length > 5) {
    return { ok: false, error: "Enter 2 to 5 different scheme codes." };
  }
  return { ok: true, codes };
}
