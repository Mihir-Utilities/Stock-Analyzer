"use client";

import { Download, FileImage, Maximize2, Minimize2, Table2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Banner } from "@/components/ui/banners";
import { AsOfChip, SourceChip } from "@/components/ui/chips";
import { cx, type ViewState } from "@/components/ui/cx";
import { downloadCsv, toCsv } from "@/components/ui/csv";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { useTheme } from "@/lib/theme/use-theme";
import {
  buildOption,
  csvModel,
  isKnown,
  seriesColor,
  seriesSymbol,
  tableModel,
  unitsOf,
  type ChartDataset,
  type ChartSeries,
} from "./chart-data";
import { EChart, type EChartHandle } from "./EChart";
import { downloadPng } from "./export-png";

export interface RangeChips {
  options: ReadonlyArray<string>;
  value: string;
  onChange: (value: string) => void;
}

export interface ChartFrameProps {
  title: string;
  dataset: ChartDataset;
  state?: ViewState;
  /** Empty / error / partial wording. */
  message?: string;
  onRetry?: () => void;
  ranges?: RangeChips;
  info?: ReactNode;
  height?: number;
  /** File stem for exports. */
  filename?: string;
  testId?: string;
}

const SYMBOL_PATH: Record<string, string> = {
  circle: "M6 1a5 5 0 1 0 0 10A5 5 0 0 0 6 1z",
  emptyCircle: "M6 2a4 4 0 1 0 0 8A4 4 0 0 0 6 2z",
  rect: "M1 1h10v10H1z",
  roundRect: "M3 1h6a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2z",
  triangle: "M6 1l5 10H1z",
  diamond: "M6 0l6 6-6 6-6-6z",
  pin: "M6 0a4 4 0 0 1 4 4c0 3-4 8-4 8S2 7 2 4a4 4 0 0 1 4-4z",
  arrow: "M6 0l6 8H8v4H4V8H0z",
};

function LegendGlyph({
  symbol,
  color,
  dashed,
}: {
  symbol: string;
  color: string;
  dashed: boolean;
}) {
  return (
    <svg width="22" height="12" viewBox="0 0 22 12" aria-hidden="true">
      <line
        x1="0"
        y1="6"
        x2="22"
        y2="6"
        stroke={color}
        strokeWidth="2"
        strokeDasharray={dashed ? "4 3" : undefined}
      />
      <g transform="translate(5 0)">
        <path
          d={SYMBOL_PATH[symbol] ?? SYMBOL_PATH["circle"]}
          fill={symbol === "emptyCircle" ? "none" : color}
          stroke={color}
          strokeWidth="1.5"
        />
      </g>
    </svg>
  );
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const q = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(q.matches);
    update();
    q.addEventListener("change", update);
    return () => q.removeEventListener("change", update);
  }, []);
  return reduced;
}

function hasAnyData(d: ChartDataset): boolean {
  return d.x.length > 0 && d.series.some((s) => s.values.some(isKnown));
}

function describe(d: ChartDataset, title: string): string {
  const units = unitsOf(d.series);
  return `${title}. ${d.series.length} series, ${d.x.length} points${units ? `, unit ${units}` : ""}. Use Show data for every value.`;
}

/**
 * Wraps every ECharts chart (docs/06a section 4): title, toggleable legend (colour plus marker
 * shape plus end label, never colour alone), range chips, Show data table (accessible alternative
 * and no-information-loss), PNG and CSV export, fullscreen, loading/empty/error/partial/stale
 * states and theme sync. Tooltip shows value, unit, date and source.
 */
export function ChartFrame({
  title,
  dataset,
  state = "ready",
  message,
  onRetry,
  ranges,
  info,
  height = 320,
  filename = "chart",
  testId = "chart-frame",
}: ChartFrameProps) {
  const { theme } = useTheme();
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [showData, setShowData] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const handle = useRef<EChartHandle | null>(null);
  const frame = useRef<HTMLElement>(null);
  const setHandle = useCallback((h: EChartHandle | null) => {
    handle.current = h;
  }, []);
  const onRenderError = useCallback((e: unknown) => {
    setRenderError(e instanceof Error ? e.message : "The chart could not be drawn.");
  }, []);

  const reducedMotion = useReducedMotion();
  const option = useMemo(
    () => buildOption(dataset, { theme, hidden, reducedMotion }),
    [dataset, theme, hidden, reducedMotion],
  );
  const table = useMemo(() => tableModel(dataset), [dataset]);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === frame.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleSeries = (id: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleFullscreen = () => {
    const el = frame.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else if (typeof el.requestFullscreen === "function") void el.requestFullscreen();
  };

  const exportCsv = () => {
    const m = csvModel(dataset);
    downloadCsv(toCsv(m.headers, m.rows), `${filename}.csv`);
  };

  const exportPng = async () => {
    setExportError(null);
    const url = handle.current?.svgDataUrl();
    if (!url) {
      setExportError("The chart is not ready to export yet.");
      return;
    }
    try {
      await downloadPng(url, `${filename}.png`);
    } catch (e) {
      setExportError(e instanceof Error ? e.message : "PNG export failed.");
    }
  };

  const effective: ViewState =
    state === "ready" || state === "partial" || state === "stale"
      ? hasAnyData(dataset)
        ? state
        : "empty"
      : state;
  const showBody = effective === "ready" || effective === "partial" || effective === "stale";
  const sampled = dataset.x.length > 1000;

  const toolbarButton =
    "inline-flex h-9 touch-target items-center justify-center gap-1 rounded-control border border-border px-2 text-body-sm text-text-1 hover:bg-surface-3 aria-pressed:border-accent";

  let body: ReactNode;
  if (effective === "loading") {
    body = <Skeleton className="w-full" label={`Loading ${title}`} />;
  } else if (effective === "empty") {
    body = <EmptyState message={message ?? "No data for this range."} />;
  } else if (effective === "error") {
    body = (
      <div className="flex flex-col items-start gap-2">
        <Banner tone="error">{message ?? "This chart could not be loaded."}</Banner>
        {onRetry ? (
          <button
            type="button"
            data-testid="chart-retry"
            onClick={onRetry}
            className={toolbarButton}
          >
            Retry
          </button>
        ) : null}
      </div>
    );
  } else if (showData) {
    body = <DataView headers={table.headers} rows={table.rows} title={title} />;
  } else {
    body = (
      <EChart
        option={option}
        theme={theme}
        height={fullscreen ? Math.max(height, 480) : height}
        label={describe(dataset, title)}
        onHandle={setHandle}
        onError={onRenderError}
      />
    );
  }

  return (
    <section
      ref={frame}
      aria-label={title}
      data-testid={testId}
      data-state={effective}
      data-theme-name={theme}
      className={cx(
        "flex flex-col gap-3 rounded-card border border-border bg-surface-1 p-4",
        fullscreen && "overflow-auto",
      )}
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <h3 className="text-lead font-semibold text-text-1">{title}</h3>
          {info}
        </div>
        {showBody || effective === "empty" ? (
          <div className="flex flex-wrap items-center gap-2">
            {ranges ? (
              <div role="group" aria-label="Range" className="flex gap-1">
                {ranges.options.map((r) => (
                  <button
                    key={r}
                    type="button"
                    data-testid={`range-${r}`}
                    aria-pressed={ranges.value === r}
                    onClick={() => ranges.onChange(r)}
                    className="h-9 touch-target rounded-chip border border-border px-2 text-caption text-text-1 hover:bg-surface-3 aria-pressed:border-accent aria-pressed:bg-accent-weak"
                  >
                    {r}
                  </button>
                ))}
              </div>
            ) : null}
            <button
              type="button"
              data-testid="chart-show-data"
              aria-pressed={showData}
              onClick={() => setShowData((v) => !v)}
              className={toolbarButton}
            >
              <Table2 size={16} strokeWidth={1.75} aria-hidden="true" />
              {showData ? "Show chart" : "Show data"}
            </button>
            <button
              type="button"
              data-testid="chart-export-png"
              onClick={() => void exportPng()}
              disabled={!showBody || showData}
              className={cx(toolbarButton, "disabled:opacity-50")}
            >
              <FileImage size={16} strokeWidth={1.75} aria-hidden="true" />
              PNG
            </button>
            <button
              type="button"
              data-testid="chart-export-csv"
              onClick={exportCsv}
              disabled={!showBody}
              className={cx(toolbarButton, "disabled:opacity-50")}
            >
              <Download size={16} strokeWidth={1.75} aria-hidden="true" />
              CSV
            </button>
            <button
              type="button"
              data-testid="chart-fullscreen"
              aria-pressed={fullscreen}
              aria-label={fullscreen ? "Exit full screen" : "Full screen"}
              onClick={toggleFullscreen}
              className={toolbarButton}
            >
              {fullscreen ? (
                <Minimize2 size={16} strokeWidth={1.75} aria-hidden="true" />
              ) : (
                <Maximize2 size={16} strokeWidth={1.75} aria-hidden="true" />
              )}
            </button>
          </div>
        ) : null}
      </header>

      {showBody && dataset.series.length > 0 ? (
        <ul data-testid="chart-legend" aria-label="Series" className="flex flex-wrap gap-2">
          {dataset.series.map((s, i) => (
            <LegendItem
              key={s.id}
              s={s}
              position={i}
              off={hidden.has(s.id)}
              theme={theme}
              onToggle={toggleSeries}
            />
          ))}
        </ul>
      ) : null}

      {effective === "partial" ? (
        <Banner tone="warn">{message ?? "Some data is missing."}</Banner>
      ) : null}
      {renderError ? <Banner tone="error">{renderError}</Banner> : null}
      {exportError ? (
        <Banner tone="error" testId="chart-export-error">
          {exportError}
        </Banner>
      ) : null}
      {body}

      {effective !== "loading" ? (
        <footer className="flex flex-wrap items-center gap-2">
          <SourceChip source={dataset.source} />
          <AsOfChip asOf={dataset.asOf} stale={effective === "stale"} />
          {dataset.downsampledFrom && dataset.downsampledFrom > dataset.x.length ? (
            <span data-testid="chart-downsampled" className="text-micro text-text-2">
              Downsampled from {dataset.downsampledFrom} points; Show data lists the plotted points.
            </span>
          ) : null}
          {sampled ? (
            <span data-testid="chart-sampled" className="text-micro text-text-2">
              Line drawing is simplified (LTTB); Show data lists every point.
            </span>
          ) : null}
          {dataset.series.some((s) => s.forecast) ? (
            <span className="text-micro text-text-2">
              Dashed or hatched = forecast (experimental).
            </span>
          ) : null}
        </footer>
      ) : null}
    </section>
  );
}

function LegendItem({
  s,
  position,
  off,
  theme,
  onToggle,
}: {
  s: ChartSeries;
  position: number;
  off: boolean;
  theme: "dark" | "light";
  onToggle: (id: string) => void;
}) {
  return (
    <li>
      <button
        type="button"
        data-testid={`legend-${s.id}`}
        aria-pressed={!off}
        onClick={() => onToggle(s.id)}
        className={cx(
          "inline-flex h-9 touch-target items-center gap-2 rounded-chip border border-border px-3 text-caption hover:bg-surface-3",
          off ? "text-text-2 line-through" : "text-text-1",
        )}
      >
        <LegendGlyph
          symbol={s.kind === "bar" ? "rect" : seriesSymbol(position)}
          color={seriesColor(s, position, theme)}
          dashed={Boolean(s.forecast)}
        />
        {s.name}
        {s.unit ? <span className="text-text-2">({s.unit})</span> : null}
      </button>
    </li>
  );
}

function DataView({
  headers,
  rows,
  title,
}: {
  headers: string[];
  rows: string[][];
  title: string;
}) {
  return (
    <div
      data-testid="chart-data-table"
      tabIndex={0}
      role="region"
      aria-label={`${title} data`}
      className="max-h-96 overflow-auto rounded-control border border-border"
    >
      <table className="w-full border-separate border-spacing-0 text-body-sm">
        <caption className="sr-only">{`${title}: ${rows.length} rows`}</caption>
        <thead>
          <tr>
            {headers.map((h) => (
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
          {rows.map((r, i) => (
            <tr key={i} data-testid="chart-data-row">
              {r.map((c, j) => (
                <td
                  key={j}
                  className={cx(
                    "border-b border-border px-2 py-1 text-text-1",
                    j > 0 && "num text-right",
                  )}
                >
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
