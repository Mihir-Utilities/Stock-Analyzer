"use client";

import { Banner } from "@/components/ui/banners";
import { Card } from "@/components/ui/Card";
import { Stat } from "@/components/ui/Stat";
import { getDefinition } from "@/lib/definitions";
import { asOfText } from "@/lib/dashboard/state";
import { DASH, formatDate, type Formatted } from "@/lib/format";
import type { BreakdownRow, ReadView, ViewSummary } from "@/lib/portfolio/mf-schemas";
import type { PortfolioView } from "@/lib/portfolio/view";
import {
  ALL_VIEW_SOURCE,
  BASIS_LINE,
  benchmarkDeltaText,
  inr,
  MF_NAV_SOURCE,
  MF_VIEW_SOURCE,
  NO_AVERAGE_FOOTNOTE,
  NOT_ADD_UP_SENTENCE,
  pct,
  PORTFOLIO_SOURCE,
  PRICE_RETURN_LABEL,
  reasonText,
  TOTAL_RETURN_LABEL,
  UNDER_ONE_YEAR_COPY,
  unpricedNames,
  valueUnavailable,
} from "./text";

const SOURCE: Record<PortfolioView, string> = {
  all: ALL_VIEW_SOURCE,
  equity: PORTFOLIO_SOURCE,
  mf: MF_VIEW_SOURCE,
};

/** Dash plus tooltip reason for an unknown cell; the known text otherwise. */
export function Cell({ f }: { f: Formatted }) {
  return f.reason === null ? (
    <>{f.text}</>
  ) : (
    <span title={f.reason} data-testid="cell-unknown">
      {f.text}
    </span>
  );
}

const CLASS_LABEL: Record<string, string> = {
  equity: `Stocks (${PRICE_RETURN_LABEL})`,
  mf: `Mutual funds (${TOTAL_RETURN_LABEL})`,
};

/** XIRR, or the absolute return when the span is under one year (never an annualised number then). */
function returnCell(r: {
  xirr_pct?: number | null | undefined;
  xirr_reason?: string | null | undefined;
  absolute_return_pct?: number | null | undefined;
}): { f: Formatted; label: string; under: boolean } {
  if (r.xirr_reason === "under_one_year") {
    return {
      f: pct(r.absolute_return_pct, true, reasonText(r.xirr_reason)),
      label: "Absolute return",
      under: true,
    };
  }
  return {
    f: pct(r.xirr_pct, false, reasonText(r.xirr_reason) ?? "not available"),
    label: "XIRR",
    under: false,
  };
}

function BreakdownTable({ rows }: { rows: BreakdownRow[] }) {
  return (
    <section
      aria-labelledby="pf-breakdown-h"
      data-testid="pf-breakdown"
      className="flex flex-col gap-2"
    >
      <h2 id="pf-breakdown-h" className="text-lead font-semibold">
        Breakdown by asset class
      </h2>
      <div className="overflow-x-auto" role="region" aria-label="Breakdown table" tabIndex={0}>
        <table className="w-full min-w-[40rem] text-body-sm" data-testid="pf-breakdown-table">
          <caption className="sr-only">Equity and mutual funds, each with its own figures</caption>
          <thead>
            <tr className="text-left text-caption text-text-2">
              {[
                "Asset class",
                "Invested",
                "Value",
                "Unrealized P&L",
                "Realized P&L",
                "IDCW income",
                "XIRR or absolute return",
                "As of",
              ].map((h) => (
                <th key={h} scope="col" className="p-2 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const rc = returnCell(r);
              return (
                <tr
                  key={r.asset_class}
                  data-testid={`pf-breakdown-row-${r.asset_class}`}
                  className="border-t border-border"
                >
                  <td className="p-2">{CLASS_LABEL[r.asset_class] ?? r.asset_class}</td>
                  <td className="num p-2">
                    <Cell f={inr(r.invested)} />
                  </td>
                  <td className="num p-2">
                    <Cell
                      f={
                        r.market_value === null || r.market_value === undefined
                          ? {
                              text: DASH,
                              reason: valueUnavailable(r.market_value_reason),
                              direction: "flat",
                            }
                          : inr(r.market_value)
                      }
                    />
                  </td>
                  <td className="num p-2">
                    <Cell
                      f={inr(r.unrealized_pnl, {
                        signed: true,
                        reason: "needs a price or NAV for every holding",
                      })}
                    />
                  </td>
                  <td className="num p-2">
                    <Cell f={inr(r.realized_pnl, { signed: true })} />
                  </td>
                  <td className="num p-2">
                    {r.asset_class === "mf" ? (
                      <Cell f={inr(r.idcw_income, { signed: true })} />
                    ) : (
                      <span title="IDCW income applies to mutual funds only">{DASH}</span>
                    )}
                  </td>
                  <td className="num p-2">
                    <Cell f={rc.f} />
                    {rc.under ? (
                      <span
                        data-testid={`pf-breakdown-under-year-${r.asset_class}`}
                        className="ml-1 rounded-chip border border-border px-1 text-micro text-text-2"
                      >
                        absolute return, under 1 year
                      </span>
                    ) : null}
                  </td>
                  <td className="p-2">{asOfText(r.as_of) ?? "unknown"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-caption text-text-2" data-testid="pf-breakdown-footnote">
        {NO_AVERAGE_FOOTNOTE}
      </p>
    </section>
  );
}

export interface ViewCardsProps {
  s: ViewSummary;
  read: ReadView;
  view: PortfolioView;
  asOf: string | null;
  stale: boolean;
  /** Oldest NAV date among stale MF holdings, for the card chip; null when none is stale. */
  staleNavDate: string | null;
}

/**
 * Summary cards of the selected view (docs/06 6.7a). Every number comes from the API; nothing is
 * summed or annualised here. A card without a value shows a dash and its reason.
 */
export function ViewCards({ s, read, view, asOf, stale, staleNavDate }: ViewCardsProps) {
  const t = s.totals;
  const source = SOURCE[view];
  const common = { source, asOf } as const;
  const hasMf = view !== "equity";
  const unpriced = unpricedNames(t.market_value_reason);
  const valueKnown = typeof t.market_value === "string";
  const valueReason = valueKnown ? undefined : valueUnavailable(t.market_value_reason);
  const unrealized = pct(t.unrealized_pct, true);
  const rc = returnCell(s.returns);
  const absLine = pct(s.returns.absolute_return_pct, true);
  const bench = s.benchmark;
  const benchPct = pct(bench?.xirr_pct);
  const legacyXirr = s.returns.xirr_pct;
  const diff =
    view === "equity" && typeof legacyXirr === "number" && typeof bench?.xirr_pct === "number"
      ? legacyXirr - bench.xirr_pct
      : null;
  const partial = unpriced.length > 0 || read.unreadable.length > 0 || read.badRows > 0;
  const partialMessage = [
    unpriced.length > 0 ? valueUnavailable(t.market_value_reason) : "",
    read.unreadable.length > 0 ? `Could not read: ${read.unreadable.join(", ")}.` : "",
    read.badRows > 0 ? `${read.badRows} rows could not be read and are left out.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const bd = read.breakdown;
  const dayParts =
    view === "all" && bd.length > 0
      ? bd
          .map(
            (r) =>
              `${r.asset_class === "mf" ? "Mutual funds (NAV)" : "Stocks (close)"} as of ${asOfText(r.as_of) ?? "unknown"}`,
          )
          .join("; ")
      : null;
  const staleChip =
    hasMf && staleNavDate !== null ? (
      <span
        data-testid="pf-nav-stale-chip"
        className="inline-flex items-center rounded-chip border border-warn bg-surface-2 px-2 py-0.5 text-micro text-text-1"
      >
        NAV as of {formatDate(staleNavDate).text} (stale)
      </span>
    ) : null;
  const total = t.total_pnl;

  return (
    <>
      <Card
        title="Summary"
        state={partial ? "partial" : stale ? "stale" : "ready"}
        message={partialMessage}
        stale={stale}
        source={source}
        asOf={asOf}
        actions={staleChip}
        testId="pf-summary"
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div data-testid="pf-card-invested">
            <Stat
              label="Invested"
              value={t.invested ? inr(t.invested).text : null}
              nullReason="not available"
              definition="Cost of the units or shares you still hold (money spent on the ones you sold is not included)."
              {...common}
            />
          </div>
          <div data-testid="pf-card-value">
            <Stat
              label="Current value"
              value={valueKnown ? inr(t.market_value).text : null}
              nullReason={valueReason ?? "no price available"}
              {...common}
            />
          </div>
          <div data-testid="pf-card-unrealized">
            <Stat
              label="Unrealized P&L"
              value={
                typeof t.unrealized_pnl === "string"
                  ? inr(t.unrealized_pnl, { signed: true }).text
                  : null
              }
              nullReason={valueReason ?? "no price available"}
              delta={{
                value: t.unrealized_pct ?? null,
                text: unrealized.reason === null ? unrealized.text : null,
              }}
              definition="Market value minus invested. An estimate until sold."
              {...common}
            />
          </div>
          <div data-testid="pf-card-realized">
            <Stat
              label="Realized P&L"
              value={
                typeof t.realized_pnl === "string"
                  ? inr(t.realized_pnl, { signed: true }).text
                  : null
              }
              nullReason="not available"
              definition="Profit or loss on units or shares you sold, first-in first-out, after fees. Includes fully sold positions."
              {...common}
            />
          </div>
          {hasMf ? (
            <div data-testid="pf-card-idcw-income">
              <Stat
                label="IDCW income"
                value={
                  typeof t.idcw_income === "string"
                    ? inr(t.idcw_income, { signed: true }).text
                    : null
                }
                nullReason="not available"
                definition="Payouts and reinvested dividends from IDCW plans, from your transactions. Kept apart from realized and unrealized P&L."
                {...common}
              />
            </div>
          ) : null}
          <div data-testid="pf-card-day-change">
            <Stat
              label="Day change"
              value={
                typeof t.day_change === "string" ? inr(t.day_change, { signed: true }).text : null
              }
              nullReason={reasonText(t.day_change_reason) ?? "no earlier close"}
              {...common}
            />
          </div>
          {rc.under ? (
            <div data-testid="pf-card-absolute-return">
              <Stat
                label="Absolute return"
                value={rc.f.reason === null ? rc.f.text : null}
                nullReason={rc.f.reason ?? "not available"}
                definition={getDefinition("absolute_return").text}
                {...common}
              />
              <p className="mt-1 text-micro text-text-2" data-testid="pf-card-absolute-return-note">
                {UNDER_ONE_YEAR_COPY}
                {s.returns.span_days !== null && s.returns.span_days !== undefined
                  ? ` (${s.returns.span_days} days since ${formatDate(s.returns.first_flow_date).text}.)`
                  : ""}
              </p>
            </div>
          ) : (
            <div data-testid="pf-card-xirr">
              <Stat
                label="XIRR"
                value={rc.f.reason === null ? rc.f.text : null}
                nullReason={
                  (reasonText(s.returns.xirr_reason) ?? "not available") +
                  (absLine.reason === null
                    ? `. Absolute return ${absLine.text} (simple, not annualised)`
                    : "")
                }
                definition={
                  view === "all" ? getDefinition("xirr_pooled").text : getDefinition("xirr").text
                }
                {...common}
              />
              {rc.f.reason === null && absLine.reason === null ? (
                <p className="mt-1 text-micro text-text-2" data-testid="pf-card-xirr-abs">
                  Absolute return {absLine.text} (simple, not annualised)
                  {s.returns.span_days !== null && s.returns.span_days !== undefined
                    ? `, over ${s.returns.span_days} days since ${formatDate(s.returns.first_flow_date).text}`
                    : ""}
                  .
                </p>
              ) : null}
            </div>
          )}
          {view === "equity" ? (
            <div data-testid="pf-card-benchmark">
              <Stat
                label="vs Nifty 50"
                value={benchPct.reason === null ? `${benchPct.text} Nifty 50 XIRR` : null}
                nullReason={reasonText(bench?.reason) ?? "no benchmark series"}
                delta={
                  diff === null
                    ? { value: null, text: null }
                    : { value: diff, text: benchmarkDeltaText(diff) }
                }
                definition={bench?.note ?? undefined}
                source="Nifty 50 price index, imported"
                asOf={bench?.level_as_of ? asOfText(bench.level_as_of) : null}
              />
            </div>
          ) : null}
        </div>
        {t.unrealized_pct === null || t.unrealized_pct === undefined ? (
          t.unrealized_pct_reason ? (
            <p className="mt-3 text-caption text-text-2" data-testid="pf-unrealized-pct-reason">
              Unrealized %: {DASH} {reasonText(t.unrealized_pct_reason) ?? t.unrealized_pct_reason}
            </p>
          ) : null
        ) : null}
        {total !== null && total !== undefined ? (
          <p className="mt-3 text-caption text-text-2" data-testid="pf-card-total-pnl">
            For reference only, unrealized + realized{hasMf ? " + IDCW income" : ""} added up:{" "}
            {inr(total, { signed: true }).text}. Each part has its own card above.
          </p>
        ) : (
          <p className="mt-3 text-caption text-text-2" data-testid="pf-card-total-pnl">
            Total P&amp;L: {DASH}{" "}
            {t.total_pnl_reason
              ? valueUnavailable(t.total_pnl_reason)
              : "Needs a price or NAV for every holding."}
          </p>
        )}
        <p className="mt-1 text-caption text-text-2" data-testid="pf-purchase-cash">
          Money put in (purchases including charges, the base of the absolute return):{" "}
          {t.purchase_cash ? inr(t.purchase_cash).text : DASH}.
        </p>
        {dayParts ? (
          <p className="mt-1 text-caption text-text-2" data-testid="pf-day-parts">
            Day change parts: {dayParts}.
          </p>
        ) : null}
        {view === "all" ? (
          <div className="mt-3 flex flex-col gap-1 text-caption text-text-2">
            <p data-testid="pf-basis-line">{BASIS_LINE}</p>
            <p data-testid="pf-not-add-up">{NOT_ADD_UP_SENTENCE}</p>
            <p data-testid="pf-mixed-source">
              Figures in this view mix sources: {MF_NAV_SOURCE} for mutual funds, your imported
              prices for stocks.
            </p>
          </div>
        ) : null}
        {view === "mf" ? (
          <p className="mt-3 text-caption text-text-2" data-testid="pf-basis-line">
            Mutual fund figures are {TOTAL_RETURN_LABEL}. Units and amounts are from your statement
            or entries; value uses {MF_NAV_SOURCE}.
          </p>
        ) : null}
        {view === "equity" ? (
          <p className="mt-3 text-caption text-text-2" data-testid="pf-basis-line">
            Stock figures are {PRICE_RETURN_LABEL}.
          </p>
        ) : null}
      </Card>
      {partial && unpriced.length > 0 ? (
        <Banner tone="info" testId="pf-unpriced-banner">
          No price or NAV yet for: {unpriced.join(", ")}. Totals that need them show a dash instead
          of a partial sum.
        </Banner>
      ) : null}
      {view === "all" && bd.length > 0 ? <BreakdownTable rows={bd} /> : null}
    </>
  );
}
