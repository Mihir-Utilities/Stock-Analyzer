"use client";

import { Download, Table2 } from "lucide-react";
import { useMemo, useState } from "react";
import { ChartFrame } from "@/components/charts/ChartFrame";
import type { ChartDataset } from "@/components/charts/chart-data";
import { Card } from "@/components/ui/Card";
import { downloadCsv, toCsv } from "@/components/ui/csv";
import { DefinitionTip } from "@/components/ui/DefinitionTip";
import { EmptyState } from "@/components/ui/EmptyState";
import { Heatmap } from "@/components/ui/Heatmap";
import { Skeleton } from "@/components/ui/Skeleton";
import { formatDate, formatPercent } from "@/lib/format";
import {
  calendarModel,
  drawdownDataset,
  histogramDataset,
  monthYearModel,
  parseAnalysis,
  rollingBetaDataset,
  rollingVolDataset,
  type HeatModel,
} from "@/lib/stock/chart-model";
import { humanReason } from "@/lib/stock/derive";
import type { Load } from "@/lib/stock/load";
import type { IndicatorsData } from "@/lib/stock/schemas";

const SRC = "Imported prices (adjusted, price return excludes dividends)";
const small =
  "inline-flex h-9 touch-target items-center justify-center gap-1 rounded-control border border-border px-2 text-body-sm text-text-1 hover:bg-surface-3 aria-pressed:border-accent";

function emptyDataset(): ChartDataset {
  return { xName: "Date", x: [], series: [], source: SRC, asOf: null };
}

type Slot = { dataset: ChartDataset; reason: string | null };

function ChartSlot({
  title,
  testId,
  load,
  slot,
  info,
  filename,
  extra,
}: {
  title: string;
  testId: string;
  load: Load<IndicatorsData>;
  slot: Slot | null;
  info: React.ReactNode;
  filename: string;
  extra?: React.ReactNode;
}) {
  if (load.state !== "ready" || !slot) {
    const state = load.state === "loading" ? "loading" : load.state === "error" ? "error" : "empty";
    return (
      <ChartFrame
        title={title}
        testId={testId}
        dataset={emptyDataset()}
        state={state}
        message={
          load.state === "error"
            ? load.message
            : load.state === "unavailable"
              ? `Not available: ${load.reason}.`
              : "Not available."
        }
        {...(load.state === "error" ? { onRetry: load.retry } : {})}
        info={info}
        height={260}
      />
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <ChartFrame
        title={title}
        testId={testId}
        dataset={slot.dataset}
        state={load.stale ? "stale" : "ready"}
        message={slot.reason ?? "Not available."}
        info={info}
        height={260}
        filename={filename}
      />
      {extra}
    </div>
  );
}

function HeatmapCard({
  title,
  testId,
  load,
  model,
  reason,
  info,
  legend,
  nullReason,
  filename,
  rowHeader,
}: {
  title: string;
  testId: string;
  load: Load<IndicatorsData>;
  model: HeatModel | null;
  reason: string | null;
  info: React.ReactNode;
  legend: { negative: string; positive: string };
  nullReason: string;
  filename: string;
  rowHeader: string;
}) {
  const [showData, setShowData] = useState(false);
  if (load.state === "loading") {
    return (
      <Card title={title} testId={testId} state="loading" source={SRC} info={info}>
        <Skeleton className="h-40 w-full" />
      </Card>
    );
  }
  if (load.state === "error") {
    return (
      <Card
        title={title}
        testId={testId}
        state="error"
        message={load.message}
        onRetry={load.retry}
        source={SRC}
        info={info}
      />
    );
  }
  if (load.state === "unavailable" || !model || model.rows.length === 0) {
    return (
      <Card
        title={title}
        testId={testId}
        state="empty"
        message={
          load.state === "unavailable"
            ? `Not available: ${load.reason}.`
            : (reason ?? "Not enough history for this view.")
        }
        source={SRC}
        info={info}
      />
    );
  }
  const long = model.rows.flatMap((r, ri) =>
    model.columns.map((c, ci) => {
      const cell = model.cells[ri]?.[ci];
      return { row: r, col: c, value: cell?.value ?? null, text: cell?.text ?? nullReason };
    }),
  );
  const exportCsv = () =>
    downloadCsv(
      toCsv(
        [rowHeader, "Column", "Return (%)"],
        long.map((l) => [l.row, l.col, l.value]),
      ),
      `${filename}.csv`,
    );
  return (
    <Card
      title={title}
      testId={testId}
      state={load.stale ? "stale" : "ready"}
      source={SRC}
      asOf={load.asOf}
      info={info}
      actions={
        <div className="flex gap-2">
          <button
            type="button"
            data-testid="heat-show-data"
            aria-pressed={showData}
            onClick={() => setShowData((v) => !v)}
            className={small}
          >
            <Table2 size={16} strokeWidth={1.75} aria-hidden="true" />
            {showData ? "Show chart" : "Show data"}
          </button>
          <button type="button" data-testid="heat-export-csv" onClick={exportCsv} className={small}>
            <Download size={16} strokeWidth={1.75} aria-hidden="true" />
            CSV
          </button>
        </div>
      }
    >
      {showData ? (
        <div
          data-testid="heat-data-table"
          tabIndex={0}
          role="region"
          aria-label={`${title} data`}
          className="max-h-96 overflow-auto rounded-control border border-border"
        >
          <table className="w-full border-separate border-spacing-0 text-body-sm">
            <caption className="sr-only">{`${title}: ${long.length} values`}</caption>
            <thead>
              <tr>
                {[rowHeader, "Column", "Return"].map((h) => (
                  <th
                    key={h}
                    scope="col"
                    className="sticky top-0 border-b border-border bg-surface-2 px-2 py-1 text-left font-medium text-text-1"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {long.map((l, i) => (
                <tr key={i} data-testid="heat-data-row">
                  <td className="border-b border-border px-2 py-1 text-text-1">{l.row}</td>
                  <td className="border-b border-border px-2 py-1 text-text-1">{l.col}</td>
                  <td className="num border-b border-border px-2 py-1 text-right text-text-1">
                    {l.text}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Heatmap
          label={title}
          rows={model.rows}
          columns={model.columns}
          cells={model.cells}
          maxAbs={model.maxAbs}
          legend={legend}
          nullReason={nullReason}
        />
      )}
    </Card>
  );
}

/** Analysis sub-tab (docs/06 section 6.4): every chart has Show data and CSV (UI-10). */
export function AnalysisTab({ indicatorsLoad }: { indicatorsLoad: Load<IndicatorsData> }) {
  const ind = indicatorsLoad.state === "ready" ? indicatorsLoad.data : null;
  const parsed = useMemo(() => parseAnalysis(ind?.analysis), [ind]);
  const asOf = ind?.as_of ?? null;
  const a = parsed.ok ? parsed.value : null;
  const why = (key: string, fallback: string) =>
    ind?.null_reasons?.[key] ? humanReason(ind.null_reasons[key]) : fallback;
  const missing = parsed.ok ? "this series is not in the stored analysis" : parsed.reason;

  const drawdown = useMemo<Slot | null>(
    () =>
      a?.drawdown
        ? { dataset: drawdownDataset(a.drawdown, asOf), reason: null }
        : { dataset: emptyDataset(), reason: `No drawdown series: ${missing}.` },
    [a, asOf, missing],
  );
  const vol = useMemo<Slot | null>(
    () =>
      a?.rolling_vol_21 || a?.rolling_vol_63
        ? { dataset: rollingVolDataset(a.rolling_vol_21, a.rolling_vol_63, asOf), reason: null }
        : { dataset: emptyDataset(), reason: `No rolling volatility: ${missing}.` },
    [a, asOf, missing],
  );
  const beta = useMemo<Slot | null>(
    () =>
      a?.rolling_beta_252
        ? {
            dataset: rollingBetaDataset(a.rolling_beta_252, asOf),
            reason: `Rolling beta is not available: ${why("beta_252", "needs a Nifty 50 series with enough overlapping days")}.`,
          }
        : { dataset: emptyDataset(), reason: `No rolling beta: ${missing}.` },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [a, asOf, missing, ind],
  );
  const hist = useMemo(
    () => (a?.return_histogram ? histogramDataset(a.return_histogram, asOf) : null),
    [a, asOf],
  );
  const histSlot: Slot = hist
    ? { dataset: hist.dataset, reason: null }
    : {
        dataset: emptyDataset(),
        reason: parsed.ok
          ? "Not enough daily returns for a histogram (needs at least 20)."
          : `No histogram: ${parsed.reason}.`,
      };
  const monthYear = useMemo(() => (a?.month_year ? monthYearModel(a.month_year) : null), [a]);
  const calendar = useMemo(
    () => (a?.calendar && a.calendar.dates.length > 0 ? calendarModel(a.calendar) : null),
    [a],
  );

  if (indicatorsLoad.state === "unavailable") {
    return (
      <div data-testid="analysis-tab">
        <EmptyState message={`The analysis views need price history: ${indicatorsLoad.reason}.`} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="analysis-tab">
      <p className="text-caption text-text-2" data-testid="analysis-basis">
        All views use adjusted closes (price return, excludes dividends) over the stored window: the
        last 750 trading days for the line charts, the last year for the calendar.
      </p>
      <ChartSlot
        title="Drawdown from the running peak"
        testId="chart-drawdown"
        load={indicatorsLoad}
        slot={drawdown}
        info={<DefinitionTip term="max_drawdown" />}
        filename="drawdown"
      />
      <ChartSlot
        title="Rolling volatility"
        testId="chart-rolling-vol"
        load={indicatorsLoad}
        slot={vol}
        info={<DefinitionTip term="volatility" />}
        filename="rolling-volatility"
      />
      <ChartSlot
        title="Daily return distribution"
        testId="chart-histogram"
        load={indicatorsLoad}
        slot={histSlot}
        info={<DefinitionTip term="ret_n" />}
        filename="return-histogram"
        extra={
          hist && hist.mean !== null && hist.sd !== null ? (
            <p className="text-caption text-text-2" data-testid="histogram-note">
              The dashed curve is a normal distribution with mean{" "}
              {formatPercent(hist.mean, { decimals: 3 }).text} and standard deviation{" "}
              {formatPercent(hist.sd, { decimals: 3 }).text}, estimated from the binned counts (bin
              midpoints), so it is approximate.
            </p>
          ) : null
        }
      />
      <HeatmapCard
        title="Monthly returns by year"
        testId="heatmap-month-year"
        load={indicatorsLoad}
        model={monthYear}
        reason={parsed.ok ? "Not enough history for monthly returns." : parsed.reason}
        info={<DefinitionTip term="display_returns" />}
        legend={{
          negative: monthYear ? formatPercent(-monthYear.maxAbs, { decimals: 1 }).text : "",
          positive: monthYear
            ? formatPercent(monthYear.maxAbs, { decimals: 1, signed: true }).text
            : "",
        }}
        nullReason="No month-end close for this month"
        filename="monthly-returns"
        rowHeader="Year"
      />
      <HeatmapCard
        title="Daily returns calendar, last year"
        testId="heatmap-calendar"
        load={indicatorsLoad}
        model={calendar}
        reason={parsed.ok ? "Not enough history for a daily calendar." : parsed.reason}
        info={<DefinitionTip term="ret_n" />}
        legend={{
          negative: calendar ? formatPercent(-calendar.maxAbs, { decimals: 1 }).text : "",
          positive: calendar
            ? formatPercent(calendar.maxAbs, { decimals: 1, signed: true }).text
            : "",
        }}
        nullReason="No trading bar on this date"
        filename="daily-returns-calendar"
        rowHeader="Month"
      />
      <ChartSlot
        title="Rolling beta (252 days)"
        testId="chart-rolling-beta"
        load={indicatorsLoad}
        slot={beta}
        info={<DefinitionTip term="beta" />}
        filename="rolling-beta"
      />
      {asOf ? (
        <p className="text-micro text-text-2" data-testid="analysis-as-of">
          Computed as of {formatDate(asOf).text}.
        </p>
      ) : null}
    </div>
  );
}
