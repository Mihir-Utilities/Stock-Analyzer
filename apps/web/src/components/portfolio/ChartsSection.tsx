"use client";

import { ChartFrame } from "@/components/charts/ChartFrame";
import type { ChartDataset } from "@/components/charts/chart-data";
import { Card } from "@/components/ui/Card";
import { formatInr, formatPercent } from "@/lib/format";
import { displayNumber, sumMoney } from "@/lib/portfolio/decimal";
import type { PortfolioSummary } from "@/lib/portfolio/schemas";
import { PORTFOLIO_SOURCE } from "./text";

function allocation(
  title: string,
  xName: string,
  rows: PortfolioSummary["allocation_by_sector"],
  asOf: string | null,
): ChartDataset {
  return {
    xName,
    x: rows.map((r) => r.key),
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
    source: PORTFOLIO_SOURCE,
    asOf,
  };
}

const inrText = (v: number) => formatInr(v, { signed: true }).text;

/** Allocation, contribution and P&L breakdown. All values come from the summary response. */
export function ChartsSection({ s, asOf }: { s: PortfolioSummary; asOf: string | null }) {
  const priced = s.holdings.filter((h) => !h.exited);
  const partial = s.allocation_excludes_unpriced === true;
  const empty = priced.length === 0;
  const emptyProps = empty
    ? ({ state: "empty", message: "No open holdings to chart." } as const)
    : ({ state: partial ? "partial" : "ready" } as const);
  const partialMsg = "Holdings without a price are left out of the weights.";

  const contribution: ChartDataset = {
    xName: "Holding",
    x: priced.map((h) => h.symbol),
    series: [
      {
        id: "unrealized",
        name: "Unrealized P&L",
        unit: "INR",
        kind: "bar",
        values: priced.map((h) => displayNumber(h.unrealized_pnl)),
        format: inrText,
        nullReason: "needs a valid close",
        estimated: true,
      },
    ],
    source: PORTFOLIO_SOURCE,
    asOf,
  };

  const unrealized = s.totals.unrealized_pnl ?? null;
  const total = unrealized === null ? null : sumMoney([unrealized, s.totals.realized_pnl]).sum;
  const breakdown: ChartDataset = {
    xName: "Component",
    x: ["Unrealized", "Realized", "Total"],
    series: [
      {
        id: "pnl",
        name: "P&L",
        unit: "INR",
        kind: "bar",
        values: [
          displayNumber(unrealized),
          displayNumber(s.totals.realized_pnl),
          displayNumber(total),
        ],
        format: inrText,
        nullReason: "needs a valid close",
      },
    ],
    source: PORTFOLIO_SOURCE,
    asOf,
  };

  return (
    <section aria-labelledby="pf-charts-h" className="flex flex-col gap-3" data-testid="pf-charts">
      <h2 id="pf-charts-h" className="text-lead font-semibold">
        Allocation and contribution
      </h2>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <ChartFrame
          title="Allocation by sector"
          testId="pf-chart-sector"
          dataset={allocation("Weight by sector", "Sector", s.allocation_by_sector, asOf)}
          height={240}
          filename="allocation-sector"
          {...emptyProps}
          {...(partial && !empty ? { message: partialMsg } : {})}
        />
        <ChartFrame
          title="Allocation by stock"
          testId="pf-chart-stock"
          dataset={allocation("Weight by stock", "Stock", s.allocation_by_stock, asOf)}
          height={240}
          filename="allocation-stock"
          {...emptyProps}
          {...(partial && !empty ? { message: partialMsg } : {})}
        />
        <ChartFrame
          title="Contribution: unrealized P&L by holding"
          testId="pf-chart-contribution"
          dataset={contribution}
          height={240}
          filename="contribution"
          {...emptyProps}
          {...(partial && !empty ? { message: "Holdings without a price show no bar." } : {})}
        />
        <ChartFrame
          title="P&L breakdown (INR)"
          testId="pf-chart-breakdown"
          dataset={breakdown}
          height={240}
          filename="pnl-breakdown"
          state={unrealized === null ? "partial" : "ready"}
          {...(unrealized === null
            ? { message: "Unrealized and total are unknown until every holding has a price." }
            : {})}
        />
        <Card
          title="Growth vs Nifty 50 and drawdown"
          state="empty"
          message="Not available yet: the server has no portfolio value history to chart. The XIRR and benchmark cards above use your dated cash flows."
          source={PORTFOLIO_SOURCE}
          asOf={asOf}
          testId="pf-chart-growth-unavailable"
        />
      </div>
    </section>
  );
}
