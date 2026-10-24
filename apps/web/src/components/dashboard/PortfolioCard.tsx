"use client";

import Link from "next/link";
import { ChartFrame } from "@/components/charts/ChartFrame";
import type { ChartDataset } from "@/components/charts/chart-data";
import { Card } from "@/components/ui/Card";
import { DefinitionTip } from "@/components/ui/DefinitionTip";
import { Stat } from "@/components/ui/Stat";
import { usePortfolioSummary } from "@/lib/dashboard/queries";
import type { PortfolioSummary } from "@/lib/dashboard/schemas";
import { asOfText, describeError, parseMoney } from "@/lib/dashboard/state";
import { formatInr, formatPercent } from "@/lib/format";

export const PORTFOLIO_SOURCE = "Your imported transactions and prices";

function allocationDataset(p: PortfolioSummary, asOf: string | null): ChartDataset {
  return {
    xName: "Sector",
    x: p.allocation_by_sector.map((s) => s.key),
    series: [
      {
        id: "weight",
        name: "Portfolio weight",
        unit: "%",
        kind: "bar",
        values: p.allocation_by_sector.map((s) => s.weight_pct),
        format: (v) => formatPercent(v).text,
      },
    ],
    source: PORTFOLIO_SOURCE,
    asOf,
  };
}

/** Value, day change, XIRR and the allocation by sector (docs/06 section 6.2). */
export function PortfolioCard() {
  const q = usePortfolioSummary();
  const title = "Portfolio snapshot";
  const importAction = (
    <Link
      href="/imports"
      data-testid="portfolio-import-link"
      className="inline-flex h-9 touch-target items-center rounded-control border border-border px-3 text-body-sm text-text-1 hover:bg-surface-3"
    >
      Import transactions
    </Link>
  );
  if (q.isPending) return <Card title={title} state="loading" testId="dash-portfolio" />;
  if (q.isError) {
    const u = describeError(q.error, "The portfolio");
    return (
      <Card
        title={title}
        state={u.state}
        message={u.message}
        onRetry={() => void q.refetch()}
        source={PORTFOLIO_SOURCE}
        testId="dash-portfolio"
      />
    );
  }
  const p = q.data.data;
  const asOf = asOfText(q.data.meta?.as_of ?? p.as_of);
  if (p.holdings.length === 0) {
    return (
      <Card
        title={title}
        state="empty"
        message="No holdings yet. Import your transactions to see value, day change and XIRR."
        source={PORTFOLIO_SOURCE}
        actions={importAction}
        testId="dash-portfolio"
      />
    );
  }
  const value = parseMoney(p.totals.market_value);
  const day = parseMoney(p.totals.day_change);
  const warnings = q.data.warnings.map((w) => w.message);
  const partial = value === null || p.allocation_excludes_unpriced === true || warnings.length > 0;
  const state = partial ? "partial" : q.data.meta?.stale === true ? "stale" : "ready";
  const partialMessage = [
    value === null ? (p.totals.market_value_reason ?? "Some holdings have no price.") : null,
    p.allocation_excludes_unpriced === true
      ? "Allocation leaves out holdings without a price."
      : null,
    ...warnings,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <Card
      title={title}
      state={state}
      message={partialMessage}
      source={PORTFOLIO_SOURCE}
      asOf={asOf}
      testId="dash-portfolio"
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Stat
          label="Value"
          value={value === null ? null : formatInr(value).text}
          nullReason={p.totals.market_value_reason ?? "no price for some holdings"}
          source={PORTFOLIO_SOURCE}
          asOf={asOf}
        />
        <Stat
          label="Day change"
          value={day === null ? null : formatInr(day).text}
          delta={day === null ? undefined : { value: day, text: formatInr(day).text }}
          definition={<DefinitionTip term="day_change" />}
          nullReason={p.totals.day_change_reason ?? "needs two imported bars"}
          source={PORTFOLIO_SOURCE}
          asOf={asOf}
        />
        <Stat
          label="XIRR"
          value={
            p.returns.xirr_pct === null || p.returns.xirr_pct === undefined
              ? null
              : formatPercent(p.returns.xirr_pct).text
          }
          definition={<DefinitionTip term="xirr" />}
          nullReason={p.returns.xirr_reason ?? "not enough cash flows"}
          source={PORTFOLIO_SOURCE}
          asOf={asOf}
        />
      </div>
      <div className="mt-4">
        <ChartFrame
          title="Allocation by sector"
          dataset={allocationDataset(p, asOf)}
          state={p.allocation_by_sector.length === 0 ? "empty" : "ready"}
          message="No sector allocation: holdings have no sector or no price."
          height={240}
          filename="portfolio-allocation"
          testId="dash-allocation"
        />
      </div>
    </Card>
  );
}
