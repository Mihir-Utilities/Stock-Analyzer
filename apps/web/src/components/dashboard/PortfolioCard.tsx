"use client";

import Link from "next/link";
import { useState } from "react";
import { ChartFrame } from "@/components/charts/ChartFrame";
import type { ChartDataset } from "@/components/charts/chart-data";
import { Card } from "@/components/ui/Card";
import { DefinitionTip } from "@/components/ui/DefinitionTip";
import { Stat } from "@/components/ui/Stat";
import {
  ALL_VIEW_SOURCE,
  BASIS_LINE,
  dayPartsText,
  MF_VIEW_SOURCE,
  NO_MF_TXNS_COPY,
  reasonText,
  UNDER_ONE_YEAR_COPY,
  valueUnavailable,
} from "@/components/portfolio/text";
import { ViewSwitcher } from "@/components/portfolio/ViewSwitcher";
import { usePortfolioSummary } from "@/lib/dashboard/queries";
import type { PortfolioSummary } from "@/lib/dashboard/schemas";
import { asOfText, describeError, parseMoney } from "@/lib/dashboard/state";
import { formatInr, formatPercent } from "@/lib/format";
import type { PortfolioView } from "@/lib/portfolio/view";

export const PORTFOLIO_SOURCE = "Your imported transactions and prices";

const SOURCE_BY_VIEW: Record<PortfolioView, string> = {
  all: ALL_VIEW_SOURCE,
  equity: PORTFOLIO_SOURCE,
  mf: MF_VIEW_SOURCE,
};

const CLASS_NAME: Record<string, string> = { equity: "Stocks", mf: "Mutual funds" };

interface Alloc {
  title: string;
  xName: string;
  rows: Array<{ key: string; weight_pct: number }>;
  empty: string;
}

/** Allocation of the view: asset class (All, when served), sector (Equity, All fallback) or category (MF). */
function allocationOf(p: PortfolioSummary, view: PortfolioView): Alloc {
  if (view === "all" && (p.allocation_by_asset_class ?? []).length > 0) {
    return {
      title: "Allocation by asset class",
      xName: "Asset class",
      rows: (p.allocation_by_asset_class ?? []).map((r) => ({
        ...r,
        key: CLASS_NAME[r.key] ?? r.key,
      })),
      empty: "No allocation yet.",
    };
  }
  if (view === "mf") {
    return {
      title: "Allocation by category",
      xName: "Category",
      rows: p.allocation_by_category ?? [],
      empty: "No category allocation: funds have no category or no NAV.",
    };
  }
  return {
    title: view === "all" ? "Allocation by sector (stocks only)" : "Allocation by sector",
    xName: "Sector",
    rows: p.allocation_by_sector,
    empty: "No sector allocation: holdings have no sector or no price.",
  };
}

function allocationDataset(a: Alloc, asOf: string | null, source: string): ChartDataset {
  return {
    xName: a.xName,
    x: a.rows.map((s) => s.key),
    series: [
      {
        id: "weight",
        name: "Portfolio weight",
        unit: "%",
        kind: "bar",
        values: a.rows.map((s) => s.weight_pct),
        format: (v) => formatPercent(v).text,
      },
    ],
    source,
    asOf,
  };
}

/** Value, day change, XIRR (or absolute return under a year) and allocation, per view (docs/06 6.2). */
export function PortfolioCard() {
  const [view, setView] = useState<PortfolioView>("all");
  const q = usePortfolioSummary(view);
  const title = "Portfolio snapshot";
  const switcher = (
    <ViewSwitcher
      value={view}
      onChange={setView}
      groupTestId="dash-portfolio-view-switcher"
      segmentPrefix="dash-portfolio-view"
    />
  );
  const importAction = (
    <Link
      href={view === "mf" ? "/imports?kind=mf_statement" : "/imports"}
      data-testid="portfolio-import-link"
      className="inline-flex h-9 touch-target items-center rounded-control border border-border px-3 text-body-sm text-text-1 hover:bg-surface-3"
    >
      {view === "mf" ? "Import MF statement" : "Import transactions"}
    </Link>
  );
  if (q.isPending)
    return <Card title={title} state="loading" actions={switcher} testId="dash-portfolio" />;
  if (q.isError) {
    const u = describeError(q.error, "The portfolio");
    return (
      <Card
        title={title}
        state={u.state}
        message={u.message}
        onRetry={() => void q.refetch()}
        source={SOURCE_BY_VIEW[view]}
        actions={switcher}
        testId="dash-portfolio"
      />
    );
  }
  const p = q.data.data;
  const asOf = asOfText(q.data.meta?.as_of ?? p.as_of);
  const shown: PortfolioView =
    p.view === "all" || p.view === "equity" || p.view === "mf" ? p.view : view;
  const present = p.asset_classes_present ?? null;
  const hasAny =
    present !== null
      ? present.length > 0
      : p.holdings.length > 0 || (p.mf_holdings ?? []).length > 0;
  if (!hasAny || (shown === "mf" && present !== null && !present.includes("mf"))) {
    return (
      <Card
        title={title}
        state="empty"
        message={
          shown === "mf"
            ? NO_MF_TXNS_COPY
            : "No holdings yet. Import your transactions to see value, day change and XIRR."
        }
        source={SOURCE_BY_VIEW[shown]}
        actions={
          <>
            {switcher}
            {importAction}
          </>
        }
        testId="dash-portfolio"
      />
    );
  }
  const value = parseMoney(p.totals.market_value);
  const day = parseMoney(p.totals.day_change);
  const dayFmt = formatInr(day);
  // Signed text (+ for gains) so the direction is not carried by colour alone.
  const dayText = dayFmt.direction === "up" ? `+${dayFmt.text}` : dayFmt.text;
  const warnings = q.data.warnings.map((w) => w.message);
  const partial = value === null || p.allocation_excludes_unpriced === true || warnings.length > 0;
  const stale = q.data.meta?.stale === true;
  const partialMessage = [
    value === null
      ? p.totals.market_value_reason
        ? valueUnavailable(p.totals.market_value_reason)
        : "Some holdings have no price."
      : null,
    p.allocation_excludes_unpriced === true
      ? "Allocation leaves out holdings without a price."
      : null,
    ...warnings,
  ]
    .filter(Boolean)
    .join(" ");
  const source = SOURCE_BY_VIEW[shown];
  const dayParts = shown === "all" ? dayPartsText(p.breakdown ?? []) : null;
  const under = p.returns.xirr_reason === "under_one_year";
  const alloc = allocationOf(p, shown);
  return (
    <Card
      title={title}
      state={partial ? "partial" : "ready"}
      stale={stale}
      message={partialMessage}
      source={source}
      asOf={asOf}
      actions={switcher}
      testId="dash-portfolio"
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Stat
          label="Value"
          value={value === null ? null : formatInr(value).text}
          nullReason={
            p.totals.market_value_reason
              ? valueUnavailable(p.totals.market_value_reason)
              : "no price for some holdings"
          }
          source={source}
          asOf={asOf}
        />
        <Stat
          label="Day change"
          value={day === null ? null : dayText}
          delta={day === null ? undefined : { value: day, text: dayText }}
          definition={<DefinitionTip term="day_change" />}
          nullReason={reasonText(p.totals.day_change_reason) ?? "needs two imported bars"}
          source={source}
          asOf={asOf}
        />
        {under ? (
          <Stat
            label="Absolute return"
            value={
              p.returns.absolute_return_pct === null || p.returns.absolute_return_pct === undefined
                ? null
                : formatPercent(p.returns.absolute_return_pct, { signed: true }).text
            }
            nullReason="absolute return not available"
            definition={UNDER_ONE_YEAR_COPY}
            source={source}
            asOf={asOf}
          />
        ) : (
          <Stat
            label="XIRR"
            value={
              p.returns.xirr_pct === null || p.returns.xirr_pct === undefined
                ? null
                : formatPercent(p.returns.xirr_pct).text
            }
            definition={<DefinitionTip term="xirr" />}
            nullReason={reasonText(p.returns.xirr_reason) ?? "not enough cash flows"}
            source={source}
            asOf={asOf}
          />
        )}
      </div>
      {shown === "all" ? (
        <p className="mt-2 text-caption text-text-2" data-testid="dash-basis-line">
          {BASIS_LINE}
        </p>
      ) : null}
      {dayParts ? (
        <p className="mt-1 text-caption text-text-2" data-testid="dash-day-parts">
          Day change parts: {dayParts}.
        </p>
      ) : null}
      <div className="mt-4">
        <ChartFrame
          title={alloc.title}
          dataset={allocationDataset(alloc, asOf, source)}
          state={alloc.rows.length === 0 ? "empty" : "ready"}
          message={alloc.empty}
          height={240}
          filename="portfolio-allocation"
          testId="dash-allocation"
        />
      </div>
    </Card>
  );
}
