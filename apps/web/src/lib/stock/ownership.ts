import { z } from "zod";
import type { ChartDataset } from "@/components/charts/chart-data";
import { apiRequest } from "@/lib/api/client";
import { formatPercent } from "@/lib/format";
import { redirectSchema } from "./schemas";

// Ownership tab model (docs/06 6.4, docs/03 section 5 shareholding, B05-1/2/7). Everything here is
// pure except the request. Percent values are percent numbers (12.34 = 12.34%); the QoQ change is in
// percentage points. A null is unknown and is never turned into 0 (SHP-02).

const series = z.array(z.number().nullable());
const nullStr = z.string().nullable().optional();

export const shareholdingDataSchema = z.object({
  quarters: z.array(z.string()),
  promoter: series,
  fii: series,
  dii: series,
  mf: series,
  insurance: series,
  govt: series,
  public: series,
  pledged: series,
  unit: z.string().optional(),
  qoq_change: z.record(z.string(), z.number().nullable()),
  qoq_reason: nullStr,
  latest_filed_on: nullStr,
  mf_available: z.boolean(),
  note: nullStr,
  reason: nullStr,
  entry_hint: nullStr,
  source: nullStr,
  last_updated: nullStr,
});
export type ShareholdingData = z.infer<typeof shareholdingDataSchema>;
export const shareholdingSchema = z.union([redirectSchema, shareholdingDataSchema]);

export const shareholdingKey = (symbol: string) => ["stocks", symbol, "shareholding"] as const;

export const getShareholding = (symbol: string) =>
  apiRequest(`/stocks/${encodeURIComponent(symbol)}/shareholding`, { schema: shareholdingSchema });

export const GROUPS = [
  "promoter",
  "fii",
  "dii",
  "mf",
  "insurance",
  "govt",
  "public",
  "pledged",
] as const;
export type GroupId = (typeof GROUPS)[number];

export const GROUP_LABEL: Record<GroupId, string> = {
  promoter: "Promoters",
  fii: "FII",
  dii: "DII",
  mf: "Mutual funds",
  insurance: "Insurance",
  govt: "Government",
  public: "Public",
  pledged: "Pledged (of promoter holding)",
};

/** Plain words for the API's `qoq_reason` codes (B05-1). */
export const QOQ_REASON: Record<string, string> = {
  single_quarter: "only one quarter is entered, so there is no change to show",
  previous_quarter_missing:
    "the quarter before the latest one is missing, so no quarter-over-quarter change is shown",
  no_data_entered: "no shareholding entered",
};

export const MF_MISSING_COPY =
  "DII (includes mutual funds): the mutual fund figure was not entered.";

const SOURCE = (s: ShareholdingData) =>
  `Owner-entered shareholding${s.source ? ` (${s.source})` : ""}`;
const asOf = (s: ShareholdingData) => s.quarters[s.quarters.length - 1] ?? null;
const round4 = (n: number) => Math.round(n * 10000) / 10000;
const known = (v: number | null | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v);
const pct = (v: number) => formatPercent(v).text;

type Col = ChartDataset["series"][number];

function area(id: string, name: string, values: ReadonlyArray<number | null>): Col {
  return { id, name, unit: "%", kind: "area", stack: "holders", values, format: pct };
}

/** Stacked composition: promoters, FII, DII excluding MF, MF, public, government (docs/06a). */
export function stackedDataset(s: ShareholdingData): ChartDataset {
  const diiEx = s.dii.map((d, i) => {
    const m = s.mf[i];
    return known(d) && known(m) ? round4(d - m) : null;
  });
  // A quarter without the MF figure keeps its whole DII value in its own, honestly named series.
  const diiWithMf = s.dii.map((d, i) => (known(d) && !known(s.mf[i]) ? d : null));
  const anyMf = s.mf.some(known);
  const anyMfMissing = diiWithMf.some(known);
  const cols: Col[] = [area("promoter", "Promoters", s.promoter), area("fii", "FII", s.fii)];
  if (anyMf || !anyMfMissing) cols.push(area("dii_ex_mf", "DII excluding MF", diiEx));
  if (anyMf) cols.push(area("mf", "Mutual funds", s.mf));
  if (anyMfMissing) {
    cols.push(area("dii_incl_mf", "DII (includes MF, MF not entered)", diiWithMf));
  }
  cols.push(area("public", "Public", s.public), area("govt", "Government", s.govt));
  return { xName: "Quarter end", x: s.quarters, series: cols, source: SOURCE(s), asOf: asOf(s) };
}

export function pledgeDataset(s: ShareholdingData): ChartDataset {
  return {
    xName: "Quarter end",
    x: s.quarters,
    series: [
      {
        id: "pledged",
        name: "Pledged",
        unit: "% of promoter holding",
        kind: "line",
        values: s.pledged,
        nullReason: "pledge not entered",
        format: pct,
      },
    ],
    source: SOURCE(s),
    asOf: asOf(s),
  };
}

/** Diverging bars of the latest quarter-over-quarter change per holder, in percentage points. */
export function qoqDataset(s: ShareholdingData): ChartDataset | null {
  const ids = GROUPS.filter((g) => known(s.qoq_change[g]));
  if (ids.length === 0) return null;
  return {
    xName: "Holder",
    x: ids.map((g) => GROUP_LABEL[g]),
    series: [
      {
        id: "qoq",
        name: "Change vs previous quarter",
        unit: "percentage points",
        kind: "bar",
        values: ids.map((g) => s.qoq_change[g] ?? null),
        format: (v) => ppText(v),
      },
    ],
    source: SOURCE(s),
    asOf: asOf(s),
  };
}

/** `+0.12 pp` / `-0.30 pp` (percentage points, signed). */
export function ppText(v: number | null | undefined): string {
  const f = formatPercent(v, { signed: true });
  return f.reason === null ? `${f.text.replace("%", "")} pp` : f.text;
}

const DAY = 86_400_000;
const dayNumber = (iso: string): number => Date.parse(`${iso}T00:00:00Z`) / DAY;

export interface Trend {
  direction: "up" | "down";
  /** Consecutive quarter-over-quarter moves in the same direction, ending at the latest quarter. */
  quarters: number;
}

/** Minimum consecutive same-direction moves for the badge (assumption F08-2, owner to confirm). */
export const SUSTAINED_MIN = 3;

/**
 * "Sustained trend" badge: the latest SUSTAINED_MIN or more steps between consecutive quarters
 * (70 to 111 days apart, as B05-7 defines a quarter-over-quarter step) all moved the same way.
 * A missing value or a missing quarter ends the run; an unchanged value is not a move.
 */
export function sustainedTrend(
  quarters: ReadonlyArray<string>,
  values: ReadonlyArray<number | null>,
): Trend | null {
  let dir: "up" | "down" | null = null;
  let run = 0;
  for (let i = quarters.length - 1; i > 0; i--) {
    const a = values[i];
    const b = values[i - 1];
    const q = quarters[i];
    const p = quarters[i - 1];
    if (!known(a) || !known(b) || q === undefined || p === undefined) break;
    const gap = dayNumber(q) - dayNumber(p);
    if (!(gap >= 70 && gap <= 111)) break;
    const d: "up" | "down" | null = a > b ? "up" : a < b ? "down" : null;
    if (d === null || (dir !== null && d !== dir)) break;
    dir = d;
    run++;
  }
  return dir !== null && run >= SUSTAINED_MIN ? { direction: dir, quarters: run } : null;
}
