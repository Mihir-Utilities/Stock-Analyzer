import { formatMb } from "@/lib/format";
import type { ImportKind } from "./schemas";

// Client-side pre-check of a chosen file (docs/03 section 4: <= 5 MB and 50,000 rows; prices
// 25 MB / 300,000 rows once spike S9 enables it). The server stays authoritative: this only saves a
// pointless upload. The active limit is not exposed by the API (assumption F13a-1), so a prices file
// between 5 and 25 MB is allowed with a warning and the server decides. Rows are not counted here.

const MIB = 1024 * 1024;
export const DEFAULT_MAX_BYTES = 5 * MIB;
export const PRICES_LARGE_MAX_BYTES = 25 * MIB;

export interface Precheck {
  /** Set when the file cannot be accepted; the wizard does not upload it. */
  blocked: string | null;
  /** Set when the server may still reject the file. */
  warning: string | null;
}

export function precheckFile(file: { name: string; size: number }, kind: ImportKind): Precheck {
  if (!/\.csv$/i.test(file.name)) {
    return {
      blocked: "Only .csv files can be imported. Choose a file that ends in .csv.",
      warning: null,
    };
  }
  const size = formatMb(file.size / MIB).text;
  const hardMax = kind === "prices" ? PRICES_LARGE_MAX_BYTES : DEFAULT_MAX_BYTES;
  if (file.size > hardMax) {
    const limit = formatMb(hardMax / MIB).text;
    return {
      blocked: `This file is ${size}, above the limit of ${limit}. Split it into smaller files.`,
      warning: null,
    };
  }
  if (file.size > DEFAULT_MAX_BYTES) {
    return {
      blocked: null,
      warning: `This file is ${size}, above the default limit of ${formatMb(DEFAULT_MAX_BYTES / MIB).text}. The server accepts it only when large price imports are enabled and rejects it otherwise.`,
    };
  }
  return { blocked: null, warning: null };
}
