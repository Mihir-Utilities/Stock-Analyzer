"use client";

import Link from "next/link";
import { coverageText, formatMetric } from "@/lib/screener/display";
import { metricHeader } from "@/lib/screener/metrics";
import type { ScreenerItem } from "@/lib/screener/schemas";
import { MetricValue, StampView } from "./parts";

const th = "whitespace-nowrap px-2 py-1 text-caption font-medium text-text-2";

/**
 * Results of one screen. Order is the server's (the cursor belongs to that order), so headers do
 * not re-sort loaded rows. Every row shows its last updated stamp; stale rows say "Stale" in
 * words and carry `data-stale`.
 */
export function ResultsTable({
  items,
  metrics,
  units,
}: {
  items: ScreenerItem[];
  metrics: string[];
  units: Record<string, string>;
}) {
  return (
    <div
      className="relative overflow-x-auto"
      role="region"
      tabIndex={0}
      aria-label="Screener results, scrollable table"
      data-testid="screener-table-scroll"
    >
      <table className="w-full min-w-max border-collapse text-body-sm" data-testid="screener-table">
        <caption className="sr-only">Screener results</caption>
        <thead>
          <tr className="border-b border-border">
            <th scope="col" className={`${th} text-left`}>
              Symbol
            </th>
            <th scope="col" className={`${th} text-left`}>
              Name
            </th>
            {metrics.map((m) => (
              <th
                key={m}
                scope="col"
                className={`${th} text-right`}
                data-testid={`screener-th-${m}`}
              >
                {metricHeader(m, units)}
              </th>
            ))}
            <th scope="col" className={`${th} text-right`}>
              Coverage (percent of metrics)
            </th>
            <th scope="col" className={`${th} text-left`}>
              Last updated
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => (
            <tr
              key={it.symbol}
              data-testid={`screener-row-${it.symbol}`}
              data-stale={it.stale}
              className={
                it.stale
                  ? "border-b border-border border-l-4 border-l-warn bg-surface-2 align-top"
                  : "border-b border-border align-top"
              }
            >
              <th scope="row" className="px-2 py-1 text-left font-normal">
                <Link
                  href={`/stocks/${encodeURIComponent(it.symbol)}`}
                  data-testid={`screener-link-${it.symbol}`}
                  className="touch-target inline-flex items-center font-medium text-accent underline"
                >
                  {it.symbol}
                </Link>
              </th>
              <td className="max-w-[16rem] px-2 py-1 text-text-1">{it.name}</td>
              {metrics.map((m) => (
                <td
                  key={m}
                  data-testid={`screener-cell-${it.symbol}-${m}`}
                  className="whitespace-nowrap px-2 py-1 text-right tabular-nums text-text-1"
                >
                  <MetricValue f={formatMetric(m, it.values[m], it.value_reasons?.[m], units[m])} />
                </td>
              ))}
              <td className="whitespace-nowrap px-2 py-1 text-right tabular-nums text-text-1">
                {coverageText(it.coverage)}
              </td>
              <td className="px-2 py-1">
                <StampView stamp={it} testId={`screener-stamp-${it.symbol}`} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
