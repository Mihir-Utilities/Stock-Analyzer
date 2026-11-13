import type { ChartDataset } from "@/components/charts/chart-data";
import { formatDate, formatNumber, formatPercent } from "@/lib/format";
import { invReason } from "@/lib/stock/inv-model";
import type { PeerWindow, VsIndex } from "@/lib/stock/rst-schemas";

// Wording and chart data of the Relative strength card (docs/06 6.4a.RST). Past prices only: no
// verdict, no score, no colour that says good or bad. The browser formats and selects; the
// numbers come from the stored block (docs/05 12.14).

export const RS_NOTE =
  "Beating the index in the past is not a forecast. Price return only; dividends are not included.";
export const NO_INDEX_HINT = "Import NIFTY50 history in prices.csv (the reserved symbol)";
export const RS_SOURCE =
  "Your imported prices and your imported NIFTY50, price return, excludes dividends";
export const RS_NOT_COMPUTED = "Not computed yet. It will appear after the next price import.";
export const PEER_STALE_NOTE = (asOf: string | null): string =>
  `Peer ranks are as of ${asOf ?? "the stock's last price date"}; they update when this stock is recomputed.`;
export const PEER_SURVIVOR_NOTE =
  "Stocks you track today; delisted and untracked stocks are not included; the sector label is the one you entered.";

const WINDOW_LABEL: Record<string, string> = {
  "1m": "1 month",
  "3m": "3 months",
  "6m": "6 months",
  "1y": "12 months",
};

/** Same wording for the index table and the peer tiles: `1 month (21 trading days)`. */
export function windowLabel(key: string, rows: number | null | undefined): string {
  const name = WINDOW_LABEL[key] ?? key;
  return typeof rows === "number"
    ? `${name} (${formatNumber(rows, { decimals: 0 }).text} trading days)`
    : name;
}

/** Reasons of the blank windows as readable sentences; pure, no rendering side effects. */
export function windowReasons(v: VsIndex): string[] {
  return v.windows.flatMap((w) =>
    w.reason ? [`${windowLabel(w.key, w.rows)}: ${rsReason(w.reason)}`] : [],
  );
}

/** `year to date` only when the base is a December close; otherwise the real start is named. */
export function yearLabel(y: {
  year: number;
  kind?: string | null;
  base_date?: string | null;
}): string {
  if (y.kind !== "ytd") return String(y.year);
  const base = y.base_date ?? "";
  return base.slice(5, 7) === "12"
    ? `${y.year} (year to date)`
    : `${y.year} (since ${formatDate(base || null).text})`;
}

/** `5 peers` or `3 to 5 peers`: the smallest and largest count over the periods. */
export function peerCountText(windows: ReadonlyArray<PeerWindow>): string | null {
  const n = windows.flatMap((w) => (typeof w.n_peers === "number" ? [w.n_peers] : []));
  if (n.length === 0) return null;
  const lo = Math.min(...n);
  const hi = Math.max(...n);
  const f = (x: number) => formatNumber(x, { decimals: 0 }).text;
  return lo === hi ? `${f(lo)} peers` : `${f(lo)} to ${f(hi)} peers`;
}

const RS_REASONS: Record<string, string> = {
  no_index_series: "your NIFTY50 series is missing or has too few dates in common with this stock",
  insufficient_overlap: "fewer dates in common with the index than this period needs",
  insufficient_history: "not enough price history for this period",
  too_few_windows: "fewer than 20 one-year periods",
  too_few_peers: "fewer than 3 other stocks you track in this sector have prices for this period",
  no_sector: "this stock has no sector",
  compute_error: "could not be computed for this stock",
};

export function rsReason(code: string | null | undefined, fallback = "no data"): string {
  if (!code) return fallback;
  return RS_REASONS[code] ?? invReason(code, fallback);
}

/** `+1.2 pp` / `-4.0 pp` (percentage points, signed; zero unsigned); an unknown value is an em dash. */
export function ppText(v: number | null | undefined): string {
  const f = formatPercent(v ?? null, { signed: true, decimals: 1 });
  return f.reason === null ? `${f.text.replace("%", "")} pp` : f.text;
}

/** `75th percentile`; the number is rounded to a whole percentile for the ordinal. */
export function percentileText(p: number | null | undefined): string {
  if (p === null || p === undefined || !Number.isFinite(p)) return formatNumber(null).text;
  const n = Math.round(p);
  const tens = n % 100;
  const suffix =
    tens >= 11 && tens <= 13
      ? "th"
      : (({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th");
  return `${formatNumber(n, { decimals: 0 }).text}${suffix} percentile`;
}

/** Rank wording; hidden (null) below the peer minimum. */
export function rankText(w: PeerWindow): string | null {
  if (w.rank === null || w.rank === undefined || w.n_total === null || w.n_total === undefined) {
    return null;
  }
  return `Rank ${formatNumber(w.rank, { decimals: 0 }).text} of ${formatNumber(w.n_total, { decimals: 0 }).text}`;
}

export type RatioPlan =
  | { kind: "chart"; dataset: ChartDataset; first: number | null; last: number | null }
  | { kind: "none"; reason: string };

const RATIO_NAME = "Stock divided by Nifty 50 (first day shown = 100)";

/** The rebased ratio line on the dates of the `analysis.drawdown` pairs, with a 100 reference line. */
export function ratioPlan(
  v: VsIndex,
  dates: ReadonlyArray<string>,
  asOf: string | null,
): RatioPlan {
  const ratio = v.ratio_rebased;
  if (!ratio) return { kind: "none", reason: rsReason(v.ratio_reason, "no ratio line") };
  if (dates.length === 0 || dates.length !== ratio.length) {
    return { kind: "none", reason: "the chart dates are not available for this snapshot" };
  }
  const known = ratio.filter((x): x is number => typeof x === "number");
  if (known.length < 2) return { kind: "none", reason: rsReason("insufficient_overlap") };
  const values = ratio.map((x) => (typeof x === "number" ? x : null));
  return {
    kind: "chart",
    first: known[0] ?? null,
    last: known[known.length - 1] ?? null,
    dataset: {
      xName: "Date",
      x: dates.map((d) => formatDate(d).text),
      series: [
        {
          id: "ratio",
          name: RATIO_NAME,
          unit: "index (first day = 100)",
          kind: "line",
          values,
          format: (n) => formatNumber(n, { decimals: 1 }).text,
          nullReason: "this date is not in both your stock and your NIFTY50 prices",
        },
        {
          id: "level-100",
          name: "100 = same as at the start",
          unit: "index (first day = 100)",
          kind: "line",
          dash: "dashed",
          values: values.map((x) => (x === null ? null : 100)),
          format: (n) => formatNumber(n, { decimals: 0 }).text,
        },
      ],
      source: RS_SOURCE,
      asOf: asOf ? formatDate(asOf).text : null,
    },
  };
}
