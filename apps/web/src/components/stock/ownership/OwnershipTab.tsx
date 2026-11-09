"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp } from "lucide-react";
import Link from "next/link";
import { ChartFrame } from "@/components/charts/ChartFrame";
import { STALE_TIME } from "@/components/shell/Providers";
import { Banner } from "@/components/ui/banners";
import { Card } from "@/components/ui/Card";
import { AsOfChip, SourceChip } from "@/components/ui/chips";
import { DeltaBadge } from "@/components/ui/DeltaBadge";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { Sparkline } from "@/components/ui/Sparkline";
import {
  fiscalQuarterLabel,
  formatDate,
  formatDateTime,
  formatPercent,
  NULL_REASONS,
} from "@/lib/format";
import { toLoad } from "@/lib/stock/load";
import {
  getShareholding,
  GROUP_LABEL,
  GROUPS,
  MF_MISSING_COPY,
  pledgeDataset,
  ppText,
  QOQ_REASON,
  qoqDataset,
  shareholdingKey,
  stackedDataset,
  sustainedTrend,
  type GroupId,
  type ShareholdingData,
} from "@/lib/stock/ownership";

const linkClass = "touch-target inline-flex items-center text-body-sm text-accent underline";

function quarterText(q: string): string {
  const f = fiscalQuarterLabel(q);
  return f.reason === null ? f.text : formatDate(q).text;
}

function NotEntered({ what }: { what: string }) {
  return (
    <span className="text-text-2" title={`${what} was not entered`}>
      {formatPercent(null, { reason: `${what} was not entered` }).text}
    </span>
  );
}

function pctCell(v: number | null, what: string) {
  return v === null ? (
    <NotEntered what={what} />
  ) : (
    <span className="num">{formatPercent(v).text}</span>
  );
}

function TrendBadge({ s, g }: { s: ShareholdingData; g: GroupId }) {
  const t = sustainedTrend(s.quarters, s[g]);
  if (!t) {
    return (
      <span data-testid={`trend-${g}`} className="text-caption text-text-2">
        No sustained trend
      </span>
    );
  }
  const Icon = t.direction === "up" ? ArrowUp : ArrowDown;
  return (
    <span
      data-testid={`trend-${g}`}
      data-direction={t.direction}
      className="inline-flex items-center gap-1 rounded-chip border border-border bg-surface-2 px-2 py-0.5 text-micro text-text-1"
    >
      <Icon size={12} strokeWidth={2} aria-hidden="true" />
      {t.direction === "up" ? "Rising" : "Falling"} {t.quarters} quarters in a row
    </span>
  );
}

function SmallMultiples({ s }: { s: ShareholdingData }) {
  return (
    <section aria-labelledby="own-multiples-h" className="flex flex-col gap-2">
      <h3 id="own-multiples-h" className="text-body font-semibold text-text-1">
        Each holder at a glance
      </h3>
      <div
        role="region"
        tabIndex={0}
        aria-label="Holder summary table, scrolls sideways on small screens"
        className="overflow-x-auto"
      >
        <table data-testid="ownership-multiples" className="w-full text-body-sm">
          <thead>
            <tr className="text-left text-caption text-text-2">
              <th scope="col" className="py-1 pr-3 font-medium">
                Holder
              </th>
              <th scope="col" className="py-1 pr-3 font-medium">
                Latest
              </th>
              <th scope="col" className="py-1 pr-3 font-medium">
                Change vs previous quarter
              </th>
              <th scope="col" className="py-1 pr-3 font-medium">
                Trend
              </th>
              <th scope="col" className="py-1 font-medium">
                History
              </th>
            </tr>
          </thead>
          <tbody>
            {GROUPS.map((g) => {
              const last = s[g][s[g].length - 1] ?? null;
              const qoq = s.qoq_change[g] ?? null;
              return (
                <tr key={g} data-testid={`multiple-${g}`} className="border-t border-border">
                  <th scope="row" className="py-1 pr-3 text-left font-normal text-text-1">
                    {g === "dii" && !s.mf_available
                      ? "DII (includes mutual funds)"
                      : GROUP_LABEL[g]}
                  </th>
                  <td className="py-1 pr-3">{pctCell(last, GROUP_LABEL[g])}</td>
                  <td className="py-1 pr-3">
                    <DeltaBadge value={qoq} text={qoq === null ? null : ppText(qoq)} />
                  </td>
                  <td className="py-1 pr-3">
                    <TrendBadge s={s} g={g} />
                  </td>
                  <td className="py-1">
                    <Sparkline values={s[g]} label={`${GROUP_LABEL[g]}, % by quarter`} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function QuarterTable({ s }: { s: ShareholdingData }) {
  const order = s.quarters.map((_, i) => s.quarters.length - 1 - i);
  return (
    <section aria-labelledby="own-table-h" className="flex flex-col gap-2">
      <h3 id="own-table-h" className="text-body font-semibold text-text-1">
        Quarter by quarter (% of shares; pledged is % of promoter holding)
      </h3>
      <div
        role="region"
        tabIndex={0}
        aria-label="Shareholding by quarter table, scrolls sideways on small screens"
        className="overflow-x-auto"
      >
        <table data-testid="ownership-table" className="w-full text-body-sm">
          <thead>
            <tr className="text-left text-caption text-text-2">
              <th scope="col" className="py-1 pr-3 font-medium">
                Quarter
              </th>
              {GROUPS.map((g) => (
                <th key={g} scope="col" className="py-1 pr-3 font-medium">
                  {GROUP_LABEL[g]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {order.map((i) => (
              <tr key={s.quarters[i]} className="border-t border-border">
                <th scope="row" className="py-1 pr-3 text-left font-normal text-text-1">
                  {quarterText(s.quarters[i] ?? "")}
                </th>
                {GROUPS.map((g) => (
                  <td key={g} className="py-1 pr-3">
                    {pctCell(s[g][i] ?? null, GROUP_LABEL[g])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Body({ s, stale }: { s: ShareholdingData; stale: boolean }) {
  const qoq = qoqDataset(s);
  const pledged = s.pledged.some((v) => v !== null);
  const qoqWhy = QOQ_REASON[s.qoq_reason ?? ""] ?? s.qoq_reason ?? NULL_REASONS.noData;
  const latest = s.quarters[s.quarters.length - 1] ?? null;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2" data-testid="ownership-meta">
        <SourceChip source={s.source ?? "owner entry"} />
        <AsOfChip asOf={latest ? `${quarterText(latest)} quarter end` : null} stale={stale} />
        <span className="text-caption text-text-2" data-testid="ownership-dates">
          Latest quarter filed on{" "}
          {formatDate(s.latest_filed_on, { reason: "filing date not entered" }).text}. Last entered{" "}
          {formatDateTime(s.last_updated, { reason: "unknown" }).text}.
        </span>
      </div>
      {!s.mf_available ? (
        <Banner tone="info" testId="mf-missing-note">
          {MF_MISSING_COPY}
        </Banner>
      ) : null}
      <ChartFrame
        title="Ownership by quarter"
        testId="chart-ownership-stack"
        dataset={stackedDataset(s)}
        state={stale ? "stale" : "ready"}
        message="No holding figures entered."
        height={280}
        filename="ownership-by-quarter"
        info={
          <p>
            Stacked share of each holder group at quarter end. Insurance is not stacked; it is in
            the tables. A group the owner did not enter is a gap, not zero.
          </p>
        }
      />
      <ChartFrame
        title="Promoter pledge"
        testId="chart-ownership-pledge"
        dataset={pledgeDataset(s)}
        state="ready"
        message="Pledge was not entered for any quarter. An unknown pledge is not shown as 0."
        height={220}
        filename="promoter-pledge"
      />
      {pledged ? null : (
        <p className="text-caption text-text-2" data-testid="pledge-unknown">
          Pledge unknown: no quarter has a pledged figure.
        </p>
      )}
      {qoq ? (
        <ChartFrame
          title="Change vs previous quarter"
          testId="chart-ownership-qoq"
          dataset={qoq}
          state="ready"
          height={240}
          filename="ownership-qoq"
          info={<p>Latest quarter minus the quarter before it, in percentage points.</p>}
        />
      ) : (
        <p className="text-body-sm text-text-2" data-testid="qoq-reason">
          No quarter-over-quarter change: {qoqWhy}.
        </p>
      )}
      <SmallMultiples s={s} />
      <QuarterTable s={s} />
      <p className="text-caption text-text-2">
        Figures are entered by you; verify against the exchange filing.
      </p>
    </div>
  );
}

export function OwnershipTab({ symbol }: { symbol: string }) {
  const q = useQuery({
    queryKey: shareholdingKey(symbol),
    queryFn: () => getShareholding(symbol),
    staleTime: STALE_TIME.shareholding,
  });
  const load = toLoad<ShareholdingData>(q);
  const addQuarter = (
    <Link href="/imports" data-testid="ownership-add-quarter" className={linkClass}>
      Add a quarter: manual form or CSV import
    </Link>
  );
  if (load.state === "loading") {
    return (
      <div data-testid="ownership-loading" aria-busy="true" className="flex flex-col gap-3">
        <Skeleton className="h-6 w-1/3" label="Loading ownership" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (load.state === "error") {
    return (
      <Card
        title="Ownership"
        testId="ownership-error"
        state="error"
        message={`${load.message}${load.requestId ? ` (request ${load.requestId})` : ""}`}
        onRetry={load.retry}
      />
    );
  }
  if (load.state === "unavailable") {
    return (
      <Card title="Ownership" testId="ownership-unavailable" state="empty" message={load.reason} />
    );
  }
  const s = load.data;
  if (s.quarters.length === 0) {
    return (
      <Card title="Ownership" testId="ownership-empty">
        <EmptyState
          message={`${s.entry_hint ?? "Add shareholding via Import or the manual form"}. No shareholding has been entered for this stock.`}
          action={addQuarter}
        />
      </Card>
    );
  }
  return (
    <Card title="Ownership" testId="ownership-card" actions={addQuarter}>
      <Body s={s} stale={load.stale} />
    </Card>
  );
}
