"use client";

import { ChartFrame } from "@/components/charts/ChartFrame";
import type { ChartDataset } from "@/components/charts/chart-data";
import { formatPercent } from "@/lib/format";
import type { Share } from "@/lib/portfolio/mf-schemas";
import type { PortfolioView } from "@/lib/portfolio/view";
import { ALL_VIEW_SOURCE, MF_VIEW_SOURCE } from "./text";

const CLASS_NAME: Record<string, string> = { equity: "Stocks", mf: "Mutual funds" };

function allocation(
  title: string,
  xName: string,
  rows: Share[],
  asOf: string | null,
  source: string,
  rename?: Record<string, string>,
): ChartDataset {
  return {
    xName,
    x: rows.map((r) => rename?.[r.key] ?? r.key),
    series: [
      {
        id: "weight",
        name: title,
        unit: "%",
        kind: "bar",
        values: rows.map((r) => r.weight_pct),
        format: (v) => formatPercent(v).text,
      },
    ],
    source,
    asOf,
  };
}

/**
 * Allocation by asset class (All), scheme and category (MF sleeve; each sleeve sums to 100%). Weights
 * come from the server; with unpriced holdings the weights leave them out and the chart says so.
 */
export function MfChartsSection({
  view,
  byClass,
  byScheme,
  byCategory,
  partial,
  asOf,
}: {
  view: PortfolioView;
  byClass: Share[];
  byScheme: Share[];
  byCategory: Share[];
  partial: boolean;
  asOf: string | null;
}) {
  const note = "Holdings without a NAV or price are left out of the weights.";
  const state = (rows: Share[]) =>
    rows.length === 0
      ? ({ state: "empty", message: "No priced holdings to chart." } as const)
      : ({ state: partial ? "partial" : "ready", ...(partial ? { message: note } : {}) } as const);
  return (
    <section
      aria-labelledby="pf-mf-charts-h"
      className="flex flex-col gap-3"
      data-testid="pf-mf-charts"
    >
      <h2 id="pf-mf-charts-h" className="text-lead font-semibold">
        {view === "all" ? "Allocation by asset class and fund" : "Mutual fund allocation"}
      </h2>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {view === "all" ? (
          <ChartFrame
            title="Allocation by asset class (share of total value)"
            testId="pf-allocation-class"
            dataset={allocation(
              "Weight by asset class",
              "Asset class",
              byClass,
              asOf,
              ALL_VIEW_SOURCE,
              CLASS_NAME,
            )}
            height={240}
            filename="allocation-asset-class"
            {...state(byClass)}
          />
        ) : null}
        <ChartFrame
          title="Allocation by scheme (within mutual funds)"
          testId="pf-allocation-mf"
          dataset={allocation("Weight by scheme", "Scheme", byScheme, asOf, MF_VIEW_SOURCE)}
          height={240}
          filename="allocation-scheme"
          {...state(byScheme)}
        />
        <ChartFrame
          title="Allocation by category (within mutual funds)"
          testId="pf-allocation-category"
          dataset={allocation("Weight by category", "Category", byCategory, asOf, MF_VIEW_SOURCE)}
          height={240}
          filename="allocation-category"
          {...state(byCategory)}
        />
      </div>
    </section>
  );
}
