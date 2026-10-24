"use client";

import { useQuery } from "@tanstack/react-query";
import { ChartFrame } from "@/components/charts/ChartFrame";
import type { ChartDataset } from "@/components/charts/chart-data";
import { Card } from "@/components/ui/Card";
import { DefinitionTip } from "@/components/ui/DefinitionTip";
import { ExternalLink } from "@/components/ui/ExternalLink";
import { Gauge, type GaugeBand } from "@/components/ui/Gauge";
import { Stat } from "@/components/ui/Stat";
import { Timeline, type TimelineItem } from "@/components/ui/Timeline";
import { getDefinition } from "@/lib/definitions";
import {
  formatCrore,
  formatDate,
  formatInr,
  formatMultiple,
  formatNumber,
  formatPercent,
} from "@/lib/format";
import { getFundamentals, getLinks, stockKeys } from "@/lib/stock/api";
import { humanReason, performanceRows, weekRange } from "@/lib/stock/derive";
import { toLoad, type Load } from "@/lib/stock/load";
import type {
  Bar,
  EventsData,
  FundamentalsKpi,
  IndicatorsData,
  Score,
  StockProfile,
} from "@/lib/stock/schemas";
import { STALE_TIME } from "@/components/shell/Providers";

const OWNER = "Owner data (manual entry or CSV import)";

// ---- Company -------------------------------------------------------------------------------

function CompanyCard({ profile }: { profile: StockProfile }) {
  const rows: Array<[string, string]> = [
    ["Name", profile.name],
    ["Symbol", profile.symbol],
    ["ISIN", profile.isin ?? "—"],
    ["Series", profile.series ?? "—"],
    ["Sector", profile.sector ?? "—"],
    ["Industry", profile.industry ?? "—"],
    ["Listed", formatDate(profile.listing_date, { reason: "not entered" }).text],
    ["Company type", profile.company_type === "financial" ? "Financial" : "General"],
    [
      "Results as of",
      formatDate(profile.freshness.fundamentals_as_of, { reason: "none entered" }).text,
    ],
    [
      "Shareholding as of",
      formatDate(profile.freshness.shareholding_as_of, { reason: "none entered" }).text,
    ],
    [
      "Forecast as of",
      formatDate(profile.freshness.predictions_as_of, { reason: "no forecast" }).text,
    ],
  ];
  return (
    <Card title="Company" testId="card-company" source="Instrument list (owner import)" asOf={null}>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-body-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="min-w-0">
            <dt className="text-caption text-text-2">{k}</dt>
            <dd className="truncate text-text-1" title={v}>
              {v}
            </dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

// ---- KPI grid ------------------------------------------------------------------------------

function kpi(
  label: string,
  term: Parameters<typeof getDefinition>[0],
  text: string | null,
  reason: string,
  asOf: string | null,
) {
  return (
    <Stat
      key={label}
      label={label}
      value={text}
      definition={getDefinition(term).text}
      nullReason={reason}
      {...(text !== null ? { source: OWNER, asOf } : {})}
    />
  );
}

export function KpiGrid({
  profile,
  indicators,
  fundamentals,
}: {
  profile: StockProfile;
  indicators: IndicatorsData | null;
  fundamentals: Load<FundamentalsKpi>;
}) {
  const range = weekRange(profile, indicators);
  const mcap = profile.quote?.market_cap_cr ?? null;
  const fin = fundamentals.state === "ready" ? fundamentals.data : null;
  const asOf = fin?.derived_as_of ? formatDate(fin.derived_as_of).text : null;
  const missing = (block: "ratios" | "valuation"): string => {
    if (fundamentals.state === "unavailable") return fundamentals.reason;
    if (fundamentals.state === "error") return "results could not be loaded";
    const r = block === "ratios" ? fin?.ratios_reason : fin?.valuation_reason;
    return humanReason(r, "no data entered");
  };
  const ratio = (k: string): number | null => {
    const v = fin?.ratios?.[k];
    return typeof v === "number" ? v : null;
  };
  const val = (k: string): number | null => {
    const v = fin?.valuation?.[k];
    return typeof v === "number" ? v : null;
  };
  const pct = (v: number | null, r: string) => formatPercent(v, { reason: r }).text;
  const state = fundamentals.state === "loading" ? "loading" : "ready";
  const ratioReason = (v: number | null) => (v === null ? missing("ratios") : "");
  const valReason = (v: number | null) => (v === null ? missing("valuation") : "");
  const roe = ratio("roe");
  const roce = ratio("roce");
  const de = ratio("debt_equity");
  const pe = val("pe_ttm");
  const pb = val("pb");
  const dy = val("div_yield");
  const hasRange = range.low !== null && range.high !== null;
  return (
    <Card
      title="Key figures"
      testId="card-kpi"
      state={state}
      source={fin ? OWNER : "Imported prices and owner data"}
      asOf={asOf}
    >
      <div className="grid grid-cols-2 gap-4 tablet:grid-cols-4" data-testid="kpi-grid">
        <Stat
          label="Market cap"
          value={mcap === null ? null : formatCrore(mcap).text}
          nullReason="not computed yet (needs shares outstanding)"
          {...(mcap !== null ? { source: profile.quote?.source ?? "quote" } : {})}
        />
        {kpi("P/E (TTM)", "pe", pe === null ? null : formatMultiple(pe).text, valReason(pe), asOf)}
        {kpi("P/B", "pb", pb === null ? null : formatMultiple(pb).text, valReason(pb), asOf)}
        {kpi("ROE", "roe", roe === null ? null : pct(roe, ""), ratioReason(roe), asOf)}
        {kpi("ROCE", "roce", roce === null ? null : pct(roce, ""), ratioReason(roce), asOf)}
        {kpi(
          "Debt / equity",
          "debt_equity",
          de === null ? null : formatMultiple(de).text,
          profile.company_type === "financial"
            ? "not used for financial companies"
            : ratioReason(de),
          asOf,
        )}
        {kpi("Dividend yield", "div_yield", dy === null ? null : pct(dy, ""), valReason(dy), asOf)}
        <Stat
          label="52-week range"
          value={hasRange ? `${formatInr(range.low).text} to ${formatInr(range.high).text}` : null}
          definition={getDefinition("wk52").text}
          nullReason="insufficient history (needs 252 trading days)"
          {...(hasRange ? { source: range.source } : {})}
        />
      </div>
    </Card>
  );
}

// ---- Gauges --------------------------------------------------------------------------------

const TREND_BANDS: GaugeBand[] = [
  { from: 0, to: 20, label: "Strong down", tone: "down" },
  { from: 21, to: 40, label: "Down", tone: "warn" },
  { from: 41, to: 60, label: "Sideways", tone: "info" },
  { from: 61, to: 80, label: "Up", tone: "up" },
  { from: 81, to: 100, label: "Strong up", tone: "up" },
];
const RISK_BANDS: GaugeBand[] = [
  { from: 0, to: 33, label: "Low", tone: "up" },
  { from: 33, to: 66, label: "Medium", tone: "warn" },
  { from: 66, to: 100, label: "High", tone: "down" },
];
const QUALITY_BANDS: GaugeBand[] = [{ from: 0, to: 100, label: "Score", tone: "info" }];

function scoreOf(s: Score | null | undefined): { value: number | null; reason: string } {
  const v = s?.score;
  if (typeof v === "number" && Number.isFinite(v)) return { value: v, reason: "" };
  return { value: null, reason: humanReason(s?.reason ?? "not_computed") };
}

export function GaugesCard({
  profile,
  indicators,
}: {
  profile: StockProfile;
  indicators: Load<IndicatorsData>;
}) {
  if (indicators.state !== "ready") {
    return (
      <Card
        title="Scores"
        testId="card-gauges"
        state={
          indicators.state === "loading"
            ? "loading"
            : indicators.state === "error"
              ? "error"
              : "empty"
        }
        message={
          indicators.state === "unavailable"
            ? `Scores unavailable: ${indicators.reason}.`
            : indicators.state === "error"
              ? indicators.message
              : undefined
        }
        onRetry={indicators.state === "error" ? indicators.retry : undefined}
      />
    );
  }
  const sc = indicators.data.scores;
  const trend = scoreOf(sc?.trend);
  const risk = scoreOf(sc?.risk);
  const quality = scoreOf(sc?.quality);
  const financial = profile.company_type === "financial";
  return (
    <Card
      title="Scores"
      testId="card-gauges"
      source="Computed from your imported prices and owner data"
      asOf={formatDate(indicators.data.as_of).text}
      state={indicators.stale ? "stale" : "ready"}
    >
      <div className="grid grid-cols-1 gap-4 tablet:grid-cols-3">
        <div className="flex flex-col items-center gap-1" data-testid="gauge-trend">
          <Gauge
            label="Trend"
            value={trend.value}
            valueText={formatNumber(trend.value, { decimals: 0 }).text}
            bands={TREND_BANDS}
            nullReason={trend.reason}
          />
          <DefinitionTip term="trend_score" />
        </div>
        <div className="flex flex-col items-center gap-1" data-testid="gauge-risk">
          <Gauge
            label="Risk (relative to stocks tracked here)"
            value={risk.value}
            valueText={formatNumber(risk.value, { decimals: 0 }).text}
            bands={RISK_BANDS}
            nullReason={risk.reason}
          />
          <DefinitionTip term="risk_score" />
        </div>
        {financial ? (
          <p data-testid="quality-hidden" className="self-center text-body-sm text-text-2">
            Quality score is not shown for financial companies.
          </p>
        ) : (
          <div className="flex flex-col items-center gap-1" data-testid="gauge-quality">
            <Gauge
              label="Quality"
              value={quality.value}
              valueText={formatNumber(quality.value, { decimals: 0 }).text}
              bands={QUALITY_BANDS}
              nullReason={quality.reason}
            />
            <p className="text-micro text-text-2">
              Quality components and their radar appear once the score is computed.
            </p>
          </div>
        )}
      </div>
    </Card>
  );
}

// ---- Charts --------------------------------------------------------------------------------

export function MiniPriceChart({
  bars,
  load,
}: {
  bars: ReadonlyArray<Bar> | null;
  load: Load<unknown>;
}) {
  if (load.state !== "ready" || !bars || bars.length === 0) {
    return (
      <ChartFrame
        title="Price, 1 year"
        testId="chart-mini-price"
        dataset={{ xName: "Date", x: [], series: [], source: "Imported prices", asOf: null }}
        state={load.state === "loading" ? "loading" : load.state === "error" ? "error" : "empty"}
        message={
          load.state === "unavailable"
            ? `No price history: ${load.reason}.`
            : load.state === "error"
              ? load.message
              : "No price history to chart."
        }
        {...(load.state === "error" ? { onRetry: load.retry } : {})}
        height={220}
      />
    );
  }
  const last = bars[bars.length - 1];
  const dataset: ChartDataset = {
    xName: "Date",
    x: bars.map((b) => formatDate(b[0]).text),
    series: [
      {
        id: "close",
        name: "Close",
        unit: "INR",
        kind: "area",
        values: bars.map((b) => b[4]),
        format: (v) => formatInr(v).text,
      },
    ],
    source: "Imported prices (adjusted, excludes dividends)",
    asOf: last ? formatDate(last[0]).text : null,
  };
  return (
    <ChartFrame
      title="Price, 1 year"
      testId="chart-mini-price"
      dataset={dataset}
      state={load.stale ? "stale" : "ready"}
      height={220}
      filename="price-1y"
    />
  );
}

export function PerformanceCard({ indicators }: { indicators: Load<IndicatorsData> }) {
  if (indicators.state !== "ready") {
    return (
      <ChartFrame
        title="Performance"
        testId="chart-performance"
        dataset={{ xName: "Period", x: [], series: [], source: "Imported prices", asOf: null }}
        state={
          indicators.state === "loading"
            ? "loading"
            : indicators.state === "error"
              ? "error"
              : "empty"
        }
        message={
          indicators.state === "unavailable"
            ? `Returns unavailable: ${indicators.reason}.`
            : indicators.state === "error"
              ? indicators.message
              : "No returns yet."
        }
        {...(indicators.state === "error" ? { onRetry: indicators.retry } : {})}
        height={220}
      />
    );
  }
  const rows = performanceRows(indicators.data);
  const missing = rows.filter((r) => r.value === null);
  const dataset: ChartDataset = {
    xName: "Period",
    x: rows.map((r) => r.label),
    series: [
      {
        id: "ret",
        name: "Price return",
        unit: "%",
        kind: "bar",
        values: rows.map((r) => r.value),
        nullReason: "insufficient history",
        format: (v) => formatPercent(v, { signed: true }).text,
      },
    ],
    source: "Imported prices (price return, excludes dividends)",
    asOf: formatDate(indicators.data.as_of).text,
  };
  return (
    <div className="flex flex-col gap-2" data-testid="performance">
      <ChartFrame
        title="Performance"
        testId="chart-performance"
        dataset={dataset}
        state={rows.every((r) => r.value === null) ? "empty" : "ready"}
        message="No return can be computed yet: insufficient history."
        height={220}
        filename="performance"
        info={<DefinitionTip term="display_returns" />}
      />
      <p data-testid="performance-basis" className="text-micro text-text-2">
        Basis: {indicators.data.price_basis ?? "price return"}
        {indicators.data.bars !== undefined
          ? ` | ${formatNumber(indicators.data.bars, { decimals: 0 }).text} bars`
          : ""}
        {` | Last close ${formatInr(indicators.data.last_close ?? null, { reason: "unknown" }).text}`}
        {indicators.data.source ? ` | Source: ${indicators.data.source}` : ""}
      </p>
      {missing.length > 0 ? (
        <ul data-testid="performance-missing" className="text-caption text-text-2">
          {missing.map((r) => (
            <li key={r.id}>
              {r.label}: {"—"} {r.reason}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ---- Events --------------------------------------------------------------------------------

const ACTION_KIND: Record<string, string> = {
  split: "Split",
  bonus: "Bonus",
  split_or_bonus: "Split or bonus",
  dividend: "Dividend",
  rights: "Rights",
  buyback: "Buyback",
  merger: "Merger",
  demerger: "Demerger",
};

export function actionItems(d: EventsData): TimelineItem[] {
  return d.actions.map((a) => {
    const kind = ACTION_KIND[a.type] ?? a.type.replace(/_/g, " ");
    const status =
      a.status === "confirmed"
        ? "confirmed"
        : a.status === "detected"
          ? "detected, not confirmed"
          : a.status;
    const ratio =
      a.ratio_num !== null &&
      a.ratio_num !== undefined &&
      a.ratio_den !== null &&
      a.ratio_den !== undefined
        ? `${formatNumber(a.ratio_num, { decimals: 0 }).text}:${formatNumber(a.ratio_den, { decimals: 0 }).text}`
        : null;
    const amount =
      a.amount_per_share !== null && a.amount_per_share !== undefined
        ? `${formatInr(a.amount_per_share).text} per share`
        : null;
    return {
      id: `a${a.id}`,
      date: formatDate(a.ex_date).text,
      kind: `${kind} (${status})`,
      title: [ratio, amount].filter(Boolean).join(", ") || a.purpose_text || kind,
      ...(a.purpose_text ? { detail: a.purpose_text } : {}),
    };
  });
}

export function eventItems(d: EventsData): TimelineItem[] {
  return d.calendar.map((c, i) => ({
    id: `c${i}`,
    date: formatDate(c.event_date).text,
    kind: c.type.replace(/_/g, " "),
    title: c.details ?? c.type.replace(/_/g, " "),
  }));
}

export function EventsCard({ load }: { load: Load<EventsData> }) {
  if (load.state !== "ready") {
    return (
      <Card
        title="Upcoming events and corporate actions"
        testId="card-events"
        state={load.state === "loading" ? "loading" : load.state === "error" ? "error" : "empty"}
        message={load.state === "error" ? load.message : "Events are unavailable for this stock."}
        {...(load.state === "error" ? { onRetry: load.retry } : {})}
      />
    );
  }
  const d = load.data;
  const empty = d.actions.length === 0 && d.calendar.length === 0;
  return (
    <Card
      title="Upcoming events and corporate actions"
      testId="card-events"
      state={empty ? "empty" : "ready"}
      message={
        d.entry_hint ?? "No events or corporate actions entered. Add them on the Events tab."
      }
      source="Owner data (manual entry or CSV import)"
      asOf={null}
    >
      <div className="flex flex-col gap-4">
        <div>
          <h4 className="mb-2 text-body-sm font-medium text-text-1">
            Upcoming events (next 90 days)
          </h4>
          <Timeline items={eventItems(d)} emptyMessage="No upcoming events entered." />
        </div>
        <div>
          <h4 className="mb-2 text-body-sm font-medium text-text-1">Corporate actions</h4>
          <Timeline items={actionItems(d)} emptyMessage="No corporate actions recorded." />
        </div>
      </div>
    </Card>
  );
}

/** Research links must be https; anything else from the config is dropped, not rendered. */
function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

// ---- Research links ------------------------------------------------------------------------

export function LinksCard({ symbol }: { symbol: string }) {
  const q = useQuery({
    queryKey: stockKeys.links(symbol),
    queryFn: () => getLinks(symbol),
    staleTime: STALE_TIME.analysis,
  });
  const load = toLoad(q);
  if (load.state !== "ready") {
    return (
      <Card
        title="Research links"
        testId="card-links"
        state={load.state === "loading" ? "loading" : load.state === "error" ? "error" : "empty"}
        message={load.state === "error" ? load.message : "No research links configured."}
        {...(load.state === "error" ? { onRetry: load.retry } : {})}
      />
    );
  }
  const links = "links" in load.data ? load.data.links.filter((l) => isHttps(l.url)) : [];
  return (
    <Card
      title="Research links"
      testId="card-links"
      state={links.length === 0 ? "empty" : "ready"}
      message="No research links configured."
      source="config/research_links.json"
      asOf={null}
    >
      <ul className="flex flex-col gap-1">
        {links.map((l) => (
          <li key={l.url}>
            <ExternalLink
              href={l.url}
              data-testid="research-link"
              className="touch-target inline-flex items-center text-body-sm text-accent underline"
            >
              {l.label}
            </ExternalLink>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-micro text-text-2">
        Opens another site in a new tab. This app never loads these pages itself.
      </p>
    </Card>
  );
}

// ---- Overview ------------------------------------------------------------------------------

export function OverviewTab({
  profile,
  bars,
  pricesLoad,
  indicatorsLoad,
  eventsLoad,
}: {
  profile: StockProfile;
  bars: ReadonlyArray<Bar> | null;
  pricesLoad: Load<unknown>;
  indicatorsLoad: Load<IndicatorsData>;
  eventsLoad: Load<EventsData>;
}) {
  const symbol = profile.symbol;
  const fq = useQuery({
    queryKey: stockKeys.fundamentals(symbol),
    queryFn: () => getFundamentals(symbol),
    staleTime: STALE_TIME.fundamentals,
  });
  const fundamentals = toLoad(fq);
  const indicators = indicatorsLoad.state === "ready" ? indicatorsLoad.data : null;
  return (
    <div className="grid grid-cols-1 gap-4 desktop:grid-cols-2" data-testid="overview">
      <div className="desktop:col-span-2">
        <KpiGrid profile={profile} indicators={indicators} fundamentals={fundamentals} />
      </div>
      <div className="desktop:col-span-2">
        <GaugesCard profile={profile} indicators={indicatorsLoad} />
      </div>
      <MiniPriceChart bars={bars} load={pricesLoad} />
      <PerformanceCard indicators={indicatorsLoad} />
      <EventsCard load={eventsLoad} />
      <div className="flex flex-col gap-4">
        <CompanyCard profile={profile} />
        <LinksCard symbol={symbol} />
      </div>
    </div>
  );
}
