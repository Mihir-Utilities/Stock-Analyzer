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

/** INV_MIN_EPISODES default; the block carries the real value (`min_episodes`). */
const DEFAULT_MIN = 3;

const DIFFERS =
  "The drawdown profile above measures every fall from the highest close in your history. The dip table below follows one reference peak at a time, until that peak is regained or drops out of the 52-week window (then the dip is closed as not regained within a year and the next dip is measured from the new 52-week high). The repeated ups and downs of a long decline are in the swings table.";
const SIZES =
  "Falls of at least 10% and 20% below the 52-week high (choose the size of the last-dips table below).";
const LEGS_CAPTION =
  "A bounce is not a recovery of the old high; the last fall may still be going, so it is shown as open. Median depth is measured to the lowest close before the X% bounce, so it is deeper than X.";
const NEEDS_YEAR = "Needs about a year of prices (252 trading days).";
const DIPS_TITLE = "Dips from the 52-week high";
const SWINGS_TITLE = "Swings (fall then bounce)";

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
function why(
  code: string | null | undefined,
  n: number | null | undefined,
  what: string,
  min: number,
): string {
  if (code === "too_few_episodes") {
    const noun = n === 1 ? what.replace(/s$/, "") : what;
    return `only ${count(n ?? 0)} ${noun}; at least ${count(min)} are needed`;
  }
  if (code === "no_dips") return "no dip of this size in the history";
  if (code === "no_open_dip") return "none is open";
  if (code === "open_dip") return "not recovered yet";
  if (code === "superseded") return "not regained within a year";
  return invReason(code);
}

/** The reason a figure is blank, or null when it is known (a pure function of the row). */
function blank(
  value: number | null | undefined,
  code: string | null | undefined,
  n: number | null | undefined,
  what: string,
  min: number,
): string | null {
  if (typeof value === "number") return null;
  return code ? why(code, n, what, min) : "no figure";
}

/** The visible list of why some cells are blank (phones have no hover). */
export function swingReasons(s: SwingDips): string[] {
  const min = s.min_episodes ?? DEFAULT_MIN;
  const out: string[] = [];
  for (const r of s.thresholds) {
    const label = `${count(r.threshold_pct)}% fall`;
    if (r.reason === "insufficient_history") {
      out.push(`${label}: ${NEEDS_YEAR}`);
      continue;
    }
    const cells: Array<string | null> = [
      blank(r.recovered_share_pct, r.recovered_share_reason, r.dips, "dips", min),
      blank(r.median_depth_pct, r.median_depth_reason, r.dips, "dips", min),
      blank(r.worst_depth_pct, r.worst_depth_reason, r.dips, "dips", min),
      blank(r.median_days_peak_to_low, r.median_days_peak_to_low_reason, r.dips, "dips", min),
      blank(
        r.median_days_to_recover,
        r.median_days_to_recover_reason,
        r.recovered,
        "recovered dips",
        min,
      ),
      blank(r.longest_open_days, r.longest_open_reason, null, "", min),
    ];
    for (const c of cells) if (c) out.push(`${label}: ${c}`);
  }
  for (const r of s.zigzag) {
    const label = `${count(r.threshold_pct)}% swings`;
    if (r.reason === "insufficient_history") continue;
    const cells: Array<string | null> = [
      blank(r.median_depth_pct, r.median_depth_reason, r.legs, "swings", min),
      blank(r.worst_depth_pct, r.worst_depth_reason, r.legs, "swings", min),
      blank(r.median_days_peak_to_low, r.median_days_peak_to_low_reason, r.legs, "swings", min),
      blank(
        r.median_days_to_bounce,
        r.median_days_to_bounce_reason,
        r.bounced,
        "bounced swings",
        min,
      ),
    ];
    for (const c of cells) if (c) out.push(`${label}: ${c}`);
  }
  return out;
}

const HEAD_DIPS = [
  "Fall of at least",
  "Dips",
  "Recovered",
  "Not regained within a year",
  "Still open",
  "Recovered share",
  "Median depth (open dip so far included)",
  "Worst depth",
  "Median days peak to low (open dip so far included)",
  "Median days to recover (recovered dips only)",
  "Open for (days since peak)",
];

function SwingTable({ rows, min }: { rows: SwingDipRow[]; min: number }) {
  return (
    <div
      className={scrollRegion}
      tabIndex={0}
      role="region"
      aria-label="Dips from the 52-week high by size of fall, scrollable"
    >
      <table className="w-full" data-testid="inv-swing-table">
        <caption className="sr-only">
          Dips from the 52-week high of at least 10% and 20%: dips, recovered, not regained within a
          year, still open, shares and medians
        </caption>
        <thead>
          <tr>
            {HEAD_DIPS.map((h) => (
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
                <tr key={r.threshold_pct} data-testid={`inv-swing-row-${r.threshold_pct}`}>
                  <th scope="row" className={`${th} border-t border-border`}>
                    {label}
                  </th>
                  <td className={`${td} text-left`} colSpan={10}>
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
            ) => <Cell text={text(value)} reason={blank(value, code, n, what, min)} />;
            return (
              <tr key={r.threshold_pct} data-testid={`inv-swing-row-${r.threshold_pct}`}>
                <th scope="row" className={`${th} border-t border-border`}>
                  {label}
                </th>
                <td className={td}>{count(r.dips)}</td>
                <td className={td}>{count(r.recovered)}</td>
                <td className={td} data-testid={`inv-swing-superseded-count-${r.threshold_pct}`}>
                  {count(r.superseded)}
                </td>
                <td className={td} data-testid={`inv-swing-open-count-${r.threshold_pct}`}>
                  {count(r.open)}
                </td>
                <td className={td}>
                  {cell(r.recovered_share_pct, r.recovered_share_reason, r.dips, "dips", (v) =>
                    pct(v),
                  )}
                </td>
                <td className={td}>
                  {cell(r.median_depth_pct, r.median_depth_reason, r.dips, "dips", (v) =>
                    pct(v, true),
                  )}
                </td>
                <td className={td}>
                  {cell(r.worst_depth_pct, r.worst_depth_reason, r.dips, "dips", (v) =>
                    pct(v, true),
                  )}
                </td>
                <td className={td}>
                  {cell(
                    r.median_days_peak_to_low,
                    r.median_days_peak_to_low_reason,
                    r.dips,
                    "dips",
                    medDays,
                  )}
                </td>
                <td className={td}>
                  {cell(
                    r.median_days_to_recover,
                    r.median_days_to_recover_reason,
                    r.recovered,
                    "recovered dips",
                    medDays,
                  )}
                </td>
                <td className={td}>
                  {cell(r.longest_open_days, r.longest_open_reason, null, "", days)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const chip =
  "inline-flex items-center rounded-chip border bg-surface-2 px-2 py-0.5 text-micro text-text-1";

function RecordRow({ r, openDays }: { r: SwingRecord; openDays: number | null | undefined }) {
  return (
    <tr data-testid="inv-swing-record" data-status={r.status ?? "unknown"}>
      <td className={`${td} text-left`}>
        {date(r.peak_date)}
        <span className="block text-micro text-text-2">{price(r.peak_close)}</span>
      </td>
      <td className={`${td} text-left`}>
        {date(r.low_date)}
        <span className="block text-micro text-text-2">{price(r.low_close)}</span>
      </td>
      <td className={td}>{pct(r.depth_pct, true)}</td>
      <td className={td}>{days(r.days_peak_to_low)}</td>
      <td className={`${td} text-left`}>
        {r.status === "open" ? (
          <>
            <span data-testid="inv-swing-open" className={`${chip} border-warn`}>
              Open
            </span>
            <span className="block text-micro text-text-2">
              {typeof openDays === "number"
                ? `not recovered yet (open for ${count(openDays)} days since the peak)`
                : "not recovered yet"}
            </span>
          </>
        ) : r.status === "superseded" ? (
          <>
            <span data-testid="inv-swing-superseded" className={`${chip} border-border`}>
              Not regained within a year
            </span>
            <span className="block text-micro text-text-2">
              {`reference peak ${date(r.peak_date)} is older than a year`}
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
                {["Peak", "Low", "Depth", "Days to low", "Outcome"].map((h) => (
                  <th key={h} scope="col" className={th}>
                    {h}
                  </th>
                ))}
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

const HEAD_LEGS = [
  "Fall and bounce of",
  "Swings",
  "Bounced",
  "Still open",
  "Median depth",
  "Worst depth",
  "Median days peak to low",
  "Median days low to bounce (completed only)",
];

function LegsTable({ rows, min }: { rows: SwingLegRow[]; min: number }) {
  if (rows.length === 0) return null;
  return (
    <div className="flex flex-col gap-2" data-testid="inv-swing-legs">
      <h4 className="text-body-sm font-medium text-text-1">
        {`${SWINGS_TITLE}: a fall of X% followed by a bounce of X%`}
      </h4>
      <div
        className={scrollRegion}
        tabIndex={0}
        role="region"
        aria-label="Swings by size, scrollable"
      >
        <table className="w-full" data-testid="inv-swing-legs-table">
          <caption className="sr-only">{LEGS_CAPTION}</caption>
          <thead>
            <tr>
              {HEAD_LEGS.map((h) => (
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
              ) => <Cell text={text(value)} reason={blank(value, code, n, what, min)} />;
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
  const min = s.min_episodes ?? DEFAULT_MIN;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-body-sm text-text-1" data-testid="inv-swing-differs">
        {DIFFERS}
      </p>
      <p className="text-caption text-text-2" data-testid="inv-swing-sizes">
        {SIZES}
      </p>
      <h4 className="text-body-sm font-medium text-text-1">{DIPS_TITLE}</h4>
      <SwingTable rows={s.thresholds} min={min} />
      <RecordsTable rows={s.thresholds} />
      <LegsTable rows={s.zigzag} min={min} />
      <Reasons items={swingReasons(s)} testId="inv-swing-reasons" />
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
            weeks up to that day. It ends when the price is back at that earlier high (recovered),
            or when that high is more than a year old and still not regained (not regained within a
            year); then a new dip can start from the new 52-week high. Falls that have not ended are
            counted as open.
          </p>
          <p>
            Median days to recover use only recovered dips, so they understate the wait for a stock
            that stays down. Days are calendar days between price dates. Swings count every fall of
            that size followed by an equal bounce, a different question from recovery.
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
