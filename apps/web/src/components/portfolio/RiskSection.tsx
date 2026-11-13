"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChartFrame } from "@/components/charts/ChartFrame";
import type { ChartDataset } from "@/components/charts/chart-data";
import { Card } from "@/components/ui/Card";
import { DefinitionTip } from "@/components/ui/DefinitionTip";
import { asOfText, describeError } from "@/lib/dashboard/state";
import { formatCount, formatDate, formatInr, formatNumber, formatPercent } from "@/lib/format";
import { usePortfolioRisk } from "@/lib/portfolio/risk-api";
import {
  readRisk,
  type Gap,
  type GroupWeight,
  type HoldingWeight,
  type ReadRisk,
  type StressItem,
} from "@/lib/portfolio/risk-schemas";
import {
  HISTORY_HOWTO,
  NOT_RECOVERED,
  NOTHING_YET,
  RISK_FUNDS_NOTE,
  RISK_NOTE,
  RISK_PAST_NOTE,
  RISK_SOURCE,
  STRESS_LABEL,
  UNCLASSIFIED_HINT,
  UNREADABLE,
  riskReason,
  weightsUnavailable,
} from "@/lib/portfolio/risk-text";
import { VIEW_LABEL, type PortfolioView } from "@/lib/portfolio/view";
import { inr } from "./text";

// The Portfolio risk section of /portfolio (docs/06 6.7b): concentration, position stress and the
// time-weighted value history with drawdown. It reads only GET /portfolio/risk?view= and computes
// nothing: weights, impacts, the index and the drawdown all come from the server. Facts only: no
// verdict, no forecast, and no colour that says good or bad.

const scrollRegion = "relative overflow-x-auto rounded-control border border-border";
const th = "px-2 py-1 text-left text-caption font-medium text-text-2";
const thNum = "px-2 py-1 text-right text-caption font-medium text-text-2";
const td = "border-t border-border px-2 py-1 text-left text-body-sm text-text-1";
const tdNum = "num border-t border-border px-2 py-1 text-right text-body-sm text-text-1";

/** An unknown value: an em dash with the reason as a tooltip and as text a screen reader can read. */
function Blank({ reason }: { reason: string }) {
  return (
    <span title={reason}>
      {"—"}
      <span className="sr-only">{` (${reason})`}</span>
    </span>
  );
}

function Value({ text, reason }: { text: string; reason: string | null }) {
  return reason === null ? <>{text}</> : <Blank reason={reason} />;
}

function Tile({
  label,
  text,
  reason,
  sub,
  testId,
}: {
  label: string;
  text: string;
  reason: string | null;
  sub?: string;
  testId: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5" data-testid={testId}>
      <dt className="text-caption text-text-2">{label}</dt>
      <dd className="num text-section font-semibold text-text-1">
        <Value text={text} reason={reason} />
      </dd>
      {sub && reason === null ? <dd className="text-micro text-text-2">{sub}</dd> : null}
      {reason !== null ? <dd className="text-micro text-text-2">{reason}</dd> : null}
    </div>
  );
}

const pctText = (v: number | null | undefined, signed = false) =>
  formatPercent(v, signed ? { signed: true } : {});

/** Holdings label: stocks by symbol, funds by name (scheme codes mean little to a reader). */
const label = (h: { key: string; name: string; asset_class: string }) =>
  h.asset_class === "mf" && h.name !== "" ? h.name : h.key;

function groupText(g: string): string {
  return g === "Unclassified" ? `Unclassified (${UNCLASSIFIED_HINT.toLowerCase()})` : g;
}

function Concentration({
  c,
  asOf,
  stale,
}: {
  c: NonNullable<ReadRisk["concentration"]>;
  asOf: string | null;
  stale: boolean;
}) {
  const reason = riskReason(c.shares_reason ?? c.total_value_reason);
  const count = c.holdings_count ?? c.rows.length;
  const of = `of ${formatCount(count).text} ${count === 1 ? "holding" : "holdings"}`;
  const empty = c.rows.length === 0;
  const TOP = 15;
  const shown = c.rows.filter((r) => r.weight_pct !== null && r.weight_pct !== undefined);
  const chartRows = shown.slice(0, TOP);
  const dataset: ChartDataset = {
    xName: "Holding",
    x: chartRows.map(label),
    series: [
      {
        id: "weight",
        name: "Share of portfolio value",
        unit: "%",
        kind: "bar",
        values: chartRows.map((r) => r.weight_pct ?? null),
        format: (v) => formatPercent(v).text,
      },
    ],
    source: RISK_SOURCE,
    asOf,
  };
  return (
    <Card
      title="Concentration"
      info={<DefinitionTip term="pf_concentration" />}
      state={empty ? "empty" : reason !== null ? "partial" : stale ? "stale" : "ready"}
      message={empty ? NOTHING_YET : weightsUnavailable(c.shares_reason ?? c.total_value_reason)}
      source={RISK_SOURCE}
      asOf={asOf}
      stale={stale}
      testId="pf-risk-concentration"
    >
      <div className="flex flex-col gap-4">
        <dl className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Tile
            label="Largest holding"
            text={pctText(c.top1_pct).text}
            reason={
              c.top1_pct === null || c.top1_pct === undefined ? (reason ?? "not available") : null
            }
            sub={of}
            testId="pf-risk-top1"
          />
          <Tile
            label="Largest 3"
            text={pctText(c.top3_pct).text}
            reason={
              c.top3_pct === null || c.top3_pct === undefined ? (reason ?? "not available") : null
            }
            sub={of}
            testId="pf-risk-top3"
          />
          <Tile
            label="Largest 5"
            text={pctText(c.top5_pct).text}
            reason={
              c.top5_pct === null || c.top5_pct === undefined ? (reason ?? "not available") : null
            }
            sub={of}
            testId="pf-risk-top5"
          />
          <Tile
            label="Effective number of holdings"
            text={formatNumber(c.effective_holdings, { decimals: 1 }).text}
            reason={
              c.effective_holdings === null || c.effective_holdings === undefined
                ? (riskReason(c.hhi_reason ?? c.total_value_reason) ?? "not available")
                : null
            }
            sub="equal-sized holdings that would spread your money the same way"
            testId="pf-risk-effective"
          />
        </dl>
        <p className="text-caption text-text-2">
          <span data-testid="pf-risk-count">{formatCount(count).text}</span>{" "}
          {count === 1 ? "open holding" : "open holdings"}; total value{" "}
          <span data-testid="pf-risk-total">
            {c.total_value ? inr(c.total_value).text : "unavailable"}
          </span>
          ; concentration index (sum of squared shares){" "}
          <span data-testid="pf-risk-hhi">
            {c.hhi === null || c.hhi === undefined
              ? "unavailable"
              : formatNumber(c.hhi, { decimals: 3 }).text}
          </span>
          <DefinitionTip term="pf_hhi" />
          {reason !== null ? (
            <span className="block text-text-2" data-testid="pf-risk-reason">
              {weightsUnavailable(c.shares_reason ?? c.total_value_reason)}
            </span>
          ) : null}
        </p>
        {empty ? null : (
          <>
            <ChartFrame
              title={`Share of portfolio value by holding${shown.length > TOP ? ` (largest ${TOP} of ${shown.length})` : ""}`}
              testId="pf-risk-weights-chart"
              dataset={dataset}
              state={chartRows.length === 0 ? "empty" : "ready"}
              message={weightsUnavailable(c.shares_reason ?? c.total_value_reason)}
              height={Math.max(220, 28 * chartRows.length + 90)}
              filename="portfolio-weights"
            />
            <WeightsTable rows={c.rows} />
            <GroupsTable
              groups={c.groups}
              hhi={c.group_hhi ?? null}
              top1={c.group_top1_pct ?? null}
              reason={riskReason(c.group_reason)}
            />
          </>
        )}
        {c.bad > 0 ? (
          <p className="text-caption text-text-2" role="note">
            {c.bad} {c.bad === 1 ? "row" : "rows"} could not be read and{" "}
            {c.bad === 1 ? "is" : "are"} left out.
          </p>
        ) : null}
      </div>
    </Card>
  );
}

function WeightsTable({ rows }: { rows: HoldingWeight[] }) {
  return (
    <div
      role="region"
      aria-label="Holdings by share of portfolio value"
      tabIndex={0}
      className={scrollRegion}
      data-testid="pf-risk-weights-table"
    >
      <table className="w-full min-w-[28rem] border-collapse">
        <caption className="sr-only">Holdings by share of portfolio value, largest first</caption>
        <thead>
          <tr>
            <th scope="col" className={th}>
              Holding
            </th>
            <th scope="col" className={th}>
              Group
            </th>
            <th scope="col" className={thNum}>
              Value
            </th>
            <th scope="col" className={thNum}>
              Share
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const reason =
              r.weight_pct === null || r.weight_pct === undefined
                ? (riskReason(r.weight_reason) ?? "not available")
                : null;
            return (
              <tr key={`${r.asset_class}-${r.key}`} data-testid={`pf-risk-weight-row-${r.key}`}>
                <th scope="row" className={`${td} font-medium`}>
                  {label(r)}
                </th>
                <td className={td}>{groupText(r.group)}</td>
                <td className={tdNum}>{r.value ? inr(r.value).text : "unavailable"}</td>
                <td className={tdNum}>
                  <Value text={pctText(r.weight_pct).text} reason={reason} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const KIND: Record<string, string> = {
  sector: "sector",
  category: "fund category",
  mutual_funds: "all funds",
  unclassified: "no sector imported",
};

function GroupsTable({
  groups,
  hhi,
  top1,
  reason,
}: {
  groups: GroupWeight[];
  hhi: number | null;
  top1: number | null;
  reason: string | null;
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-caption text-text-2" data-testid="pf-risk-group-summary">
        By sector or category: largest group{" "}
        <Value
          text={pctText(top1).text}
          reason={top1 === null ? (reason ?? "not available") : null}
        />
        ; concentration index of the groups{" "}
        <Value
          text={formatNumber(hhi, { decimals: 3 }).text}
          reason={hhi === null ? (reason ?? "not available") : null}
        />
        .
      </p>
      <div
        role="region"
        aria-label="Groups by share of portfolio value"
        tabIndex={0}
        className={scrollRegion}
        data-testid="pf-risk-groups-table"
      >
        <table className="w-full min-w-[24rem] border-collapse">
          <caption className="sr-only">Sectors or categories by share of portfolio value</caption>
          <thead>
            <tr>
              <th scope="col" className={th}>
                Group
              </th>
              <th scope="col" className={th}>
                Kind
              </th>
              <th scope="col" className={thNum}>
                Holdings
              </th>
              <th scope="col" className={thNum}>
                Value
              </th>
              <th scope="col" className={thNum}>
                Share
              </th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.key} data-testid={`pf-risk-group-row-${g.key}`}>
                <th scope="row" className={`${td} font-medium`}>
                  {g.key}
                </th>
                <td className={td}>{KIND[g.kind] ?? g.kind}</td>
                <td className={tdNum}>{formatCount(g.holdings).text}</td>
                <td className={tdNum}>
                  {g.value ? (
                    inr(g.value).text
                  ) : (
                    <Blank reason={reason ?? "contains a holding without a price"} />
                  )}
                </td>
                <td className={tdNum}>
                  <Value
                    text={pctText(g.weight_pct).text}
                    reason={
                      g.weight_pct === null || g.weight_pct === undefined
                        ? (reason ?? "not available")
                        : null
                    }
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stress({ st, asOf }: { st: NonNullable<ReadRisk["stress"]>; asOf: string | null }) {
  const falls = st.falls_pct && st.falls_pct.length === 2 ? st.falls_pct : [10, 20];
  const reasons = st.rows
    .map((r) => riskReason(r.impact_reason))
    .filter((r): r is string => r !== null);
  return (
    <Card
      title="Position stress (what if)"
      info={<DefinitionTip term="pf_stress" />}
      state={st.rows.length === 0 ? "empty" : "ready"}
      message={NOTHING_YET}
      source="Arithmetic on your current values; not a forecast"
      asOf={asOf}
      testId="pf-risk-stress"
    >
      <p className="mb-2 text-body-sm text-text-2" data-testid="pf-risk-stress-label">
        {st.label && st.label !== "" ? st.label : STRESS_LABEL}
      </p>
      <div
        role="region"
        aria-label="What a fall in one holding would do to the portfolio"
        tabIndex={0}
        className={scrollRegion}
        data-testid="pf-risk-stress-table"
      >
        <table className="w-full min-w-[34rem] border-collapse">
          <caption className="sr-only">
            Change in portfolio value if only this holding fell by {falls[0]}% or {falls[1]}%
          </caption>
          <thead>
            <tr>
              <th scope="col" className={th}>
                Holding
              </th>
              <th scope="col" className={thNum}>
                Value
              </th>
              <th scope="col" className={thNum}>
                If it fell {falls[0]}%
              </th>
              <th scope="col" className={thNum}>
                of portfolio
              </th>
              <th scope="col" className={thNum}>
                If it fell {falls[1]}%
              </th>
              <th scope="col" className={thNum}>
                of portfolio
              </th>
            </tr>
          </thead>
          <tbody>
            {st.rows.map((r) => (
              <StressRow key={`${r.asset_class}-${r.key}`} r={r} />
            ))}
          </tbody>
        </table>
      </div>
      {reasons.length > 0 ? (
        <ul
          className="mt-2 list-disc pl-5 text-caption text-text-2"
          data-testid="pf-risk-stress-reason"
        >
          {[...new Set(reasons)].map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

function StressRow({ r }: { r: StressItem }) {
  const reason = riskReason(r.impact_reason) ?? "not available";
  const cell = (money: string | null | undefined) =>
    money ? <>{inr(money, { signed: true }).text}</> : <Blank reason={reason} />;
  const pc = (p: number | null | undefined) =>
    p === null || p === undefined ? <Blank reason={reason} /> : <>{pctText(p, true).text}</>;
  return (
    <tr data-testid={`pf-risk-stress-row-${r.key}`}>
      <th scope="row" className={`${td} font-medium`}>
        {label(r)}
      </th>
      <td className={tdNum}>{r.value ? inr(r.value).text : <Blank reason={reason} />}</td>
      <td className={tdNum}>{cell(r.impact_10)}</td>
      <td className={tdNum}>{pc(r.impact_10_pct)}</td>
      <td className={tdNum}>{cell(r.impact_20)}</td>
      <td className={tdNum}>{pc(r.impact_20_pct)}</td>
    </tr>
  );
}

function gapLine(g: Gap): string {
  const span =
    g.from === g.to
      ? formatDate(g.from).text
      : `${formatDate(g.from).text} to ${formatDate(g.to).text}`;
  return `No value on ${formatCount(g.dates).text} ${g.dates === 1 ? "date" : "dates"} (${span}): ${riskReason(g.reason) ?? "no price"}`;
}

function History({
  h,
  asOf,
  stale,
}: {
  h: NonNullable<ReadRisk["history"]>;
  asOf: string | null;
  stale: boolean;
}) {
  const pts = h.pointRows;
  const seriesReason = riskReason(h.series_reason);
  const ddReason = riskReason(h.drawdown_reason);
  const datasets = useMemo(() => {
    const x = pts.map((p) => p.date);
    const index: ChartDataset = {
      xName: "Date",
      x,
      panes: [
        { id: "index", name: "Return index (base 100)", unit: "index", weight: 3 },
        { id: "value", name: "Value including your deposits (INR)", unit: "INR", weight: 2 },
      ],
      series: [
        {
          id: "index",
          name: "Return index (base 100)",
          unit: "index",
          kind: "line",
          pane: 0,
          values: pts.map((p) => p.index),
          format: (v) => formatNumber(v, { decimals: 2 }).text,
        },
        {
          id: "value",
          name: "Value including your deposits",
          unit: "INR",
          kind: "area",
          pane: 1,
          values: pts.map((p) => {
            const f = Number(p.value);
            return Number.isFinite(f) ? f : null;
          }),
          format: (v) => formatInr(v).text,
        },
      ],
      source: RISK_SOURCE,
      asOf,
      zoom: true,
    };
    const dd: ChartDataset = {
      xName: "Date",
      x,
      series: [
        {
          id: "drawdown",
          name: "Below its own highest point",
          unit: "%",
          kind: "area",
          values: pts.map((p) => p.drawdown_pct),
          format: (v) => formatPercent(v).text,
        },
      ],
      source: RISK_SOURCE,
      asOf,
    };
    return { index, dd };
  }, [pts, asOf]);
  const m = h.max_drawdown;
  const empty = pts.length === 0;
  const fell = m && typeof m.depth_pct === "number" && m.depth_pct < 0;
  const current = h.current_drawdown_pct;
  return (
    <Card
      title="Value history and drawdown"
      info={<DefinitionTip term="pf_twr" />}
      state={
        empty
          ? "ready"
          : h.gapRows.length > 0 || (h.skipped_steps ?? 0) > 0
            ? "partial"
            : stale
              ? "stale"
              : "ready"
      }
      message={
        empty
          ? seriesReason
            ? `Nothing to chart: ${seriesReason}.`
            : NOTHING_YET
          : "Some dates could not be valued; they are listed below the charts."
      }
      source={RISK_SOURCE}
      asOf={asOf}
      stale={stale}
      testId="pf-risk-history"
    >
      {empty ? (
        <p className="text-body-sm text-text-2" data-testid="pf-risk-series-reason">
          {NOTHING_YET} {seriesReason ? `No history: ${seriesReason}.` : "No history yet."}
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Tile
              label="Below its highest point now"
              text={pctText(current).text}
              reason={
                current === null || current === undefined ? (ddReason ?? "not available") : null
              }
              sub={h.peak_date ? `highest point ${formatDate(h.peak_date).text}` : undefined}
              testId="pf-risk-current-dd"
            />
            <Tile
              label="Deepest fall"
              text={
                m && typeof m.depth_pct === "number"
                  ? fell
                    ? pctText(m.depth_pct).text
                    : "No fall yet"
                  : "—"
              }
              reason={m ? null : (ddReason ?? "not available")}
              sub={
                m && fell
                  ? `${formatDate(m.peak_date).text} to ${formatDate(m.trough_date).text}; ${
                      m.recovery_date
                        ? `recovered ${formatDate(m.recovery_date).text}`
                        : NOT_RECOVERED
                    }`
                  : undefined
              }
              testId="pf-risk-max-dd"
            />
            <Tile
              label="Days below its highest point"
              text={formatCount(h.days_under_water).text}
              reason={
                h.days_under_water === null || h.days_under_water === undefined
                  ? (ddReason ?? "not available")
                  : null
              }
              testId="pf-risk-underwater"
            />
          </dl>
          <p className="text-caption text-text-2">
            Return line since {formatDate(h.from).text}:{" "}
            <span data-testid="pf-risk-twr">
              <Value
                text={pctText(h.twr_since_start_pct, true).text}
                reason={
                  h.twr_since_start_pct === null || h.twr_since_start_pct === undefined
                    ? (ddReason ?? "not available")
                    : null
                }
              />
            </span>{" "}
            (price moves of what you held; money you added or took out is left out).
          </p>
          <ChartFrame
            title="Your portfolio's return line (base 100) and its value"
            testId="pf-risk-index-chart"
            dataset={datasets.index}
            height={320}
            filename="portfolio-return-index"
            info={<DefinitionTip term="pf_twr" />}
          />
          <ChartFrame
            title="How far the return line is below its own highest point"
            testId="pf-risk-drawdown-chart"
            dataset={datasets.dd}
            height={200}
            filename="portfolio-drawdown"
            info={<DefinitionTip term="pf_drawdown" />}
          />
          {ddReason !== null ? (
            <p className="text-caption text-text-2" data-testid="pf-risk-drawdown-reason">
              Drawdown figures unavailable: {ddReason}.
            </p>
          ) : null}
          <details data-testid="pf-risk-howto" className="text-body-sm text-text-2">
            <summary className="touch-target cursor-pointer text-text-1">How to read</summary>
            <p className="mt-1">{HISTORY_HOWTO}</p>
          </details>
          {h.gapRows.length > 0 ? (
            <div data-testid="pf-risk-gaps" className="text-caption text-text-2">
              <ul className="list-disc pl-5">
                {h.gapRows.map((g) => (
                  <li key={`${g.from}-${g.to}`}>{gapLine(g)}</li>
                ))}
              </ul>
              {h.gaps_truncated ? (
                <p>
                  Showing the latest {h.gapRows.length} ranges of{" "}
                  {formatCount(h.gap_dates_total).text} dates without a value.
                </p>
              ) : null}
            </div>
          ) : null}
          {(h.skipped_steps ?? 0) > 0 ? (
            <p className="text-caption text-text-2" data-testid="pf-risk-skipped">
              {formatCount(h.skipped_steps).text} price {h.skipped_steps === 1 ? "move" : "moves"}{" "}
              could not be counted because a transaction fell inside a price gap.
            </p>
          ) : null}
          {h.bad > 0 ? (
            <p className="text-caption text-text-2" role="note">
              {h.bad} {h.bad === 1 ? "point" : "points"} could not be read and{" "}
              {h.bad === 1 ? "is" : "are"} left out.
            </p>
          ) : null}
        </div>
      )}
    </Card>
  );
}

function Block({
  title,
  testId,
  children,
}: {
  title: string;
  testId: string;
  children?: ReactNode;
}) {
  return (
    <Card title={title} state="error" message={UNREADABLE} testId={testId}>
      {children}
    </Card>
  );
}

/**
 * Portfolio risk (docs/06 6.7b). `view` is the page's switcher state; the section never has a switcher
 * of its own. A view change keeps the previous answer dimmed until the next one arrives and is
 * announced in a polite live region.
 */
export function RiskSection({ view }: { view: PortfolioView }) {
  const q = usePortfolioRisk(view, true);
  const shownView = q.data?.forView ?? view;
  const read = useMemo(() => (q.data ? readRisk(q.data.data) : null), [q.data]);
  const [announce, setAnnounce] = useState("");
  const last = useRef<string>("");
  useEffect(() => {
    if (q.data && !q.isPlaceholderData && last.current !== q.data.forView) {
      if (last.current !== "")
        setAnnounce(`Portfolio risk updated for ${VIEW_LABEL[q.data.forView]}`);
      last.current = q.data.forView;
    }
  }, [q.data, q.isPlaceholderData]);

  let body: ReactNode;
  if (q.isPending) {
    body = <Card title="Portfolio risk" state="loading" testId="pf-risk-loading" />;
  } else if (q.isError) {
    const u = describeError(q.error, "Portfolio risk");
    body = (
      <Card
        title="Portfolio risk"
        state={u.state}
        message={u.message}
        onRetry={() => void q.refetch()}
        testId="pf-risk-error"
      />
    );
  } else if (read) {
    const env = q.data;
    const asOf = asOfText(env.meta?.as_of ?? read.asOf);
    const stale = env.meta?.stale === true;
    body = (
      <div
        className={`flex flex-col gap-4${q.isPlaceholderData ? " opacity-60" : ""}`}
        aria-busy={q.isPlaceholderData}
        data-testid="pf-risk-body"
        data-view={shownView}
      >
        <p className="text-caption text-text-2" data-testid="pf-risk-asof">
          {RISK_SOURCE}, as of {asOf ?? "an unknown date"}
          {read.asOf ? ` (valuation date ${formatDate(read.asOf).text})` : ""}. Amounts in INR.
        </p>
        {read.concentration ? (
          <Concentration c={read.concentration} asOf={asOf} stale={stale} />
        ) : (
          <Block title="Concentration" testId="pf-risk-concentration" />
        )}
        {read.stress ? (
          <Stress st={read.stress} asOf={asOf} />
        ) : (
          <Block title="Position stress (what if)" testId="pf-risk-stress" />
        )}
        {read.history ? (
          <History h={read.history} asOf={asOf} stale={stale} />
        ) : (
          <Block title="Value history and drawdown" testId="pf-risk-history" />
        )}
        <p className="text-caption text-text-2" data-testid="pf-risk-past-note">
          {RISK_PAST_NOTE}
          {shownView === "all" ? ` ${RISK_FUNDS_NOTE}` : ""}
        </p>
      </div>
    );
  } else {
    body = <Block title="Portfolio risk" testId="pf-risk-unreadable" />;
  }

  return (
    <section
      aria-labelledby="pf-risk-h"
      className="flex flex-col gap-3"
      data-testid="pf-risk"
      data-view={shownView}
    >
      <h2 id="pf-risk-h" className="text-lead font-semibold text-text-1">
        Portfolio risk
      </h2>
      <p className="text-body-sm text-text-2" data-testid="pf-risk-note">
        {RISK_NOTE}
      </p>
      <div role="status" aria-live="polite" className="sr-only" data-testid="pf-risk-live">
        {announce}
      </div>
      {body}
    </section>
  );
}
