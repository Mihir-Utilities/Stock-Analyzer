"use client";

import { Card } from "@/components/ui/Card";
import { DefinitionTip } from "@/components/ui/DefinitionTip";
import { formatCount, formatDate, formatInr } from "@/lib/format";
import { indicatorReads, levelsOf } from "@/lib/stock/chart-model";
import type { Load } from "@/lib/stock/load";
import type { IndicatorsData } from "@/lib/stock/schemas";

const SOURCE = "Imported prices (adjusted, price return excludes dividends)";

/** Indicator summary table with plain-language reads (docs/06 section 6.4). */
export function IndicatorSummary({ indicatorsLoad }: { indicatorsLoad: Load<IndicatorsData> }) {
  if (indicatorsLoad.state !== "ready") {
    return (
      <Card
        title="Indicator summary"
        testId="indicator-summary"
        source={SOURCE}
        state={
          indicatorsLoad.state === "loading"
            ? "loading"
            : indicatorsLoad.state === "error"
              ? "error"
              : "empty"
        }
        message={
          indicatorsLoad.state === "error"
            ? indicatorsLoad.message
            : indicatorsLoad.state === "unavailable"
              ? `No indicators yet: ${indicatorsLoad.reason}.`
              : undefined
        }
        {...(indicatorsLoad.state === "error" ? { onRetry: indicatorsLoad.retry } : {})}
      />
    );
  }
  const ind = indicatorsLoad.data;
  const rows = indicatorReads(ind);
  const { support, resistance } = levelsOf(ind);
  return (
    <Card
      title="Indicator summary"
      testId="indicator-summary"
      state={indicatorsLoad.stale ? "stale" : "ready"}
      source={ind.source ?? SOURCE}
      asOf={ind.as_of}
    >
      <p className="mb-2 text-caption text-text-2" data-testid="indicator-basis">
        Last close {typeof ind.last_close === "number" ? formatInr(ind.last_close).text : "unknown"}{" "}
        as of {formatDate(ind.as_of).text}. Reads describe today&apos;s numbers; they are not advice
        and no overbought or oversold threshold is applied.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[34rem] border-separate border-spacing-0 text-body-sm">
          <caption className="sr-only">Indicator values with plain-language reads</caption>
          <thead>
            <tr>
              {["Indicator", "Value", "Plain-language read"].map((h) => (
                <th
                  key={h}
                  scope="col"
                  className="border-b border-border px-2 py-1 text-left font-medium text-text-1"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} data-testid={`read-${r.id}`}>
                <th
                  scope="row"
                  className="border-b border-border px-2 py-1 text-left font-medium text-text-1"
                >
                  <span className="inline-flex items-center gap-1">
                    {r.label}
                    <DefinitionTip term={r.definition} />
                  </span>
                </th>
                <td
                  className={
                    r.unknown
                      ? "num border-b border-border px-2 py-1 text-text-2"
                      : "num border-b border-border px-2 py-1 text-text-1"
                  }
                  data-testid={`read-${r.id}-value`}
                >
                  {r.value}
                </td>
                <td className="border-b border-border px-2 py-1 text-text-1">{r.read}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex flex-col gap-1" data-testid="levels-list">
        <h4 className="inline-flex items-center gap-1 text-body-sm font-medium text-text-1">
          Support and resistance
          <DefinitionTip term="support_resistance" />
        </h4>
        {support.length + resistance.length === 0 ? (
          <p className="text-caption text-text-2" data-testid="levels-empty">
            No support or resistance levels were found in the last 250 bars.
          </p>
        ) : (
          <ul className="text-body-sm text-text-1">
            {resistance.map((l) => (
              <li key={`r${l.price}`}>
                Resistance {formatInr(l.price).text}, {formatCount(l.touches).text} touches
              </li>
            ))}
            {support.map((l) => (
              <li key={`s${l.price}`}>
                Support {formatInr(l.price).text}, {formatCount(l.touches).text} touches
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
