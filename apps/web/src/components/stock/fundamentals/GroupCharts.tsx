"use client";

import { ChartFrame } from "@/components/charts/ChartFrame";
import type { ChartDataset } from "@/components/charts/chart-data";
import { Card } from "@/components/ui/Card";
import { formatPercent } from "@/lib/format";
import {
  asOfText,
  balanceDataset,
  cashflowDataset,
  rowDataset,
  sourceText,
  waterfall,
  type FundamentalsFull,
  type SeriesRow,
} from "@/lib/stock/fundamentals";

const NONE: ChartDataset = { xName: "Period", x: [], series: [], source: "", asOf: null };

function Unavailable({
  title,
  testId,
  message,
}: {
  title: string;
  testId: string;
  message: string;
}) {
  return (
    <ChartFrame
      title={title}
      testId={testId}
      dataset={{ ...NONE, source: "Owner-entered fundamentals" }}
      state="empty"
      message={message}
      height={200}
    />
  );
}

/** Chart pane of the selected table row. */
export function RowChart({ data, row }: { data: FundamentalsFull; row: SeriesRow | null }) {
  if (!row || row.values.every((v) => v === null)) {
    return (
      <Unavailable
        title="Selected metric"
        testId="fnd-row-chart"
        message="Select a metric row with values to chart it."
      />
    );
  }
  return (
    <ChartFrame
      title={`${row.label} by period`}
      testId="fnd-row-chart"
      dataset={rowDataset(data, row)}
      filename={`fundamentals-${row.key}`}
      height={260}
    />
  );
}

export function WaterfallChart({ data }: { data: FundamentalsFull }) {
  const w = waterfall(data);
  if (!("dataset" in w)) {
    return <Unavailable title="P&L waterfall" testId="fnd-waterfall" message={w.reason} />;
  }
  return (
    <div className="flex flex-col gap-1">
      <ChartFrame
        title={`P&L waterfall, ${w.periodLabel}`}
        testId="fnd-waterfall"
        dataset={w.dataset}
        filename="fundamentals-pnl-waterfall"
        height={300}
      />
      <p className="text-caption text-text-2" data-testid="fnd-waterfall-note">
        Totals are the reported values in the table (INR crore). Steps are differences between
        reported values; a step marked (balancing) closes the gap to the next reported total and is
        not a reported figure.
      </p>
    </div>
  );
}

export function BalanceChart({ data }: { data: FundamentalsFull }) {
  const ds = balanceDataset(data);
  if (!ds) {
    return (
      <Unavailable
        title="Balance sheet composition"
        testId="fnd-balance-chart"
        message="Needs equity, borrowings or current liabilities; import balance_cashflow_annual.csv."
      />
    );
  }
  return (
    <ChartFrame
      title="Balance sheet composition"
      testId="fnd-balance-chart"
      dataset={ds}
      filename="fundamentals-balance"
      height={280}
    />
  );
}

export function CashflowChart({ data }: { data: FundamentalsFull }) {
  const ds = cashflowDataset(data);
  if (!ds) {
    return (
      <Unavailable
        title="Cash flow"
        testId="fnd-cashflow-chart"
        message="Needs CFO, CFI or CFF; import balance_cashflow_annual.csv."
      />
    );
  }
  return (
    <ChartFrame
      title="Cash flow"
      testId="fnd-cashflow-chart"
      dataset={ds}
      filename="fundamentals-cashflow"
      height={280}
    />
  );
}

/** ROE decomposition needs components the API does not return (assumption F07-6). */
export function RoeDecomposition({ data }: { data: FundamentalsFull }) {
  const roe = data.ratios?.["roe"] ?? null;
  return (
    <Card
      title="ROE decomposition"
      testId="fnd-roe-decomposition"
      state="empty"
      message={
        roe === null
          ? "ROE and its parts (margin, asset turnover, leverage) are not computed yet."
          : `ROE is ${formatPercent(roe).text}; its parts (margin, asset turnover, leverage) are not returned by the API yet, so the decomposition is not drawn.`
      }
      source={sourceText(data)}
      asOf={asOfText(data)}
    />
  );
}

/** P/E percentile strip: where today's P/E sits within its own 5-year range (percent, 0-100). */
export function PeStrip({ data }: { data: FundamentalsFull }) {
  const raw = data.valuation?.["pe_percentile_5y"];
  const v = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
  if (v === null || v < 0 || v > 100) {
    const reason =
      data.valuation_reason === "not_computed"
        ? "not computed yet"
        : data.valuation_reason
          ? data.valuation_reason.replace(/_/g, " ")
          : "insufficient history (needs 750 daily P/E points)";
    return (
      <Card
        title="P/E percentile (5 years)"
        testId="fnd-pe-strip"
        state="empty"
        message={`Not shown: ${reason}.`}
        source="Analytics snapshot"
        asOf={data.derived_as_of ?? null}
      />
    );
  }
  const text = formatPercent(v, { decimals: 0 }).text;
  const zone = v <= 33 ? "low" : v >= 67 ? "high" : "middle";
  return (
    <Card
      title="P/E percentile (5 years)"
      testId="fnd-pe-strip"
      source="Analytics snapshot"
      asOf={data.derived_as_of ?? null}
    >
      <div className="flex flex-col gap-2">
        <div
          role="img"
          aria-label={`P/E percentile ${text}, in the ${zone} third of its own 5 year range`}
          data-testid="fnd-pe-track"
          className="relative h-3 rounded-chip bg-surface-3"
        >
          <span
            className="absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-accent bg-surface-1"
            style={{ left: `${v}%` }}
          />
        </div>
        <div className="flex justify-between text-caption text-text-2">
          <span>0% cheapest</span>
          <span data-testid="fnd-pe-value">
            Now: {text} ({zone})
          </span>
          <span>100% dearest</span>
        </div>
        <p className="text-caption text-text-2">
          Share of the last 5 years&apos; days on which the P/E was at or below today&apos;s.
        </p>
      </div>
    </Card>
  );
}
