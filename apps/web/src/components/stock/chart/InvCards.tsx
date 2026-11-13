"use client";

import { useState, type ReactNode } from "react";
import { Card } from "@/components/ui/Card";
import { SmallSampleChip } from "@/components/ui/chips";
import { DefinitionTip } from "@/components/ui/DefinitionTip";
import { RangeBar } from "@/components/ui/RangeBar";
import { asOfText, isOlderThanExpected } from "@/lib/dashboard/state";
import {
  formatCount,
  formatDate,
  formatInr,
  formatMultiple,
  formatNumber,
  formatPercent,
} from "@/lib/format";
import {
  CONTEXT_NOTE,
  INV_SOURCE,
  NOT_COMPUTED,
  PAST_NOTE,
  contextFacts,
  invReason,
  istMonth,
} from "@/lib/stock/inv-model";
import type {
  Block,
  DrawdownProfile,
  EntryStudy,
  HoldingPeriods,
  InvBlocks,
  Position,
  RiskAdjusted,
  SipBacktest,
  VolRegime,
} from "@/lib/stock/inv-schemas";
import type { Load } from "@/lib/stock/load";
import type { IndicatorsData } from "@/lib/stock/schemas";

// The investment-context cards of the Analysis tab (docs/06 6.4a). Past prices only: no verdict,
// no combined figure, no price goal. Every number comes from the stored blocks through lib/format; an
// unknown value is an em dash with its reason as readable text (never 0, NaN or Infinity).

type IndLoad = Load<IndicatorsData>;

// `relative` makes the region the containing block of the visually hidden reasons inside its cells,
// so a scrolled-away cell never widens the page.
export const scrollRegion = "relative overflow-x-auto rounded-control border border-border";
export const th = "px-2 py-1 text-left text-caption font-medium text-text-2";
export const td = "num border-t border-border px-2 py-1 text-right text-body-sm text-text-1";
export const selectCls =
  "h-9 touch-target rounded-control border border-border bg-surface-1 px-2 text-body-sm text-text-1";

/** An unknown value: an em dash, the reason as a tooltip and as text a screen reader (or a phone) can read. */
export function Blank({ reason }: { reason: string }) {
  return (
    <span title={reason}>
      {"—"}
      <span className="sr-only">{` (${reason})`}</span>
    </span>
  );
}

export function Cell({ text, reason }: { text: string; reason: string | null }) {
  return reason === null ? <>{text}</> : <Blank reason={reason} />;
}

function Stat({
  label,
  value,
  reason,
  testId,
}: {
  label: string;
  value: string;
  reason: string | null;
  testId?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5" data-testid={testId}>
      <dt className="text-caption text-text-2">{label}</dt>
      <dd className="num text-body text-text-1">
        <Cell text={value} reason={reason} />
        {reason !== null ? <span className="block text-micro text-text-2">{reason}</span> : null}
      </dd>
    </div>
  );
}

/** Visible list of why some cells are blank (phones have no hover). */
export function Reasons({ items, testId }: { items: string[]; testId: string }) {
  const unique = [...new Set(items)];
  if (unique.length === 0) return null;
  return (
    <ul className="list-disc pl-5 text-caption text-text-2" data-testid={testId}>
      {unique.map((r) => (
        <li key={r}>{r}</li>
      ))}
    </ul>
  );
}

interface ShellProps<T> {
  card: string;
  testId: string;
  title: string;
  term: Parameters<typeof DefinitionTip>[0]["term"];
  load: IndLoad;
  block: Block<T>;
  howTo: ReactNode;
  /** Test id of the fixed past-behaviour line (the context strip keeps `inv-context-note` for its own sentence). */
  noteTestId?: string;
  /** Renders the body; returns the sample-size sentence, the small-sample flag and the as-of. */
  render: (v: T) => {
    body: ReactNode;
    sample: string;
    small: boolean;
    asOf: string | null;
    partial?: string | null;
  };
}

/** The shared parts of every INV card: definition, source and as-of, sample size, How to read, note, states. */
export function InvCard<T>({
  card,
  testId,
  title,
  term,
  load,
  block,
  howTo,
  noteTestId,
  render,
}: ShellProps<T>) {
  const info = <DefinitionTip term={term} />;
  if (load.state === "loading") {
    return <Card title={title} testId={testId} state="loading" info={info} source={INV_SOURCE} />;
  }
  if (load.state === "error") {
    const id = load.requestId ? ` Request id: ${load.requestId}.` : "";
    return (
      <Card
        title={title}
        testId={testId}
        state="error"
        message={`${load.message}${id}`}
        onRetry={load.retry}
        info={info}
        source={INV_SOURCE}
      />
    );
  }
  if (load.state === "unavailable" || block.kind === "missing") {
    return (
      <Card
        title={title}
        testId={testId}
        state="empty"
        message={NOT_COMPUTED}
        info={info}
        source={INV_SOURCE}
      />
    );
  }
  if (block.kind === "error") {
    return (
      <Card
        title={title}
        testId={testId}
        state="error"
        message="This card's figures came back in an unexpected shape. The rest of the tab is unaffected."
        info={info}
        source={INV_SOURCE}
      />
    );
  }
  const r = render(block.value);
  const stale = isOlderThanExpected(r.asOf, new Date()) || load.stale;
  return (
    <Card
      title={title}
      testId={testId}
      state={r.partial ? "partial" : "ready"}
      message={r.partial ?? undefined}
      stale={stale}
      info={info}
      source={INV_SOURCE}
      asOf={asOfText(r.asOf)}
    >
      <div className="flex flex-col gap-3">
        {r.body}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-caption text-text-2" data-testid={`inv-${card}-sample`}>
            {r.sample}
          </span>
          {r.small ? <SmallSampleChip testId={`inv-${card}-small`} /> : null}
        </div>
        <details data-testid={`inv-${card}-howto`} className="text-body-sm text-text-1">
          <summary className="min-h-9 cursor-pointer py-1 text-text-2">How to read</summary>
          <div className="flex flex-col gap-1 pb-1 text-text-2">{howTo}</div>
        </details>
        <p className="text-caption text-text-2" data-testid={noteTestId ?? `inv-${card}-note`}>
          {PAST_NOTE}
        </p>
      </div>
    </Card>
  );
}

export const pctText = (
  v: number | null | undefined,
  o: { signed?: boolean; decimals?: number } = {},
) => formatPercent(v ?? null, { decimals: 1, ...o });

// ---- Entry context -------------------------------------------------------------------------------

export function EntryContextCard({
  load,
  blocks,
  now,
}: {
  load: IndLoad;
  blocks: InvBlocks;
  now?: Date;
}) {
  const month = istMonth(now ?? new Date());
  const any = [blocks.position, blocks.drawdown, blocks.vol, blocks.seasonality].some(
    (b) => b.kind === "ok",
  );
  const block: Block<true> = any ? { kind: "ok", value: true } : { kind: "missing" };
  return (
    <InvCard
      card="context"
      testId="inv-context"
      noteTestId="inv-context-past-note"
      title="Entry context"
      term="price_position"
      load={load}
      block={block}
      howTo={
        <>
          <p>
            Four separate facts about the past, side by side. Each keeps its own date. They are not
            added up and there is no combined reading.
          </p>
          <p>The order is fixed and carries no meaning.</p>
        </>
      }
      render={() => {
        const facts = contextFacts(blocks, month);
        return {
          body: (
            <>
              <p className="text-body-sm font-medium text-text-1" data-testid="inv-context-note">
                {CONTEXT_NOTE}
              </p>
              <ul className="grid min-w-0 gap-2 md:grid-cols-2 xl:grid-cols-4">
                {facts.map((f) => (
                  <li
                    key={f.key}
                    data-testid={`inv-context-fact-${f.key}`}
                    className="flex min-w-0 flex-col gap-1 rounded-control border border-border bg-surface-2 p-3"
                  >
                    <span className="text-caption font-medium text-text-2">{f.label}</span>
                    {f.text !== null ? (
                      <span className="text-body-sm text-text-1">{f.text}</span>
                    ) : (
                      <span className="text-body-sm text-text-1">
                        <Blank reason={f.reason ?? "no data"} />
                        <span className="block text-caption text-text-2">{f.reason}</span>
                      </span>
                    )}
                    {f.extra ? (
                      <span className="text-caption text-text-2" data-testid="inv-context-mtd">
                        {f.extra}
                      </span>
                    ) : null}
                    <span className="flex flex-wrap items-center gap-1 text-micro text-text-2">
                      {f.asOf ? `As of ${formatDate(f.asOf).text}` : "As of unknown"}
                      {f.small ? <SmallSampleChip testId={`inv-context-small-${f.key}`} /> : null}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ),
          sample: "Each fact states its own sample (days, years) in its card below.",
          small: false,
          asOf:
            facts
              .map((f) => f.asOf)
              .filter((d): d is string => !!d)
              .sort()
              .pop() ?? null,
        };
      }}
    />
  );
}

// ---- Price position ------------------------------------------------------------------------------

const BAND_COPY = { lower: "lower", middle: "middle", upper: "upper" } as const;

function PositionBody({ p }: { p: Position }) {
  const f = (v: number | null | undefined) => formatInr(v ?? null);
  const barOk =
    p.low_52w_close !== null &&
    p.low_52w_close !== undefined &&
    p.high_52w_close !== null &&
    p.high_52w_close !== undefined;
  const band = p.range_band ? BAND_COPY[p.range_band] : null;
  const posReason =
    p.range_pos_52w_pct === null || p.range_pos_52w_pct === undefined
      ? invReason(p.range_pos_52w_reason, "no 52-week range")
      : null;
  const distHigh = p.dist_high_52w_pct;
  const distAll = p.dist_high_all_pct;
  const ext = p.ext_sma200_pct;
  const dist = (v: number | null | undefined, what: string): string =>
    typeof v === "number"
      ? v === 0
        ? `At its ${what}`
        : `${pctText(Math.abs(v)).text} below its ${what}`
      : "—";
  return (
    <div className="flex flex-col gap-3">
      {barOk ? (
        <RangeBar
          label="52-week range (closing prices)"
          low={p.low_52w_close ?? null}
          high={p.high_52w_close ?? null}
          value={p.close ?? null}
          lowText={f(p.low_52w_close).text}
          highText={f(p.high_52w_close).text}
          valueText={f(p.close).text}
          {...(typeof p.pctile_52w === "number" ? { percentile: p.pctile_52w } : {})}
        />
      ) : (
        <p className="text-body-sm text-text-2" data-testid="inv-position-range-null">
          52-week range: <Blank reason={posReason ?? "no 52-week range"} />{" "}
          {posReason ?? "no 52-week range"}
        </p>
      )}
      <dl className="grid gap-3 sm:grid-cols-2">
        <Stat
          label="Position in the 52-week range"
          testId="inv-position-pos"
          value={
            band && posReason === null
              ? `${formatPercent(p.range_pos_52w_pct ?? null, { decimals: 0 }).text} of the way up; trading in the ${band} third of its 52-week range`
              : "—"
          }
          reason={posReason}
        />
        <Stat
          label="From the 52-week highest close"
          testId="inv-position-dist-52w"
          value={dist(distHigh, "52-week highest close")}
          reason={
            typeof distHigh === "number"
              ? null
              : invReason(p.range_pos_52w_reason, "no 52-week figure")
          }
        />
        <Stat
          label="From the highest close in your imported history"
          testId="inv-position-dist-all"
          value={
            typeof distAll === "number"
              ? `${dist(distAll, "highest close in your imported history")}${p.high_all_date ? ` (${formatDate(p.high_all_date).text})` : ""}; your history starts ${formatDate(p.history_first_date ?? null).text}`
              : "—"
          }
          reason={typeof distAll === "number" ? null : "no figure for the imported history"}
        />
        <Stat
          label="Days that closed lower, last 52 weeks"
          testId="inv-position-pctile-52w"
          value={`Closed higher than ${formatPercent(p.pctile_52w ?? null, { decimals: 0 }).text} of the days of the last 52 weeks`}
          reason={typeof p.pctile_52w === "number" ? null : invReason(p.pctile_52w_reason)}
        />
        <Stat
          label="Days that closed lower, your imported history"
          testId="inv-position-pctile-all"
          value={`Closed higher than ${formatPercent(p.pctile_all ?? null, { decimals: 0 }).text} of the days of your imported history (${formatCount(p.pctile_all_n ?? null).text} days)`}
          reason={typeof p.pctile_all === "number" ? null : invReason(p.pctile_all_reason)}
        />
        <Stat
          label="Against its 200-day average"
          testId="inv-position-sma200"
          value={
            typeof ext === "number"
              ? ext === 0
                ? "At its 200-day average"
                : `${pctText(Math.abs(ext)).text} ${ext > 0 ? "above" : "below"} its 200-day average`
              : "—"
          }
          reason={typeof ext === "number" ? null : invReason(p.ext_sma200_reason)}
        />
      </dl>
    </div>
  );
}

function positionPartial(p: Position): string | null {
  const missing =
    typeof p.range_pos_52w_pct !== "number" ||
    typeof p.pctile_52w !== "number" ||
    typeof p.pctile_all !== "number" ||
    typeof p.ext_sma200_pct !== "number";
  return missing ? "Some figures are not available; the reason is shown under each dash." : null;
}

export function PositionCard({ load, blocks }: { load: IndLoad; blocks: InvBlocks }) {
  return (
    <InvCard
      card="position"
      testId="inv-position"
      title="Price position"
      term="price_position"
      load={load}
      block={blocks.position}
      howTo={
        <>
          <p>
            A low position is not a bargain and a high position is not a warning. A stock that has
            risen for years sits high in its own history for structural reasons.
          </p>
          <p>All highs and lows here are closing prices, so they can differ from intraday ones.</p>
        </>
      }
      render={(p) => ({
        body: <PositionBody p={p} />,
        sample: `Based on ${formatCount(p.bars ?? null).text} daily closes.`,
        small: false,
        asOf: p.as_of ?? null,
        partial: positionPartial(p),
      })}
    />
  );
}

// ---- Volatility regime -------------------------------------------------------------------------

const VOL_COPY = {
  lower: "quieter than usual",
  typical: "typical",
  higher: "bigger than usual",
} as const;

function VolBody({ v }: { v: VolRegime }) {
  const band = v.band ? VOL_COPY[v.band] : null;
  const reason = invReason(v.reason, "no volatility figure");
  return (
    <dl className="grid gap-3 sm:grid-cols-3">
      <Stat
        label="Recent swings (21 trading days, annualised)"
        testId="inv-vol-current"
        value={pctText(v.current_vol_pct).text}
        reason={typeof v.current_vol_pct === "number" ? null : reason}
      />
      <Stat
        label="Percentile among its own history"
        testId="inv-vol-percentile"
        value={`${formatCount(v.percentile ?? null).text}`}
        reason={typeof v.percentile === "number" ? null : reason}
      />
      <Stat
        label="Reading"
        testId="inv-vol-band"
        value={band ? `Recent price swings are ${band} for this stock` : "—"}
        reason={band ? null : reason}
      />
    </dl>
  );
}

export function VolRegimeCard({ load, blocks }: { load: IndLoad; blocks: InvBlocks }) {
  return (
    <InvCard
      card="vol"
      testId="inv-vol"
      title="Volatility regime"
      term="vol_regime"
      load={load}
      block={blocks.vol}
      howTo={
        <>
          <p>It says how bumpy the ride has been, not which way the price moved.</p>
          <p>
            Consecutive readings overlap, so the number of readings is not the number of independent
            experiences.
          </p>
        </>
      }
      render={(v) => ({
        body: <VolBody v={v} />,
        sample: `Based on ${formatCount(v.sample ?? null).text} daily readings since ${formatDate(v.first_date ?? null).text}.`,
        small: false,
        asOf: v.as_of ?? null,
        partial:
          typeof v.percentile === "number"
            ? null
            : "Some figures are not available; the reason is shown under each dash.",
      })}
    />
  );
}

// ---- Drawdown profile --------------------------------------------------------------------------

function DrawdownBody({ d }: { d: DrawdownProfile }) {
  const m = d.max_dd;
  const date = (v: string | null | undefined) => formatDate(v ?? null).text;
  const deepest =
    m && typeof m.depth_pct === "number" && m.reason !== "no_drawdown"
      ? `${pctText(Math.abs(m.depth_pct)).text} below its peak of ${date(m.peak_date)}, lowest on ${date(m.trough_date)}, ${m.recovered ? `back at the peak on ${date(m.recovery_date)}` : "not recovered yet"}`
      : null;
  const reasons: string[] = [];
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid gap-3 sm:grid-cols-2">
        <Stat
          label="Now"
          testId="inv-drawdown-current"
          value={
            typeof d.current_dd_pct === "number"
              ? d.current_dd_pct === 0
                ? "At its highest close"
                : `${pctText(Math.abs(d.current_dd_pct)).text} below its highest close, ${formatCount(d.days_since_high ?? null).text} days since that high`
              : "—"
          }
          reason={typeof d.current_dd_pct === "number" ? null : "no current drawdown figure"}
        />
        <Stat
          label="Deepest fall"
          testId="inv-drawdown-max"
          value={deepest ?? "—"}
          reason={deepest ? null : invReason(m?.reason ?? "no_drawdown")}
        />
        <Stat
          label="Time below a previous high"
          testId="inv-drawdown-underwater"
          value={`${pctText(d.time_under_water_pct).text} of days`}
          reason={typeof d.time_under_water_pct === "number" ? null : "no figure"}
        />
        <Stat
          label="Average depth while below"
          testId="inv-drawdown-avg"
          value={pctText(d.avg_underwater_depth_pct).text}
          reason={
            typeof d.avg_underwater_depth_pct === "number"
              ? null
              : invReason(d.avg_underwater_depth_reason, "no figure")
          }
        />
      </dl>
      <div
        className={scrollRegion}
        tabIndex={0}
        role="region"
        aria-label="Recovery time from past falls, scrollable"
      >
        <table className="w-full" data-testid="inv-drawdown-table">
          <caption className="sr-only">
            Past falls of 10% and 20%: episodes, recovered, still open and median days to recover
          </caption>
          <thead>
            <tr>
              <th scope="col" className={th}>
                Fall of at least
              </th>
              <th scope="col" className={th}>
                Episodes
              </th>
              <th scope="col" className={th}>
                Recovered
              </th>
              <th scope="col" className={th}>
                Still open
              </th>
              <th scope="col" className={th}>
                Median days to recover
              </th>
            </tr>
          </thead>
          <tbody>
            {d.recovery.map((r) => {
              const hidden = typeof r.median_days !== "number";
              const why = hidden
                ? `only ${formatCount(r.recovered ?? 0).text} recovered episodes; at least 3 are needed`
                : null;
              if (why) reasons.push(`${r.threshold_pct}% fall: ${why}`);
              return (
                <tr key={r.threshold_pct} data-testid={`inv-drawdown-row-${r.threshold_pct}`}>
                  <th scope="row" className={`${th} border-t border-border`}>
                    {`${formatCount(r.threshold_pct).text}%`}
                  </th>
                  <td className={td}>{formatCount(r.episodes ?? null).text}</td>
                  <td className={td}>{formatCount(r.recovered ?? null).text}</td>
                  <td className={td}>{formatCount(r.open ?? null).text}</td>
                  <td className={td}>
                    <Cell
                      text={`${formatNumber(r.median_days ?? null, { decimals: 1 }).text} days`}
                      reason={why}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Reasons items={reasons} testId="inv-drawdown-reasons" />
    </div>
  );
}

export function DrawdownProfileCard({ load, blocks }: { load: IndLoad; blocks: InvBlocks }) {
  return (
    <InvCard
      card="drawdown"
      testId="inv-drawdown"
      title="Drawdown profile"
      term="drawdown_profile"
      load={load}
      block={blocks.drawdown}
      howTo={
        <>
          <p>
            A drawdown is the fall from the highest earlier close. Recovery time counts calendar
            days from the day the fall first reached 10% or 20% to the day the old high was won
            back.
          </p>
          <p>
            A fall that has not recovered yet is counted as still open and is left out of the
            median, so the median understates the wait for a stock that never came back.
          </p>
        </>
      }
      render={(d) => ({
        body: <DrawdownBody d={d} />,
        sample: `Based on ${formatCount(d.bars ?? null).text} daily closes and ${formatCount(d.episodes_total ?? null).text} past falls of any size.`,
        small: d.recovery.some((r) => r.small_sample === true),
        asOf: d.as_of ?? null,
        partial: null,
      })}
    />
  );
}

// ---- Holding periods ---------------------------------------------------------------------------

const HOLD_LABEL: Record<string, string> = {
  "1m": "1 month",
  "3m": "3 months",
  "6m": "6 months",
  "1y": "1 year",
  "3y": "3 years",
};

function HoldingBody({ h }: { h: HoldingPeriods }) {
  const reasons: string[] = [];
  const first =
    h.windows.find((w) => w.key === "1y" && typeof w.windows === "number" && w.windows > 0) ??
    h.windows.find((w) => typeof w.windows === "number" && w.windows > 0);
  return (
    <div className="flex flex-col gap-3">
      <div
        className={scrollRegion}
        tabIndex={0}
        role="region"
        aria-label="Holding periods, scrollable"
      >
        <table className="w-full" data-testid="inv-holding-table">
          <caption className="sr-only">
            Past holding periods: windows, independent periods, share positive, median, worst and
            best change over the holding period
          </caption>
          <thead>
            <tr>
              {[
                "Held for",
                "Windows",
                "Independent periods",
                "Share positive",
                "Median",
                "Worst",
                "Best",
              ].map((c) => (
                <th key={c} scope="col" className={th}>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {h.windows.map((w) => {
              const label = HOLD_LABEL[w.key] ?? w.key;
              const reason = w.reason ? invReason(w.reason) : null;
              if (reason) reasons.push(`${label}: ${reason}`);
              const dateNote = (d: string | null | undefined) =>
                d ? ` (ended ${formatDate(d).text})` : "";
              return (
                <tr key={w.key} data-testid={`inv-holding-row-${w.key}`}>
                  <th scope="row" className={`${th} border-t border-border`}>
                    {label}
                  </th>
                  <td className={td}>{formatCount(w.windows ?? null).text}</td>
                  <td className={td}>{formatCount(w.independent_periods ?? null).text}</td>
                  <td className={td}>
                    <Cell text={pctText(w.share_positive_pct).text} reason={reason} />
                  </td>
                  <td className={td}>
                    <Cell text={pctText(w.median_pct, { signed: true }).text} reason={reason} />
                  </td>
                  <td className={td} title={`Worst window${dateNote(w.worst_end_date)}`}>
                    <Cell text={pctText(w.worst_pct, { signed: true }).text} reason={reason} />
                    {reason === null && w.worst_end_date ? (
                      <span className="sr-only">{dateNote(w.worst_end_date)}</span>
                    ) : null}
                  </td>
                  <td className={td} title={`Best window${dateNote(w.best_end_date)}`}>
                    <Cell text={pctText(w.best_pct, { signed: true }).text} reason={reason} />
                    {reason === null && w.best_end_date ? (
                      <span className="sr-only">{dateNote(w.best_end_date)}</span>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Reasons items={reasons} testId="inv-holding-reasons" />
      <p className="text-body-sm text-text-1" data-testid="inv-holding-overlap">
        {`Windows overlap, so ${first ? formatCount(first.windows ?? null).text : "the"} windows are fewer independent experiences than the count suggests. Returns are totals over the holding period, not per year.`}
      </p>
    </div>
  );
}

export function HoldingPeriodsCard({ load, blocks }: { load: IndLoad; blocks: InvBlocks }) {
  return (
    <InvCard
      card="holding"
      testId="inv-holding"
      title="Holding periods"
      term="holding_period"
      load={load}
      block={blocks.holding}
      howTo={
        <>
          <p>
            Each row looks at every past day as a possible start and shows what the price change was
            after holding for that long.
          </p>
          <p>Hover or focus a worst or best figure for the day that window ended.</p>
        </>
      }
      render={(h) => ({
        body: <HoldingBody h={h} />,
        sample: `Based on ${formatCount(h.bars ?? null).text} daily closes; the independent periods column is the fairer count.`,
        small: h.windows.some((w) => w.small_sample === true),
        asOf: h.as_of ?? null,
        partial: h.windows.some((w) => w.reason)
          ? "Some holding periods are not available; the reason is shown under the table."
          : null,
      })}
    />
  );
}

// ---- Entry-point study -------------------------------------------------------------------------

function EntryBody({ e }: { e: EntryStudy }) {
  const depths = [...new Set(e.rows.map((r) => r.drawdown_pct))].sort((a, b) => a - b);
  const horizons = [...new Set(e.rows.map((r) => r.horizon))];
  const label = (h: string) =>
    h === "3m" ? "next 3 months" : h === "6m" ? "next 6 months" : `next ${h}`;
  const reasons: string[] = [];
  const anecdotes: string[] = [];
  const pending: string[] = [];
  return (
    <div className="flex flex-col gap-3">
      <div
        className={scrollRegion}
        tabIndex={0}
        role="region"
        aria-label="Entry-point study, scrollable"
      >
        <table className="w-full" data-testid="inv-entry-table">
          <caption className="sr-only">
            What happened over the next 3 and 6 months after a close 10% or 20% below the 52-week
            high: episodes, median, worst, best and share positive
          </caption>
          <thead>
            <tr>
              <td />
              {horizons.map((h) => (
                <th key={h} scope="colgroup" colSpan={6} className={`${th} border-l border-border`}>
                  {label(h)}
                </th>
              ))}
            </tr>
            <tr>
              <th scope="col" className={th}>
                After a close
              </th>
              {horizons.flatMap((h) =>
                ["Episodes", "Median", "Worst", "Best", "Share positive", "All days: median"].map(
                  (c) => (
                    <th key={`${h}-${c}`} scope="col" className={th}>
                      {c}
                    </th>
                  ),
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {depths.map((dd) => (
              <tr key={dd} data-testid={`inv-entry-row-${dd}`}>
                <th scope="row" className={`${th} border-t border-border`}>
                  {`${dd}% below the 52-week high`}
                </th>
                {horizons.flatMap((h) => {
                  const r = e.rows.find((x) => x.drawdown_pct === dd && x.horizon === h);
                  if (!r) {
                    return Array.from({ length: 6 }, (_, i) => (
                      <td key={`${h}-${i}`} className={td}>
                        <Blank reason="not in the stored study" />
                      </td>
                    ));
                  }
                  const n = r.episodes ?? 0;
                  const hidden = r.reason !== null && r.reason !== undefined;
                  const why = hidden ? `only ${formatCount(n).text} past episodes` : null;
                  const row = `${dd}% below, ${label(h)}`;
                  if (why) reasons.push(`${row}: ${why} (at least 3 are needed)`);
                  if (n < 10) {
                    anecdotes.push(
                      `${row}: Only ${formatCount(n).text} past episodes. This is an anecdote about this stock, not a pattern.`,
                    );
                  }
                  if ((r.pending ?? 0) > 0) {
                    pending.push(
                      `${row}: ${formatCount(r.pending ?? 0).text} recent episodes have not completed the window yet.`,
                    );
                  }
                  return [
                    <td key={`${h}-n`} className={td}>
                      {formatCount(r.episodes ?? null).text}
                    </td>,
                    <td key={`${h}-m`} className={td}>
                      <Cell text={pctText(r.median_pct, { signed: true }).text} reason={why} />
                    </td>,
                    <td key={`${h}-w`} className={td}>
                      <Cell text={pctText(r.worst_pct, { signed: true }).text} reason={why} />
                    </td>,
                    <td key={`${h}-b`} className={td}>
                      <Cell text={pctText(r.best_pct, { signed: true }).text} reason={why} />
                    </td>,
                    <td key={`${h}-s`} className={td}>
                      <Cell text={pctText(r.share_positive_pct).text} reason={why} />
                    </td>,
                    <td key={`${h}-a`} className={td}>
                      <Cell
                        text={pctText(r.all_windows_median_pct, { signed: true }).text}
                        reason={
                          typeof r.all_windows_median_pct === "number"
                            ? null
                            : "no figure for all days"
                        }
                      />
                    </td>,
                  ];
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Reasons items={reasons} testId="inv-entry-reasons" />
      {anecdotes.length > 0 ? (
        <ul className="list-disc pl-5 text-body-sm text-text-1" data-testid="inv-entry-anecdote">
          {anecdotes.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      ) : null}
      {pending.length > 0 ? (
        <ul className="list-disc pl-5 text-caption text-text-2" data-testid="inv-entry-pending">
          {pending.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function EntryStudyCard({ load, blocks }: { load: IndLoad; blocks: InvBlocks }) {
  return (
    <InvCard
      card="entry"
      testId="inv-entry"
      title="Entry-point study"
      term="entry_study"
      load={load}
      block={blocks.entry}
      howTo={
        <>
          <p>
            An episode starts the first day the close is 10% or 20% below its 52-week high. Each
            episode counts once, and the three or six months after it do not overlap the next one.
          </p>
          <p>
            The last column shows the median of all days for the same horizon, so the ordinary
            outcome sits next to the conditional one.
          </p>
        </>
      }
      render={(e) => {
        const most = Math.max(0, ...e.rows.map((r) => r.episodes ?? 0));
        return {
          body: <EntryBody e={e} />,
          sample: `Based on at most ${formatCount(most).text} past episodes per row.`,
          small: e.rows.some((r) => r.small_sample === true),
          asOf: e.as_of ?? null,
          partial: e.rows.some((r) => r.reason)
            ? "Some rows have too few past episodes; the reason is shown under the table."
            : null,
        };
      }}
    />
  );
}

// ---- SIP versus lump sum -----------------------------------------------------------------------

function SipBody({ s }: { s: SipBacktest }) {
  const [day, setDay] = useState<string>("first");
  const [announce, setAnnounce] = useState("");
  const variant =
    s.variants.find((v) => (day === "first" ? v.day === null : v.day === Number(day))) ??
    s.variants.find((v) => v.day === null) ??
    s.variants[0];
  const describe = (v: typeof variant): string => {
    if (!v) return "No variant stored.";
    if (v.reason) return `Not shown: ${invReason(v.reason)}.`;
    return `Monthly plan ended at ${formatMultiple(v.value_ratio ?? null).text} the lump sum.`;
  };
  if (!variant) {
    return <p className="text-body-sm text-text-2">No variant is stored. {NOT_COMPUTED}</p>;
  }
  const hidden = variant.reason ? invReason(variant.reason) : null;
  const inr = (v: number | null | undefined) => formatInr(v ?? null, { decimals: 2 }).text;
  const xirrWhy =
    hidden ??
    (variant.sip_xirr_pct === null || variant.sip_xirr_pct === undefined
      ? invReason(variant.xirr_reason ?? "under_one_year")
      : null);
  const row = (label: string, a: string, b: string, why: string | null, id: string) => (
    <tr data-testid={`inv-sip-row-${id}`}>
      <th scope="row" className={`${th} border-t border-border`}>
        {label}
      </th>
      <td className={td}>
        <Cell text={a} reason={why} />
      </td>
      <td className={td}>
        <Cell text={b} reason={why} />
      </td>
    </tr>
  );
  return (
    <div className="flex flex-col gap-3">
      <p
        className="rounded-control border border-border bg-surface-2 px-3 py-2 text-body-sm text-text-1"
        data-testid="inv-sip-banner"
      >
        A replay of the past with hindsight, not an estimate of the future.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="inv-sip-day" className="text-body-sm text-text-1">
          Instalment day
        </label>
        <select
          id="inv-sip-day"
          data-testid="inv-sip-day"
          value={day}
          className={selectCls}
          onChange={(e) => {
            setDay(e.target.value);
            const v = s.variants.find((x) =>
              e.target.value === "first" ? x.day === null : x.day === Number(e.target.value),
            );
            setAnnounce(
              `${e.target.value === "first" ? "First trading day" : `Day ${e.target.value}`}: ${describe(v)}`,
            );
          }}
        >
          <option value="first">First trading day</option>
          {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
            <option key={d} value={String(d)}>
              {`Day ${d}`}
            </option>
          ))}
        </select>
        <span className="sr-only" role="status" aria-live="polite" data-testid="inv-sip-live">
          {announce}
        </span>
      </div>
      {hidden ? (
        <p className="text-body-sm text-text-1" data-testid="inv-sip-hidden">
          <Blank reason={hidden} /> {hidden}
        </p>
      ) : null}
      <p className="text-caption text-text-2">
        {`Monthly amount versus the same total as one lump sum at the start; per ${formatInr(s.amount_per_month_inr ?? null, { decimals: 0 }).text} a month. Hypothetical amounts, not your portfolio.`}
      </p>
      <div
        className={scrollRegion}
        tabIndex={0}
        role="region"
        aria-label="SIP versus lump sum, scrollable"
      >
        <table className="w-full" data-testid="inv-sip-table">
          <caption className="sr-only">
            Monthly plan versus lump sum: invested, value now, absolute return, XIRR and lowest
            point
          </caption>
          <thead>
            <tr>
              <th scope="col" className={th}>
                &nbsp;
              </th>
              <th scope="col" className={th}>
                Monthly plan
              </th>
              <th scope="col" className={th}>
                Lump sum at the start
              </th>
            </tr>
          </thead>
          <tbody>
            {row(
              "Total invested",
              inr(variant.invested_inr),
              inr(variant.invested_inr),
              hidden,
              "invested",
            )}
            {row(
              "Value now",
              inr(variant.sip_value_inr),
              inr(variant.lump_value_inr),
              hidden,
              "value",
            )}
            {row(
              "Absolute return",
              pctText(variant.sip_absolute_return_pct, { signed: true }).text,
              pctText(variant.lump_absolute_return_pct, { signed: true }).text,
              hidden,
              "abs",
            )}
            {row(
              "XIRR (per year)",
              pctText(variant.sip_xirr_pct, { signed: true }).text,
              pctText(variant.lump_xirr_pct, { signed: true }).text,
              xirrWhy,
              "xirr",
            )}
            {row(
              "Lowest point versus money put in",
              pctText(variant.sip_worst_unrealised_pct, { signed: true }).text,
              pctText(variant.lump_worst_unrealised_pct, { signed: true }).text,
              hidden,
              "worst",
            )}
          </tbody>
        </table>
      </div>
      {hidden === null ? (
        <p className="text-body-sm text-text-1" data-testid="inv-sip-ratio">
          {`${formatCount(variant.installments ?? null).text} instalments${(variant.skipped ?? 0) > 0 ? ` (${formatCount(variant.skipped ?? 0).text} skipped)` : ""} from ${formatDate(variant.first_date ?? null).text}. The monthly plan ended at ${formatMultiple(variant.value_ratio ?? null).text} the lump sum.`}
        </p>
      ) : null}
      {xirrWhy && hidden === null ? (
        <p
          className="text-caption text-text-2"
          data-testid="inv-sip-xirr-reason"
        >{`XIRR: ${xirrWhy}.`}</p>
      ) : null}
    </div>
  );
}

export function SipCard({ load, blocks }: { load: IndLoad; blocks: InvBlocks }) {
  return (
    <InvCard
      card="sip"
      testId="inv-sip"
      title="SIP versus lump sum"
      term="sip_vs_lump"
      load={load}
      block={blocks.sip}
      howTo={
        <>
          <p>
            The monthly plan buys on the chosen day of every month in the history. The lump sum puts
            the same total in on the first day.
          </p>
          <p>
            It uses a stock you already follow and the history you imported, so hindsight is built
            in. The percentages do not depend on the amount.
          </p>
        </>
      }
      render={(s) => {
        const first = s.variants.find((v) => v.day === null) ?? s.variants[0];
        return {
          body: <SipBody s={s} />,
          sample: `Based on ${formatCount(first?.installments ?? null).text} monthly instalments.`,
          small: false,
          asOf: s.as_of ?? null,
          partial: null,
        };
      }}
    />
  );
}

// ---- Risk-adjusted return ----------------------------------------------------------------------

function RiskBody({ r }: { r: RiskAdjusted }) {
  const calmarWhy = invReason(r.calmar_3y_reason, "no figure");
  const downWhy = invReason(r.downside_reason, "no figure");
  const ok = (v: number | null | undefined) => typeof v === "number";
  return (
    <dl className="grid gap-3 sm:grid-cols-2">
      <Stat
        label="Growth per unit of deepest fall (3 years)"
        testId="inv-risk-calmar"
        value={formatNumber(r.calmar_3y ?? null, { decimals: 2 }).text}
        reason={ok(r.calmar_3y) ? null : calmarWhy}
      />
      <Stat
        label="Deepest fall in the same 3 years"
        testId="inv-risk-maxdd"
        value={pctText(r.maxdd_3y_window_pct).text}
        reason={ok(r.maxdd_3y_window_pct) ? null : invReason(r.calmar_3y_reason, "no figure")}
      />
      <Stat
        label="Yearly price growth (3 years)"
        testId="inv-risk-cagr"
        value={pctText(r.cagr_3y_pct, { signed: true }).text}
        reason={ok(r.cagr_3y_pct) ? null : invReason(r.calmar_3y_reason, "no figure")}
      />
      <Stat
        label="Downside risk (annualised, falling days only)"
        testId="inv-risk-downside"
        value={pctText(r.downside_dev_3y_pct).text}
        reason={ok(r.downside_dev_3y_pct) ? null : downWhy}
      />
      <Stat
        label="Growth per unit of downside"
        testId="inv-risk-per-downside"
        value={formatNumber(r.return_per_downside_3y ?? null, { decimals: 2 }).text}
        reason={ok(r.return_per_downside_3y) ? null : downWhy}
      />
    </dl>
  );
}

export function RiskAdjustedCard({ load, blocks }: { load: IndLoad; blocks: InvBlocks }) {
  return (
    <InvCard
      card="risk"
      testId="inv-risk"
      title="Calmar and downside risk"
      term="calmar"
      load={load}
      block={blocks.risk}
      howTo={
        <>
          <p>
            Both ratios divide price growth by a measure of the bad stretches in the same 3 years.
            Higher means more growth for each unit of pain, looking backwards only.
          </p>
          <p>Dividends are ignored.</p>
        </>
      }
      render={(r) => ({
        body: (
          <div className="flex flex-col gap-2">
            <RiskBody r={r} />
            <p className="flex items-center gap-1 text-caption text-text-2">
              What downside risk means
              <DefinitionTip term="downside_risk" />
            </p>
          </div>
        ),
        sample: "Based on the last 3 calendar years of daily closes.",
        small: false,
        asOf: r.as_of ?? null,
        partial:
          typeof r.calmar_3y === "number" && typeof r.return_per_downside_3y === "number"
            ? null
            : "Some figures are not available; the reason is shown under each dash.",
      })}
    />
  );
}
