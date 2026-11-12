"use client";

import Link from "next/link";
import { useMemo } from "react";
import { ChartFrame } from "@/components/charts/ChartFrame";
import { Card } from "@/components/ui/Card";
import { SmallSampleChip } from "@/components/ui/chips";
import { DefinitionTip } from "@/components/ui/DefinitionTip";
import { asOfText, isOlderThanExpected } from "@/lib/dashboard/state";
import { formatCount, formatDate, formatNumber, formatPercent } from "@/lib/format";
import {
  INDEX_LABEL,
  NO_INDEX_HINT,
  PEER_LABEL,
  PEER_STALE_NOTE,
  RS_NOTE,
  RS_NOT_COMPUTED,
  RS_SOURCE,
  percentileText,
  ppText,
  rankText,
  ratioPlan,
  rsReason,
} from "@/lib/stock/rst-model";
import {
  parseRelativeStrength,
  type PeerWindow,
  type RelativeStrength,
  type VsIndex,
  type VsPeers,
} from "@/lib/stock/rst-schemas";
import type { Load } from "@/lib/stock/load";
import type { IndicatorsData } from "@/lib/stock/schemas";

// "Relative strength" card of the Analysis tab (docs/06 6.4a.RST; formulas docs/05 12.14). It
// describes past prices: no verdict, no score, no colour judgement. The browser formats and
// selects; every number comes from the stored block.

type IndLoad = Load<IndicatorsData>;

const scrollRegion = "relative overflow-x-auto rounded-control border border-border";
const th = "px-2 py-1 text-left text-caption font-medium text-text-2";
const td = "num border-t border-border px-2 py-1 text-right text-body-sm text-text-1";
const linkCls =
  "touch-target inline-flex items-center text-body-sm text-accent underline focus-visible:outline-2";

/** An unknown value: an em dash with the reason as a tooltip and as text a screen reader can read. */
function Blank({ reason }: { reason: string }) {
  return (
    <span title={reason}>
      {"—"}
      <span className="sr-only">{` (${reason})`}</span>
    </span>
  );
}

function Cell({ text, reason }: { text: string; reason: string | null }) {
  return reason === null ? <>{text}</> : <Blank reason={reason} />;
}

/** Visible list of why something is blank (a phone has no hover). */
function Reasons({ items, testId }: { items: string[]; testId: string }) {
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

const pctText = (v: number | null | undefined, signed = false) =>
  formatPercent(v ?? null, { decimals: 1, ...(signed ? { signed: true } : {}) }).text;

// ---- Against the Nifty 50 ------------------------------------------------------------------------

function WindowsTable({ v, reasons }: { v: VsIndex; reasons: string[] }) {
  return (
    <div
      className={scrollRegion}
      tabIndex={0}
      role="region"
      aria-label="Return against the Nifty 50 by period, scrollable"
    >
      <table className="w-full" data-testid="inv-rs-windows">
        <caption className="sr-only">
          Stock return minus Nifty 50 return over the last 1, 3 and 6 months and 1 year, in
          percentage points
        </caption>
        <thead>
          <tr>
            {["Period", "Stock", "Nifty 50", "Difference (pp)"].map((c) => (
              <th key={c} scope="col" className={th}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {v.windows.map((w) => {
            const label = INDEX_LABEL[w.key] ?? w.key;
            const reason = w.reason ? rsReason(w.reason) : null;
            if (reason) reasons.push(`${label}: ${reason}`);
            const rows =
              typeof w.rows === "number" ? `${formatCount(w.rows).text} trading days` : "";
            return (
              <tr key={w.key} data-testid={`inv-rs-window-${w.key}`}>
                <th scope="row" className={`${th} border-t border-border`} title={rows}>
                  {label}
                </th>
                <td className={td}>
                  <Cell text={pctText(w.stock_pct, true)} reason={reason} />
                </td>
                <td className={td}>
                  <Cell text={pctText(w.index_pct, true)} reason={reason} />
                </td>
                <td className={td}>
                  <Cell text={ppText(w.excess_pp)} reason={reason} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function YearsTable({ v }: { v: VsIndex }) {
  if (v.years.length === 0) return null;
  return (
    <div
      className={scrollRegion}
      tabIndex={0}
      role="region"
      aria-label="Return against the Nifty 50 by calendar year, scrollable"
    >
      <table className="w-full" data-testid="inv-rs-years">
        <caption className="sr-only">
          Stock return minus Nifty 50 return for each calendar year, in percentage points
        </caption>
        <thead>
          <tr>
            {["Year", "Stock", "Nifty 50", "Difference (pp)"].map((c) => (
              <th key={c} scope="col" className={th}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {v.years.map((y) => {
            const span = `from ${formatDate(y.base_date ?? null).text} to ${formatDate(y.end_date ?? null).text}`;
            return (
              <tr key={y.year} data-testid={`inv-rs-year-${y.year}`}>
                <th scope="row" className={`${th} border-t border-border`} title={span}>
                  {y.kind === "ytd" ? `${y.year} (year to date)` : String(y.year)}
                  <span className="sr-only">{` ${span}`}</span>
                </th>
                <td className={td}>{pctText(y.stock_pct, true)}</td>
                <td className={td}>{pctText(y.index_pct, true)}</td>
                <td className={td}>{ppText(y.excess_pp)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function BeatShare({ r }: { r: NonNullable<VsIndex["rolling_year"]> }) {
  const reason =
    r.share_beat_pct === null || r.share_beat_pct === undefined ? rsReason(r.reason) : null;
  const windows = formatCount(r.windows ?? null).text;
  return (
    <div className="flex flex-col gap-1" data-testid="inv-rs-beat">
      <p className="text-body text-text-1">
        {reason === null ? (
          <>
            {`In ${pctText(r.share_beat_pct)} of ${windows} past one-year periods the stock beat the index (median difference ${ppText(r.median_excess_pp)}).`}
          </>
        ) : (
          <>
            {"Share of one-year periods that beat the index: "}
            <Blank reason={reason} />
          </>
        )}
      </p>
      {reason !== null ? (
        <p className="text-caption text-text-2" data-testid="inv-rs-beat-reason">
          {r.reason === "too_few_windows"
            ? `Only ${windows} one-year periods; at least 20 are needed.`
            : r.reason === "insufficient_overlap"
              ? "Needs at least a year of dates in common with the index."
              : `${reason.charAt(0).toUpperCase()}${reason.slice(1)}.`}
        </p>
      ) : null}
      {typeof r.windows === "number" && r.windows > 0 ? (
        <p className="text-body-sm text-text-1" data-testid="inv-rs-beat-overlap">
          {`These windows overlap: ${windows} windows are about ${formatCount(r.independent_periods ?? null).text} independent one-year periods.`}
        </p>
      ) : null}
    </div>
  );
}

function IndexSection({
  v,
  dates,
  asOf,
}: {
  v: VsIndex;
  dates: ReadonlyArray<string>;
  asOf: string | null;
}) {
  const reasons: string[] = [];
  const plan = useMemo(() => ratioPlan(v, dates, asOf), [v, dates, asOf]);
  return (
    <section
      className="flex flex-col gap-3"
      data-testid="inv-rs-index"
      aria-label="Against the Nifty 50"
    >
      <h3 className="flex items-center gap-1 text-body font-medium text-text-1">
        Against the Nifty 50
        <DefinitionTip term="relative_return" />
      </h3>
      <WindowsTable v={v} reasons={reasons} />
      <Reasons items={reasons} testId="inv-rs-reasons" />
      <YearsTable v={v} />
      {plan.kind === "chart" ? (
        <div className="flex flex-col gap-1">
          <ChartFrame
            title="Stock divided by Nifty 50, first day shown = 100"
            testId="inv-rs-chart"
            dataset={plan.dataset}
            info={<DefinitionTip term="relative_line" />}
            height={240}
            filename="relative-strength-ratio"
          />
          <p className="text-caption text-text-2" data-testid="inv-rs-chart-summary">
            {`Since ${formatDate(v.ratio_base_date ?? null).text} the ratio moved from 100 to ${formatNumber(plan.last, { decimals: 1 }).text}. A rising line means the stock did better than the index over that stretch; it says nothing about what comes next.`}
          </p>
        </div>
      ) : (
        <p className="text-body-sm text-text-2" data-testid="inv-rs-chart-none">
          {`No ratio line: ${plan.reason}.`}
        </p>
      )}
      {v.rolling_year ? (
        <div className="flex flex-col gap-1">
          <h4 className="flex items-center gap-1 text-body-sm font-medium text-text-1">
            One-year periods that beat the index
            <DefinitionTip term="beat_share" />
          </h4>
          <BeatShare r={v.rolling_year} />
        </div>
      ) : null}
      <p className="text-caption text-text-2" data-testid="inv-rs-aligned">
        {`Based on ${formatCount(v.aligned_rows ?? null).text} dates present in both your stock and your NIFTY50 prices (${formatDate(v.first_aligned ?? null).text} to ${formatDate(v.last_aligned ?? null).text}). ${formatCount(v.dropped_stock_dates ?? null).text} stock dates and ${formatCount(v.dropped_index_dates ?? null).text} index dates were present in only one series and were left out.`}
      </p>
    </section>
  );
}

function NoIndex({ reason }: { reason: string | null }) {
  if (reason === "no_index_series") {
    return (
      <section
        className="flex flex-col items-start gap-2"
        data-testid="inv-rs-no-index"
        aria-label="Against the Nifty 50"
      >
        <h3 className="text-body font-medium text-text-1">Against the Nifty 50</h3>
        <p className="text-body-sm text-text-1">{NO_INDEX_HINT}</p>
        <p className="text-caption text-text-2">{rsReason(reason)}.</p>
        <Link href="/imports" data-testid="inv-rs-import-link" className={linkCls}>
          Open the Import Center
        </Link>
      </section>
    );
  }
  return (
    <section
      className="flex flex-col gap-1"
      data-testid="inv-rs-index-error"
      aria-label="Against the Nifty 50"
    >
      <h3 className="text-body font-medium text-text-1">Against the Nifty 50</h3>
      <p className="text-body-sm text-text-1">
        {reason === null
          ? "This part came back in an unexpected shape."
          : `Not shown: ${rsReason(reason)}.`}
      </p>
    </section>
  );
}

// ---- Against sector peers ------------------------------------------------------------------------

function PeerTile({ w, sector }: { w: PeerWindow; sector: string }) {
  const label = PEER_LABEL[w.key] ?? w.key;
  const rank = rankText(w);
  const peers = formatCount(w.n_peers ?? null).text;
  const reason = rank === null ? rsReason(w.reason) : null;
  return (
    <li
      className="flex min-w-0 flex-col gap-1 rounded-control border border-border p-2"
      data-testid={`inv-rs-peer-${w.key}`}
    >
      <span className="text-caption text-text-2">{label}</span>
      {rank !== null ? (
        <>
          <span className="num text-body text-text-1" data-testid={`inv-rs-peer-${w.key}-rank`}>
            {rank}
          </span>
          <span className="text-body-sm text-text-1">
            {`${percentileText(w.percentile)} among your tracked ${sector} stocks`}
          </span>
          <span className="num text-body-sm text-text-1">
            {`Stock ${pctText(w.stock_pct, true)}; peer median ${pctText(w.peer_median_pct, true)}; difference ${ppText(w.vs_median_pp)}`}
          </span>
        </>
      ) : (
        <span className="text-body-sm text-text-1" data-testid={`inv-rs-peer-${w.key}-reason`}>
          {w.reason === "too_few_peers"
            ? `Needs at least 3 peers (you track ${peers} other ${sector} stocks with data)`
            : `Not shown: ${reason ?? "no data"}`}
          <span className="sr-only">{` (${reason ?? ""})`}</span>
        </span>
      )}
      <span className="flex flex-wrap items-center gap-2 text-caption text-text-2">
        {`${peers} peers`}
        {w.small_sample === true && rank !== null ? (
          <SmallSampleChip testId={`inv-rs-peer-${w.key}-small`} />
        ) : null}
      </span>
    </li>
  );
}

function PeersSection({ p }: { p: VsPeers }) {
  const sector = p.sector ?? "same-sector";
  return (
    <section
      className="flex flex-col gap-3"
      data-testid="inv-rs-peers"
      aria-label="Against peers in the same sector"
    >
      <h3 className="flex items-center gap-1 text-body font-medium text-text-1">
        {`Against peers in ${p.sector ?? "the same sector"}`}
        <DefinitionTip term="peer_rank" />
      </h3>
      <ul className="grid min-w-0 gap-2 sm:grid-cols-3" data-testid="inv-rs-peer-strip">
        {p.windows.map((w) => (
          <PeerTile key={w.key} w={w} sector={sector} />
        ))}
      </ul>
      <p className="text-caption text-text-2" data-testid="inv-rs-peer-note">
        {`Compared only with stocks you track in the same sector; a sector index is not available. ${PEER_STALE_NOTE(asOfText(p.as_of ?? null))}`}
        {typeof p.excluded === "number" && p.excluded > 0
          ? ` ${formatCount(p.excluded).text} same-sector stocks were left out (no price on ${asOfText(p.as_of ?? null) ?? "that date"} or too little history).`
          : ""}
      </p>
    </section>
  );
}

function NoPeers({ reason }: { reason: string | null }) {
  if (reason === "no_sector") {
    return (
      <section
        className="flex flex-col items-start gap-2"
        data-testid="inv-rs-no-sector"
        aria-label="Against peers in the same sector"
      >
        <h3 className="text-body font-medium text-text-1">Against peers in the same sector</h3>
        <p className="text-body-sm text-text-1">
          Add a sector for this stock to compare it with your other tracked stocks.
        </p>
        <Link href="/imports" data-testid="inv-rs-sector-link" className={linkCls}>
          Import sector data
        </Link>
      </section>
    );
  }
  return (
    <section
      className="flex flex-col gap-1"
      data-testid="inv-rs-peers-error"
      aria-label="Against peers in the same sector"
    >
      <h3 className="text-body font-medium text-text-1">Against peers in the same sector</h3>
      <p className="text-body-sm text-text-1">
        {reason === null
          ? "This part came back in an unexpected shape."
          : `Not shown: ${rsReason(reason)}.`}
      </p>
    </section>
  );
}

// ---- The card ------------------------------------------------------------------------------------

function sampleText(r: RelativeStrength): string {
  const parts: string[] = [];
  if (r.vs_index) {
    parts.push(
      `${formatCount(r.vs_index.aligned_rows ?? null).text} dates in common with the index`,
    );
  }
  const peers = r.vs_peers?.windows.find((w) => w.key === "1y") ?? r.vs_peers?.windows[0];
  if (peers) parts.push(`${formatCount(peers.n_peers ?? null).text} peers`);
  return parts.length > 0 ? `Based on ${parts.join(" and ")}.` : "No figures to base this on.";
}

function anySmall(r: RelativeStrength): boolean {
  return (
    r.vs_index?.rolling_year?.small_sample === true ||
    (r.vs_peers?.windows.some((w) => w.small_sample === true && w.rank !== null) ?? false)
  );
}

export function RelativeStrengthCard({
  load,
  analysis,
}: {
  load: IndLoad;
  /** `data.analysis` of the indicators response (parsed here, on its own). */
  analysis: unknown;
}) {
  const info = <DefinitionTip term="relative_return" />;
  const title = "Relative strength";
  const parsed = useMemo(() => parseRelativeStrength(analysis), [analysis]);
  if (load.state === "loading") {
    return <Card title={title} testId="inv-rs" state="loading" info={info} source={RS_SOURCE} />;
  }
  if (load.state === "error") {
    const id = load.requestId ? ` Request id: ${load.requestId}.` : "";
    return (
      <Card
        title={title}
        testId="inv-rs"
        state="error"
        message={`${load.message}${id}`}
        onRetry={load.retry}
        info={info}
        source={RS_SOURCE}
      />
    );
  }
  const block = parsed.block;
  if (load.state === "unavailable" || block.kind === "missing") {
    return (
      <Card
        title={title}
        testId="inv-rs"
        state="empty"
        message={RS_NOT_COMPUTED}
        info={info}
        source={RS_SOURCE}
      />
    );
  }
  if (block.kind === "error") {
    return (
      <Card
        title={title}
        testId="inv-rs"
        state="error"
        message="This card's figures came back in an unexpected shape. The rest of the tab is unaffected."
        info={info}
        source={RS_SOURCE}
      />
    );
  }
  const r = block.value;
  const asOf = r.as_of ?? null;
  const stale = isOlderThanExpected(asOf, new Date()) || load.stale;
  const missingHalf = r.vs_index === null || r.vs_index === undefined || !r.vs_peers;
  return (
    <Card
      title={title}
      testId="inv-rs"
      state={missingHalf ? "partial" : "ready"}
      message={
        missingHalf
          ? "Part of this card is not available; the reason is shown in its section."
          : undefined
      }
      stale={stale}
      info={info}
      source={RS_SOURCE}
      asOf={asOfText(asOf)}
    >
      <div className="flex flex-col gap-4">
        <p className="text-caption text-text-2" data-testid="inv-rs-source">
          {`Source: your imported prices and your imported NIFTY50, as of ${formatDate(asOf).text}. Price return, excludes dividends.`}
        </p>
        {r.vs_index ? (
          <IndexSection v={r.vs_index} dates={parsed.dates} asOf={asOf} />
        ) : (
          <NoIndex reason={r.vs_index_reason ?? null} />
        )}
        {r.vs_peers ? (
          <PeersSection p={r.vs_peers} />
        ) : (
          <NoPeers reason={r.vs_peers_reason ?? null} />
        )}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-caption text-text-2" data-testid="inv-rs-sample">
            {sampleText(r)}
          </span>
          {anySmall(r) ? <SmallSampleChip testId="inv-rs-small" /> : null}
        </div>
        <details data-testid="inv-rs-howto" className="text-body-sm text-text-1">
          <summary className="min-h-9 cursor-pointer py-1 text-text-2">How to read</summary>
          <div className="flex flex-col gap-1 pb-1 text-text-2">
            <p>
              The difference is the stock&apos;s price change minus the Nifty 50&apos;s over the
              same days, in percentage points. A positive number means the stock did better.
            </p>
            <p>
              The line divides the stock by the index and starts at 100; up means the stock gained
              on the index, down means it lost ground.
            </p>
            <p>
              Peer rank compares only stocks you track in the same sector (rank 1 is the biggest
              gain). It is not the whole sector, and no sector index is used.
            </p>
          </div>
        </details>
        <p className="text-caption text-text-2" data-testid="inv-rs-note">
          {RS_NOTE}
        </p>
      </div>
    </Card>
  );
}
