"use client";

import { useState } from "react";
import { Card } from "@/components/ui/Card";
import { DefinitionTip } from "@/components/ui/DefinitionTip";
import { formatCount, formatDate, formatInr, formatNumber, formatPercent } from "@/lib/format";
import { INV_SOURCE, invReason } from "@/lib/stock/inv-model";
import type { Block } from "@/lib/stock/inv-schemas";
import type { Load } from "@/lib/stock/load";
import type { IndicatorsData } from "@/lib/stock/schemas";
import type {
  SwingDipRow,
  SwingDips,
  SwingLegRow,
  SwingParsed,
  SwingRecord,
} from "@/lib/stock/swing-schemas";
import { Cell, InvCard, Reasons, scrollRegion, selectCls, td, th } from "./InvCards";

// The Swing dips card (docs/06 6.4a item 4a, docs/05 12.13). An additional card beside the Drawdown
// profile, which is unchanged. Past prices only: no verdict, no score, no target. Numbers go
// through format.ts; an unknown value is an em dash with its reason as readable text.

type IndLoad = Load<IndicatorsData>;

const MIN_DIPS = 3;
const DIFFERS =
  "The drawdown profile measures every fall from the highest close in your history. Swing dips measure falls from the recent 52-week high, so a stock that peaked years ago still shows its repeated falls and recoveries.";
const LEGS_CAPTION =
  "A bounce is not a recovery of the old high; the last fall may still be going, so it is shown as open.";
const NEEDS_YEAR = "Needs about a year of prices (252 trading days).";

const pct = (v: number | null | undefined, signed = false) =>
  formatPercent(v ?? null, { decimals: 1, signed }).text;
const count = (v: number | null | undefined) => formatCount(v ?? null).text;
const days = (v: number | null | undefined) =>
  v === null || v === undefined ? "—" : `${formatNumber(v, { decimals: 0 }).text} days`;
const medDays = (v: number | null | undefined) =>
  `${formatNumber(v ?? null, { decimals: 1 }).text} days`;
const date = (v: string | null | undefined) => formatDate(v ?? null).text;
const price = (v: number | null | undefined) => formatInr(v ?? null).text;

/** Plain-English reason for a hidden figure, with the sample size the rule looked at. */
function why(code: string | null | undefined, n: number | null | undefined, what: string): string {
  if (code === "too_few_episodes") {
    const noun = n === 1 ? what.replace(/s$/, "") : what;
    return `only ${count(n ?? 0)} ${noun}; at least ${MIN_DIPS} are needed`;
  }
  if (code === "no_dips") return "no dip of this size in the history";
  if (code === "no_open_dip") return "none is open";
  if (code === "open_dip") return "not recovered yet";
  return invReason(code);
}

function SwingTable({ rows, reasons }: { rows: SwingDipRow[]; reasons: string[] }) {
  return (
    <div
      className={scrollRegion}
      tabIndex={0}
      role="region"
      aria-label="Swing dips by size of fall, scrollable"
    >
      <table className="w-full" data-testid="inv-swing-table">
        <caption className="sr-only">
          Falls of at least 10% and 20% below the 52-week high: dips, recovered, still open, shares
          and medians
        </caption>
        <thead>
          <tr>
            <th scope="col" className={th}>
              Fall of at least
            </th>
            <th scope="col" className={th}>
              Dips
            </th>
            <th scope="col" className={th}>
              Recovered
            </th>
            <th scope="col" className={th}>
              Still open
            </th>
            <th scope="col" className={th}>
              Recovered share
            </th>
            <th scope="col" className={th}>
              Median depth
            </th>
            <th scope="col" className={th}>
              Worst depth
            </th>
            <th scope="col" className={th}>
              Median days peak to low
            </th>
            <th scope="col" className={th}>
              Median days to recover (completed dips only)
            </th>
            <th scope="col" className={th}>
              Longest open so far
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const label = `${count(r.threshold_pct)}%`;
            if (r.reason === "insufficient_history") {
              reasons.push(`${label} fall: ${NEEDS_YEAR}`);
              return (
                <tr key={r.threshold_pct} data-testid={`inv-swing-row-${r.threshold_pct}`}>
                  <th scope="row" className={`${th} border-t border-border`}>
                    {label}
                  </th>
                  <td className={`${td} text-left`} colSpan={9}>
                    {NEEDS_YEAR}
                  </td>
                </tr>
              );
            }
            const cell = (
              value: number | null | undefined,
              code: string | null | undefined,
              n: number | null | undefined,
              what: string,
              text: (v: number | null | undefined) => string,
              fallback: string,
            ) => {
              const reason =
                typeof value === "number" ? null : code ? why(code, n, what) : fallback;
              if (reason) reasons.push(`${label} fall: ${reason}`);
              return <Cell text={text(value)} reason={reason} />;
            };
            return (
              <tr key={r.threshold_pct} data-testid={`inv-swing-row-${r.threshold_pct}`}>
                <th scope="row" className={`${th} border-t border-border`}>
                  {label}
                </th>
                <td className={td}>{count(r.dips)}</td>
                <td className={td}>{count(r.recovered)}</td>
                <td className={td} data-testid={`inv-swing-open-count-${r.threshold_pct}`}>
                  {count(r.open)}
                </td>
                <td className={td}>
                  {cell(
                    r.recovered_share_pct,
                    r.recovered_share_reason,
                    r.dips,
                    "dips",
                    (v) => pct(v),
                    "no figure",
                  )}
                </td>
                <td className={td}>
                  {cell(
                    r.median_depth_pct,
                    r.median_depth_reason,
                    r.dips,
                    "dips",
                    (v) => pct(v, true),
                    "no figure",
                  )}
                </td>
                <td className={td}>
                  {cell(
                    r.worst_depth_pct,
                    r.worst_depth_reason,
                    r.dips,
                    "dips",
                    (v) => pct(v, true),
                    "no figure",
                  )}
                </td>
                <td className={td}>
                  {cell(
                    r.median_days_peak_to_low,
                    r.median_days_peak_to_low_reason,
                    r.dips,
                    "dips",
                    medDays,
                    "no figure",
                  )}
                </td>
                <td className={td}>
                  {cell(
                    r.median_days_to_recover,
                    r.median_days_to_recover_reason,
                    r.recovered,
                    "recovered dips",
                    medDays,
                    "no figure",
                  )}
                </td>
                <td className={td}>
                  {cell(r.longest_open_days, r.longest_open_reason, null, "", days, "no figure")}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RecordRow({ r, openDays }: { r: SwingRecord; openDays: number | null | undefined }) {
  const open = r.status === "open";
  return (
    <tr data-testid="inv-swing-record" data-status={r.status ?? "unknown"}>
      <td className={`${td} text-left`}>
        {date(r.peak_date)}
        <span className="block text-micro text-text-2">{price(r.peak_close)}</span>
      </td>
      <td className={`${td} text-left`}>{date(r.start_date)}</td>
      <td className={`${td} text-left`}>
        {date(r.low_date)}
        <span className="block text-micro text-text-2">{price(r.low_close)}</span>
      </td>
      <td className={td}>{pct(r.depth_pct, true)}</td>
      <td className={td}>{days(r.days_peak_to_low)}</td>
      <td className={`${td} text-left`}>
        {open ? (
          <>
            <span
              data-testid="inv-swing-open"
              className="inline-flex items-center rounded-chip border border-warn bg-surface-2 px-2 py-0.5 text-micro text-text-1"
            >
              Open
            </span>
            <span className="block text-micro text-text-2">
              {typeof openDays === "number"
                ? `not recovered yet (open for ${count(openDays)} days since the peak)`
                : "not recovered yet"}
            </span>
          </>
        ) : r.recovery_date ? (
          <>
            {date(r.recovery_date)}
            <span className="block text-micro text-text-2">
              {days(r.days_low_to_recovery)} after the low
            </span>
          </>
        ) : (
          <Cell text="—" reason={invReason(r.days_low_to_recovery_reason, "no recovery date")} />
        )}
      </td>
    </tr>
  );
}

function RecordsTable({ rows }: { rows: SwingDipRow[] }) {
  const [pick, setPick] = useState<number>(rows[0]?.threshold_pct ?? 10);
  const row = rows.find((r) => r.threshold_pct === pick) ?? rows[0];
  if (!row) return null;
  const shown = row.records.length;
  const total = row.dips ?? shown;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2" data-testid="inv-swing-pick">
        <label htmlFor="inv-swing-pick-select" className="text-caption text-text-2">
          Last dips of at least
        </label>
        <select
          id="inv-swing-pick-select"
          data-testid="inv-swing-pick-select"
          className={selectCls}
          value={pick}
          onChange={(e) => setPick(Number(e.target.value))}
        >
          {rows.map((r) => (
            <option key={r.threshold_pct} value={r.threshold_pct}>
              {`${count(r.threshold_pct)}% fall`}
            </option>
          ))}
        </select>
      </div>
      {shown === 0 ? (
        <p className="text-body-sm text-text-2" data-testid="inv-swing-records-empty">
          {row.reason === "insufficient_history"
            ? NEEDS_YEAR
            : `No dip of ${count(row.threshold_pct)}% or more in this history.`}
        </p>
      ) : (
        <div
          className={scrollRegion}
          tabIndex={0}
          role="region"
          aria-label="Last swing dips, scrollable"
        >
          <table className="w-full" data-testid="inv-swing-records">
            <caption className="sr-only">
              {`Last ${count(shown)} dips of at least ${count(row.threshold_pct)}%, newest first`}
            </caption>
            <thead>
              <tr>
                <th scope="col" className={th}>
                  Peak
                </th>
                <th scope="col" className={th}>
                  Dip began
                </th>
                <th scope="col" className={th}>
                  Low
                </th>
                <th scope="col" className={th}>
                  Depth
                </th>
                <th scope="col" className={th}>
                  Days to low
                </th>
                <th scope="col" className={th}>
                  Recovered
                </th>
              </tr>
            </thead>
            <tbody>
              {row.records.map((r, i) => (
                <RecordRow
                  key={`${r.peak_date ?? "p"}-${i}`}
                  r={r}
                  openDays={row.longest_open_days}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-caption text-text-2" data-testid="inv-swing-records-count">
        {`Showing the last ${count(shown)} of ${count(total)} dips of at least ${count(row.threshold_pct)}%.`}
      </p>
    </div>
  );
}

function LegsTable({ rows, reasons }: { rows: SwingLegRow[]; reasons: string[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="flex flex-col gap-2" data-testid="inv-swing-legs">
      <h4 className="text-body-sm font-medium text-text-1">
        Swings inside the moves: a fall of X% followed by a bounce of X%
      </h4>
      <div
        className={scrollRegion}
        tabIndex={0}
        role="region"
        aria-label="Swing legs by size, scrollable"
      >
        <table className="w-full" data-testid="inv-swing-legs-table">
          <caption className="sr-only">{LEGS_CAPTION}</caption>
          <thead>
            <tr>
              {[
                "Fall and bounce of",
                "Swings",
                "Bounced",
                "Still open",
                "Median depth",
                "Worst depth",
                "Median days peak to low",
                "Median days low to bounce (completed only)",
              ].map((h) => (
                <th key={h} scope="col" className={th}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const label = `${count(r.threshold_pct)}%`;
              if (r.reason === "insufficient_history") {
                return (
                  <tr key={r.threshold_pct} data-testid={`inv-swing-leg-row-${r.threshold_pct}`}>
                    <th scope="row" className={`${th} border-t border-border`}>
                      {label}
                    </th>
                    <td className={`${td} text-left`} colSpan={7}>
                      {invReason("insufficient_history")}
                    </td>
                  </tr>
                );
              }
              const cell = (
                value: number | null | undefined,
                code: string | null | undefined,
                n: number | null | undefined,
                what: string,
                text: (v: number | null | undefined) => string,
              ) => {
                const reason = typeof value === "number" ? null : why(code ?? "no_figure", n, what);
                if (reason) reasons.push(`${label} swings: ${reason}`);
                return <Cell text={text(value)} reason={reason} />;
              };
              return (
                <tr key={r.threshold_pct} data-testid={`inv-swing-leg-row-${r.threshold_pct}`}>
                  <th scope="row" className={`${th} border-t border-border`}>
                    {label}
                  </th>
                  <td className={td}>{count(r.legs)}</td>
                  <td className={td}>{count(r.bounced)}</td>
                  <td className={td}>{count(r.open)}</td>
                  <td className={td}>
                    {cell(r.median_depth_pct, r.median_depth_reason, r.legs, "swings", (v) =>
                      pct(v, true),
                    )}
                  </td>
                  <td className={td}>
                    {cell(r.worst_depth_pct, r.worst_depth_reason, r.legs, "swings", (v) =>
                      pct(v, true),
                    )}
                  </td>
                  <td className={td}>
                    {cell(
                      r.median_days_peak_to_low,
                      r.median_days_peak_to_low_reason,
                      r.legs,
                      "swings",
                      medDays,
                    )}
                  </td>
                  <td className={td}>
                    {cell(
                      r.median_days_to_bounce,
                      r.median_days_to_bounce_reason,
                      r.bounced,
                      "bounced swings",
                      medDays,
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-caption text-text-2" data-testid="inv-swing-legs-note">
        {LEGS_CAPTION}
      </p>
    </div>
  );
}

function SwingBody({ s }: { s: SwingDips }) {
  const reasons: string[] = [];
  return (
    <div className="flex flex-col gap-3">
      <p className="text-body-sm text-text-1" data-testid="inv-swing-differs">
        {DIFFERS}
      </p>
      <SwingTable rows={s.thresholds} reasons={reasons} />
      <RecordsTable rows={s.thresholds} />
      <LegsTable rows={s.zigzag} reasons={reasons} />
      <Reasons items={reasons} testId="inv-swing-reasons" />
    </div>
  );
}

export function SwingDipsCard({ load, swing }: { load: IndLoad; swing: SwingParsed }) {
  if (
    load.state === "ready" &&
    swing.block.kind === "missing" &&
    swing.reason === "compute_error"
  ) {
    return (
      <Card
        title="Swing dips"
        testId="inv-swing"
        state="empty"
        message="Swing dips could not be computed for this stock (compute_error). The other cards are unaffected."
        info={<DefinitionTip term="swing_dips" />}
        source={INV_SOURCE}
      />
    );
  }
  const block: Block<SwingDips> = swing.block;
  return (
    <InvCard
      card="swing"
      testId="inv-swing"
      title="Swing dips"
      term="swing_dips"
      load={load}
      block={block}
      howTo={
        <>
          <p>
            A dip starts when the close is at least 10% (or 20%) below the highest close of the 52
            weeks before it, and it ends when the price is back at that earlier high. Falls that
            have not ended are counted as open.
          </p>
          <p>
            Median days to recover use only dips that ended, so they understate the wait for a stock
            that stays down. Days are calendar days between price dates. Swing legs count every fall
            of that size followed by an equal bounce, a different question from recovery.
          </p>
        </>
      }
      render={(s) => {
        const parts = s.thresholds
          .filter((r) => typeof r.dips === "number")
          .map((r) => `${count(r.dips)} dips of at least ${count(r.threshold_pct)}%`);
        const sample =
          parts.length > 0
            ? `Based on ${parts.join(" and ")} in ${count(s.bars)} daily closes.`
            : `Based on ${count(s.bars)} daily closes; no dip figures yet.`;
        return {
          body: <SwingBody s={s} />,
          sample,
          small:
            s.thresholds.some((r) => r.small_sample === true && !r.reason) ||
            s.zigzag.some((r) => r.small_sample === true && !r.reason),
          asOf: s.as_of ?? null,
          partial: null,
        };
      }}
    />
  );
}
