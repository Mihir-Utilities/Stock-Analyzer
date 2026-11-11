import { formatCount, formatMonthName, formatMonthYear } from "@/lib/format";
import { invReason, istMonth } from "@/lib/stock/inv-model";
import type { WatchSeasonality } from "@/lib/stock/inv-schemas";
import type { SeasonStock } from "./schemas";

// Pure helpers for the Home tile "This month, across the years" (docs/06 6.2a). The tile computes
// nothing: it sorts, filters and words the stored `stocks[].seasonality` of GET /stocks/seasonality.

export type SeasonSort = "share" | "years" | "symbol" | "mtd";
export const SORT_LABELS: Record<SeasonSort, string> = {
  share: "Best share first",
  years: "Most years first",
  symbol: "Symbol A to Z",
  mtd: "Month so far, high to low",
};
export const MIN_YEARS_OPTIONS = [3, 5, 8] as const;
export const SEASON_NOTE =
  "Past behaviour is not a forecast. Counts only closed past months from your imported prices (price change, dividends excluded).";
export const HISTORY_NOTE =
  "History starts at your first imported price, which may be later than the listing date.";
export const SEASON_SOURCE = "Your imported prices";

export interface RankedRow {
  stock: SeasonStock;
  s: WatchSeasonality;
}
export interface ShortRow {
  stock: SeasonStock;
  reason: string;
}

const num = (v: number | null | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v);

/** Reason a stock is not ranked: no snapshot, fewer years than the minimum, or no share yet. */
function shortReason(stock: SeasonStock, minYears: number): string | null {
  const s = stock.seasonality;
  if (!s) {
    return stock.seasonality_reason ? invReason(stock.seasonality_reason) : "Not computed yet";
  }
  const n = s.n_years ?? 0;
  if (!num(s.green_pct)) {
    return `${formatCount(n).text} years of this month so far; at least ${formatCount(s.min_years ?? 3).text} are needed`;
  }
  if (n < minYears) {
    return `${formatCount(n).text} years of this month so far; at least ${formatCount(minYears).text} are needed`;
  }
  return null;
}

const bySymbol = (a: RankedRow, b: RankedRow) => a.stock.symbol.localeCompare(b.stock.symbol);

/** Ranked rows (sorted) and the "Not enough years yet" group. */
export function rankSeasonality(
  stocks: ReadonlyArray<SeasonStock>,
  sort: SeasonSort,
  minYears: number,
): { ranked: RankedRow[]; short: ShortRow[] } {
  const ranked: RankedRow[] = [];
  const short: ShortRow[] = [];
  for (const stock of stocks) {
    const reason = shortReason(stock, minYears);
    if (reason === null && stock.seasonality) ranked.push({ stock, s: stock.seasonality });
    else short.push({ stock, reason: reason ?? "Not computed yet" });
  }
  const share = (r: RankedRow) => r.s.green_pct ?? -1;
  const yrs = (r: RankedRow) => r.s.n_years ?? 0;
  ranked.sort((a, b) => {
    if (sort === "symbol") return bySymbol(a, b);
    if (sort === "years") return yrs(b) - yrs(a) || share(b) - share(a) || bySymbol(a, b);
    if (sort === "mtd") {
      const am = num(a.s.mtd_return_pct) ? a.s.mtd_return_pct : null;
      const bm = num(b.s.mtd_return_pct) ? b.s.mtd_return_pct : null;
      if (am === null && bm === null) return bySymbol(a, b);
      if (am === null) return 1;
      if (bm === null) return -1;
      return bm - am || bySymbol(a, b);
    }
    return share(b) - share(a) || yrs(b) - yrs(a) || bySymbol(a, b);
  });
  short.sort((a, b) => a.stock.symbol.localeCompare(b.stock.symbol));
  return { ranked, short };
}

export const ariaSort = (sort: SeasonSort): "ascending" | "descending" =>
  sort === "symbol" ? "ascending" : "descending";

/** "{n_green} of {n_years} years green ({pct}%)" with the percent in whole numbers. */
export function mainLine(s: WatchSeasonality, pct: string): string {
  return `${formatCount(s.n_green ?? 0).text} of ${formatCount(s.n_years ?? 0).text} years green (${pct})`;
}

/** "{n} years of this month, history starts {Mon YYYY}" (never "since listing"). */
export function subLine(s: WatchSeasonality): string {
  return `${formatCount(s.n_years ?? 0).text} years of this month, history starts ${formatMonthYear(s.data_since ?? null, { reason: "date unknown" }).text}`;
}

/** The month the tile is about: the API's month name, else the IST month of `now`. */
export function tileMonth(stocks: ReadonlyArray<SeasonStock>, now: Date): string {
  const named = stocks.find((s) => s.seasonality?.month_name)?.seasonality?.month_name;
  if (named) return named;
  const m = stocks.find((s) => s.seasonality?.month)?.seasonality?.month;
  const f = formatMonthName(m ?? istMonth(now));
  return f.reason === null ? f.text : "This month";
}

export function latestSeasonAsOf(stocks: ReadonlyArray<SeasonStock>): string | null {
  let best: string | null = null;
  for (const s of stocks) {
    const d = s.seasonality?.as_of;
    if (d && (best === null || d > best)) best = d;
  }
  return best;
}
