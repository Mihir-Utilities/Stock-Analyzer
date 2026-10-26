"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";
import { ChartFrame } from "@/components/charts/ChartFrame";
import { Banner } from "@/components/ui/banners";
import { cx } from "@/components/ui/cx";
import { DefinitionTip } from "@/components/ui/DefinitionTip";
import { inputClass } from "@/components/ui/FormField";
import { Skeleton } from "@/components/ui/Skeleton";
import { STALE_TIME } from "@/components/shell/Providers";
import { ApiError } from "@/lib/api/client";
import { formatCount, formatDate } from "@/lib/format";
import { chartPriceKey, getChartPrices } from "@/lib/stock/chart-api";
import {
  buildChartDataset,
  CHART_RANGES,
  levelsOf,
  OVERLAY_IDS,
  OVERLAY_LABELS,
  overlayAvailability,
  PANE_IDS,
  PANE_LABELS,
  parseIndicatorSeries,
  type ChartRange,
  type ChartType,
  type OverlayId,
  type PaneId,
} from "@/lib/stock/chart-model";
import type { Load } from "@/lib/stock/load";
import { isRedirect, type IndicatorsData, type StockProfile } from "@/lib/stock/schemas";
import { IndicatorSummary } from "./IndicatorSummary";

const toggle =
  "inline-flex h-9 touch-target items-center justify-center rounded-chip border border-border px-3 text-caption text-text-1 hover:bg-surface-3 aria-pressed:border-accent aria-pressed:bg-accent-weak disabled:cursor-not-allowed disabled:opacity-60";

const TYPES: ReadonlyArray<{ id: ChartType; label: string }> = [
  { id: "candle", label: "Candles" },
  { id: "line", label: "Line" },
  { id: "area", label: "Area" },
];

const SYMBOL_RE = /^[A-Z0-9&_-]{1,20}$/;

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-1">
      <span className="text-caption font-medium text-text-2">{label}</span>
      {children}
    </div>
  );
}

function flip<T>(set: ReadonlySet<T>, v: T): Set<T> {
  const next = new Set(set);
  if (next.has(v)) next.delete(v);
  else next.add(v);
  return next;
}

export function ChartTab({
  profile,
  indicatorsLoad,
  pageWarnings,
}: {
  profile: StockProfile;
  indicatorsLoad: Load<IndicatorsData>;
  /** Warnings the page banner already shows (code|message), not repeated here. */
  pageWarnings: ReadonlyArray<{ code: string; message: string }>;
}) {
  const symbol = profile.symbol;
  const [range, setRange] = useState<ChartRange>("1Y");
  const [type, setType] = useState<ChartType>("candle");
  const [adjusted, setAdjusted] = useState(true);
  const [log, setLog] = useState(false);
  const [overlays, setOverlays] = useState<ReadonlySet<OverlayId>>(new Set(["sma50", "sma200"]));
  const [panes, setPanes] = useState<ReadonlySet<PaneId>>(new Set(["volume"]));
  const [draft, setDraft] = useState("");
  const [compareSymbol, setCompareSymbol] = useState<string | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);

  const pricesQ = useQuery({
    queryKey: chartPriceKey(symbol, range, adjusted),
    queryFn: () => getChartPrices(symbol, range, adjusted),
    staleTime: STALE_TIME.prices,
  });
  const compareQ = useQuery({
    queryKey: chartPriceKey(compareSymbol ?? "", range, adjusted),
    queryFn: () => getChartPrices(compareSymbol ?? "", range, adjusted),
    staleTime: STALE_TIME.prices,
    enabled: compareSymbol !== null,
  });

  const priceData = pricesQ.data && !isRedirect(pricesQ.data.data) ? pricesQ.data.data : null;
  const compareData =
    compareQ.data && !isRedirect(compareQ.data.data) && compareSymbol
      ? { symbol: compareSymbol, bars: compareQ.data.data.bars }
      : null;
  const compareRedirect =
    compareQ.data && isRedirect(compareQ.data.data) ? compareQ.data.data.redirect_symbol : null;
  const indicators = indicatorsLoad.state === "ready" ? indicatorsLoad.data : null;
  const series = useMemo(() => parseIndicatorSeries(indicators?.series), [indicators]);
  const levels = useMemo(() => levelsOf(indicators), [indicators]);

  const built = useMemo(() => {
    if (!priceData || priceData.bars.length === 0) return null;
    return buildChartDataset({
      symbol,
      bars: priceData.bars,
      series,
      actions: priceData.actions,
      support: levels.support,
      resistance: levels.resistance,
      selection: { type, overlays, panes, log, adjusted },
      compare: compareData,
      asOf: pricesQ.data?.meta?.as_of ?? null,
    });
    // compareData is rebuilt each render from query data; its identity is the query result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    priceData,
    series,
    levels,
    type,
    overlays,
    panes,
    log,
    adjusted,
    compareQ.data,
    compareSymbol,
    symbol,
    pricesQ.data?.meta?.as_of,
  ]);

  const applyCompare = () => {
    const s = draft.trim().toUpperCase();
    if (!SYMBOL_RE.test(s)) {
      setDraftError("Enter an exchange symbol such as INFY (letters, digits, & _ -).");
      return;
    }
    if (s === symbol) {
      setDraftError("Pick a different stock to compare with.");
      return;
    }
    setDraftError(null);
    setCompareSymbol(s);
  };

  const interval = pricesQ.data?.meta?.interval;
  const warnings = (pricesQ.data?.warnings ?? []).filter(
    (w) => !pageWarnings.some((p) => p.code === w.code && p.message === w.message),
  );
  const unavailable = OVERLAY_IDS.flatMap((id) => {
    const av = overlayAvailability(id, series, adjusted);
    return av.available ? [] : [`${OVERLAY_LABELS[id]}: ${av.reason}`];
  });
  const seriesFirst = series.ok ? firstDate(series.value) : null;
  const firstBar = priceData?.bars[0]?.[0] ?? null;
  const warmupNote =
    seriesFirst !== null && firstBar !== null && seriesFirst > firstBar
      ? `Indicators cover the last 750 trading days (from ${formatDate(seriesFirst).text}); earlier bars have no overlay or pane values.`
      : null;

  let frameState: "loading" | "error" | "empty" | "ready" | "stale" = "ready";
  let message: string | undefined;
  if (pricesQ.isPending) frameState = "loading";
  else if (pricesQ.isError) {
    const e = pricesQ.error;
    if (e instanceof ApiError && e.code === "DATA_UNAVAILABLE") {
      frameState = "empty";
      message = "No price bars to chart: no prices are imported for this stock.";
    } else {
      frameState = "error";
      message = e instanceof ApiError ? e.message : "The price chart could not be loaded.";
    }
  } else if (!built) {
    frameState = "empty";
    message = "No price bars in this range.";
  } else if (pricesQ.data?.meta?.stale) frameState = "stale";

  return (
    <div className="flex flex-col gap-4" data-testid="chart-tab">
      <div className="flex flex-col gap-2" data-testid="chart-controls">
        <Group label="Chart type">
          {TYPES.map((t) => (
            <button
              key={t.id}
              type="button"
              data-testid={`chart-type-${t.id}`}
              aria-pressed={type === t.id}
              onClick={() => setType(t.id)}
              className={toggle}
            >
              {t.label}
            </button>
          ))}
        </Group>
        <Group label="Prices">
          <button
            type="button"
            data-testid="chart-adjusted"
            aria-pressed={adjusted}
            onClick={() => setAdjusted(true)}
            className={toggle}
          >
            Adjusted
          </button>
          <button
            type="button"
            data-testid="chart-raw"
            aria-pressed={!adjusted}
            onClick={() => setAdjusted(false)}
            className={toggle}
          >
            Raw
          </button>
          <button
            type="button"
            data-testid="chart-log"
            aria-pressed={log}
            onClick={() => setLog((v) => !v)}
            className={toggle}
          >
            Log scale
          </button>
        </Group>
        <Group label="Overlays">
          {OVERLAY_IDS.map((id) => {
            const av = overlayAvailability(id, series, adjusted);
            return (
              <button
                key={id}
                type="button"
                data-testid={`overlay-${id}`}
                aria-pressed={overlays.has(id)}
                disabled={!av.available && id === "ema50"}
                title={av.reason ?? undefined}
                onClick={() => setOverlays((s) => flip(s, id))}
                className={toggle}
              >
                {OVERLAY_LABELS[id]}
              </button>
            );
          })}
        </Group>
        <Group label="Panes">
          {PANE_IDS.map((id) => (
            <button
              key={id}
              type="button"
              data-testid={`pane-${id}`}
              aria-pressed={panes.has(id)}
              onClick={() => setPanes((s) => flip(s, id))}
              className={toggle}
            >
              {PANE_LABELS[id]}
            </button>
          ))}
        </Group>
        <Group label="Compare">
          <input
            type="text"
            data-testid="compare-input"
            aria-label="Compare with symbol"
            aria-invalid={draftError !== null}
            value={draft}
            maxLength={20}
            placeholder="Symbol, e.g. INFY"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") applyCompare();
            }}
            className={cx(inputClass, "w-40")}
          />
          <button
            type="button"
            data-testid="compare-apply"
            onClick={applyCompare}
            className={toggle}
          >
            Compare
          </button>
          {compareSymbol ? (
            <button
              type="button"
              data-testid="compare-clear"
              onClick={() => {
                setCompareSymbol(null);
                setDraft("");
              }}
              className={toggle}
            >
              Clear compare
            </button>
          ) : null}
        </Group>
      </div>

      {draftError ? (
        <Banner tone="error" testId="compare-error">
          {draftError}
        </Banner>
      ) : null}
      {compareSymbol && compareQ.isError ? (
        <Banner tone="error" testId="compare-load-error">
          {compareQ.error instanceof ApiError && compareQ.error.status === 404
            ? `No prices are imported for ${compareSymbol}, so it cannot be compared.`
            : `${compareSymbol} could not be loaded for comparison.`}
        </Banner>
      ) : null}
      {compareRedirect ? (
        <Banner tone="warn" testId="compare-redirect">
          {compareSymbol} is now listed as {compareRedirect}; enter the new symbol to compare.
        </Banner>
      ) : null}
      {compareSymbol && compareQ.isPending ? (
        <Skeleton className="h-6 w-1/3" label={`Loading ${compareSymbol}`} />
      ) : null}

      <p data-testid="chart-basis" className="text-caption text-text-2">
        {adjusted
          ? "Adjusted prices: confirmed splits and bonus issues only; price return, excludes dividends."
          : "Raw prices as imported; splits and bonus issues are not removed, so indicators are hidden."}{" "}
        Volume is shown as imported (not split-adjusted yet). Nifty 50 compare is not available yet:
        there is no index price series in this app, so type a stock symbol instead.
      </p>
      {priceData?.depth ? (
        <p data-testid="chart-depth" className="text-caption text-text-2">
          Price history: {formatCount(priceData.depth.bars).text} bars from{" "}
          {formatDate(priceData.depth.first_bar).text} to{" "}
          {formatDate(priceData.depth.last_bar).text}
          {priceData.limited_history ? " (limited history)" : ""}.
        </p>
      ) : null}
      {unavailable.length > 0 ? (
        <p data-testid="overlay-unavailable-note" className="text-caption text-text-2">
          Not available: {unavailable.join("; ")}.
        </p>
      ) : null}

      {interval === "1w" ? (
        <Banner tone="info" testId="weekly-candle-note">
          Long range: each candle is one week (open of the first day, close of the last). The API
          returns weekly candles above 2,000 daily bars; the table lists every plotted candle.
        </Banner>
      ) : null}
      {warnings.map((w) => (
        <Banner key={`${w.code}|${w.message}`} tone="warn" testId="chart-warning">
          {w.message}
        </Banner>
      ))}
      {built?.notes.map((n) => (
        <Banner key={n} tone="info" testId="chart-note">
          {n}
        </Banner>
      ))}
      {warmupNote && !compareData ? (
        <p data-testid="indicator-window-note" className="text-caption text-text-2">
          {warmupNote}
        </p>
      ) : null}

      <ChartFrame
        title={`${symbol} price chart`}
        testId="chart-main"
        dataset={
          built?.dataset ?? {
            xName: "Date",
            x: [],
            series: [],
            source: "Imported prices",
            asOf: null,
          }
        }
        state={frameState}
        {...(message ? { message } : {})}
        {...(pricesQ.isError ? { onRetry: () => void pricesQ.refetch() } : {})}
        ranges={{
          options: CHART_RANGES,
          value: range,
          onChange: (r) => setRange(r as ChartRange),
        }}
        info={<DefinitionTip term="support_resistance" />}
        height={built?.height ?? 340}
        filename={`${symbol}-price-${range}`}
      />
      {built && built.dataset.levels && built.dataset.levels.length > 0 ? (
        <p data-testid="levels-note" className="text-caption text-text-2">
          Dashed horizontal lines mark support and resistance levels (clusters of swing points
          within 1.5%); the touch counts are listed in the indicator summary below.
        </p>
      ) : null}

      <IndicatorSummary indicatorsLoad={indicatorsLoad} />
    </div>
  );
}

function firstDate(s: {
  sma20?: ReadonlyArray<readonly [string, number | null]> | undefined;
  rsi14?: ReadonlyArray<readonly [string, number | null]> | undefined;
}): string | null {
  return s.sma20?.[0]?.[0] ?? s.rsi14?.[0]?.[0] ?? null;
}
