// Database size policy (docs/04 section 3.10, decision D-C): meter against DB_SOFT_LIMIT_MB with
// notices at 70/85/95 % and a hard stop at 100 %.

export const DB_SOFT_LIMIT_MB = 380;

export type WarnLevel = "ok" | "70" | "85" | "95" | "limit";

export function warnLevelFor(sizeMb: number, limitMb = DB_SOFT_LIMIT_MB): WarnLevel {
  const f = sizeMb / limitMb;
  if (!Number.isFinite(f)) return "ok";
  if (f >= 1) return "limit";
  if (f >= 0.95) return "95";
  if (f >= 0.85) return "85";
  if (f >= 0.7) return "70";
  return "ok";
}

export function warnLevelText(level: WarnLevel): string {
  switch (level) {
    case "ok":
      return "Within the free-tier budget.";
    case "70":
      return "70% of the budget is used. Consider trimming old history.";
    case "85":
      return "85% of the budget is used. Trim history before the next large import.";
    case "95":
      return "95% of the budget is used. Price imports stop at 100%.";
    case "limit":
      return "The database is at its limit. Price imports are rejected until you free space.";
  }
}

/** Plain message of the size guard (docs/01 section 7.1). */
export function sizeGuardMessage(limitMb = DB_SOFT_LIMIT_MB): string {
  return `This file would make the database exceed ${limitMb} MB; trim history or import fewer rows.`;
}

/** True only when the current size is known and the projection crosses the limit. */
export function exceedsLimit(
  currentMb: number | null,
  growthMb: number | null,
  limitMb = DB_SOFT_LIMIT_MB,
): boolean {
  if (currentMb === null || growthMb === null) return false;
  // The API also refuses a prices commit whenever the database is already at the limit.
  return currentMb >= limitMb || currentMb + growthMb > limitMb;
}
