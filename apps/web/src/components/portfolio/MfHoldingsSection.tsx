"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Banner } from "@/components/ui/banners";
import { InfoPopover } from "@/components/ui/overlays";
import { getDefinition } from "@/lib/definitions";
import { cx } from "@/components/ui/cx";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { apiRequest } from "@/lib/api/client";
import { DASH, formatCount, formatDate, formatNumber, type Formatted } from "@/lib/format";
import { displayNumber, qtyDecimals } from "@/lib/portfolio/decimal";
import {
  mfHoldingSchema,
  mfHoldingsResponseSchema,
  readRows,
  type MfHolding,
} from "@/lib/portfolio/mf-schemas";
import { Cell } from "./ViewCards";
import {
  inr,
  optionLabel,
  planLabel,
  MF_NAV_SOURCE,
  MF_STATEMENT_SOURCE,
  pct,
  reasonText,
  TOTAL_RETURN_LABEL,
} from "./text";

// MF holdings table (docs/06 6.7a). Everything shown comes from the API; sorting only reorders.

type SortKey = "name" | "invested" | "value" | "unrealized" | "weight" | "xirr" | "absolute";

const nullLast = (a: number | null, b: number | null, dir: number): number => {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return (a - b) * dir;
};

function sortValue(h: MfHolding, k: Exclude<SortKey, "name">): number | null {
  switch (k) {
    case "invested":
      return displayNumber(h.invested);
    case "value":
      return displayNumber(h.market_value);
    case "unrealized":
      return displayNumber(h.unrealized_pnl);
    case "weight":
      return h.weight_pct ?? null;
    case "xirr":
      return h.xirr_pct ?? null;
    case "absolute":
      return h.absolute_return_pct ?? null;
  }
}

function Chip({
  children,
  testId,
  warn = false,
}: {
  children: string;
  testId: string;
  warn?: boolean;
}) {
  return (
    <span
      data-testid={testId}
      className={cx(
        "inline-flex items-center rounded-chip border bg-surface-2 px-1.5 py-0.5 text-caption",
        warn ? "border-warn text-text-1" : "border-border text-text-2",
      )}
    >
      {children}
    </span>
  );
}

function returnOf(h: MfHolding): { f: Formatted; under: boolean } {
  if (h.xirr_reason === "under_one_year") {
    // The reason for a missing absolute return is generic: 'XIRR is shown after the first year'
    // explains why XIRR is not shown (the chip says it), not why this figure is missing.
    return { f: pct(h.absolute_return_pct, true, "absolute return not available"), under: true };
  }
  return { f: pct(h.xirr_pct, false, reasonText(h.xirr_reason) ?? "not available"), under: false };
}

function units(v: string): string {
  const d = displayNumber(v);
  return formatNumber(d, { decimals: Math.max(2, qtyDecimals(v)) }).text;
}

function Row({ h, testId }: { h: MfHolding; testId: string }) {
  const r = returnOf(h);
  const noNav = h.market_value === null || h.market_value === undefined;
  const navReason = reasonText(h.nav_reason) ?? "No NAV for this fund yet";
  const folios = h.folio ? [h.folio] : (h.folios ?? []);
  const subtitle = [h.fund_house, h.category, h.isin ? `ISIN ${h.isin}` : null]
    .filter((x): x is string => typeof x === "string" && x !== "")
    .join(" | ");
  const underText =
    h.span_days !== null && h.span_days !== undefined
      ? `under 1 year: ${formatCount(h.span_days).text} days${h.first_txn_date ? ` since ${formatDate(h.first_txn_date).text}` : ""}`
      : "under 1 year";
  return (
    <tr data-testid={testId} className="border-t border-border align-top">
      <th
        scope="row"
        className="sticky left-0 z-10 min-w-[14rem] bg-surface-1 p-2 text-left font-normal"
      >
        <Link
          href={`/mf/${h.scheme_code}`}
          data-testid={`pf-mf-link-${h.scheme_code}`}
          className="touch-target inline-flex items-center text-accent underline"
        >
          {h.scheme_name}
        </Link>
        <div className="mt-1 flex flex-wrap gap-1">
          <Chip testId="pf-mf-plan-chip">{planLabel(h.plan)}</Chip>
          <Chip testId="pf-mf-option-chip">{optionLabel(h.option)}</Chip>
          {h.option === "idcw" || (h.flags ?? []).includes("idcw") ? (
            <Chip testId="pf-mf-idcw-chip" warn>
              IDCW: returns include payouts you entered
            </Chip>
          ) : null}
          {(h.flags ?? []).includes("inactive") ? (
            <Chip testId="pf-mf-inactive-chip" warn>
              Scheme inactive
            </Chip>
          ) : null}
          {(h.flags ?? []).includes("merged_suspected") ? (
            <Chip testId="pf-mf-merged-chip" warn>
              May have been merged
            </Chip>
          ) : null}
          {h.exited ? <Chip testId="pf-mf-exited-chip">Exited</Chip> : null}
        </div>
        {subtitle ? (
          <div className="mt-1 text-caption text-text-2" data-testid="pf-mf-subtitle">
            {subtitle}
          </div>
        ) : null}
        {folios.length > 0 ? (
          <div className="mt-1 text-caption text-text-2" data-testid="pf-mf-folios">
            {folios.length === 1 ? "Folio" : "Folios"}: {folios.join(", ")}
          </div>
        ) : null}
      </th>
      <td className="num p-2">{units(h.units)}</td>
      <td className="num p-2">
        <Cell f={inr(h.avg_cost, { reason: "average cost is unknown for an exited scheme" })} />
      </td>
      <td className="num p-2">
        <Cell f={inr(h.invested)} />
      </td>
      <td className="num p-2">
        <Cell f={inr(h.nav, { reason: navReason })} />
        <div className="text-caption text-text-2" data-testid="pf-mf-nav-date">
          {h.nav_date ? `NAV as of ${formatDate(h.nav_date).text}` : DASH}
        </div>
        {noNav ? (
          <div className="text-caption text-text-2" data-testid="pf-mf-nav-reason">
            {navReason}
          </div>
        ) : null}
        {h.nav_stale ? (
          <span
            data-testid="pf-mf-stale-chip"
            className="mt-1 inline-flex items-center rounded-chip border border-warn bg-surface-2 px-1.5 py-0.5 text-caption text-text-1"
          >
            NAV as of {formatDate(h.nav_date).text} (stale)
          </span>
        ) : null}
      </td>
      <td className="num p-2">
        <Cell f={inr(h.market_value, { reason: navReason })} />
      </td>
      <td className="num p-2">
        <Cell f={inr(h.unrealized_pnl, { signed: true, reason: navReason })} />
        <div className="text-caption text-text-2">
          <Cell
            f={pct(
              h.unrealized_pct,
              true,
              h.unrealized_pct_reason
                ? (reasonText(h.unrealized_pct_reason) ?? h.unrealized_pct_reason)
                : navReason,
            )}
          />
        </div>
      </td>
      <td className="num p-2">
        <Cell f={inr(h.realized_pnl, { signed: true })} />
      </td>
      <td className="num p-2">
        <Cell f={inr(h.idcw_income, { signed: true })} />
      </td>
      <td className="num p-2">
        <Cell
          f={inr(h.day_change, {
            signed: true,
            reason: reasonText(h.day_change_reason) ?? "no earlier NAV",
          })}
        />
      </td>
      <td className="num p-2">
        <Cell f={pct(h.weight_pct, false, noNav ? navReason : "needs a NAV for every holding")} />
      </td>
      <td className="num p-2">
        <Cell f={r.f} />
        {r.under ? (
          <div>
            <Chip testId="pf-mf-under-year-chip">{underText}</Chip>
          </div>
        ) : null}
      </td>
    </tr>
  );
}

const HEADERS: Array<{
  label: string;
  sort?: SortKey;
  /** A column whose cell can be ordered by more than one figure: one button each. */
  sorts?: Array<{ key: SortKey; label: string }>;
  num?: boolean;
}> = [
  { label: "Scheme", sort: "name" },
  { label: "Units", num: true },
  { label: "Avg cost", num: true },
  { label: "Invested", sort: "invested", num: true },
  { label: "NAV", num: true },
  { label: "Value", sort: "value", num: true },
  { label: "Unrealized P&L", sort: "unrealized", num: true },
  { label: "Realized P&L", num: true },
  { label: "IDCW income", num: true },
  { label: "Day change", num: true },
  { label: "Weight", sort: "weight", num: true },
  {
    label: "XIRR or absolute return",
    sorts: [
      { key: "xirr", label: "Sort by XIRR" },
      { key: "absolute", label: "Sort by absolute return" },
    ],
    num: true,
  },
];

export interface MfTotals {
  invested: string | null | undefined;
  market_value: string | null | undefined;
  market_value_reason: string | null | undefined;
  unrealized_pnl: string | null | undefined;
  realized_pnl: string | null | undefined;
  idcw_income: string | null | undefined;
}

function useFolioRows(enabled: boolean, includeExited: boolean) {
  return useQuery({
    queryKey: ["portfolio", "mf-holdings", "folio", includeExited],
    enabled,
    queryFn: ({ signal }) =>
      apiRequest("/portfolio/mf/holdings", {
        schema: mfHoldingsResponseSchema,
        query: { group: "folio", include_exited: includeExited },
        signal,
      }),
    staleTime: 60_000,
  });
}

export function MfHoldingsSection({
  rows,
  totals,
  asOf,
  includeExited,
  onIncludeExited,
  badRows = 0,
}: {
  rows: MfHolding[];
  totals: MfTotals;
  asOf: string | null;
  includeExited: boolean;
  onIncludeExited: (v: boolean) => void;
  badRows?: number;
}) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 } | null>(null);
  const [perFolio, setPerFolio] = useState(false);
  const folio = useFolioRows(perFolio, includeExited);
  const folioRows = useMemo(
    () => (folio.data ? readRows(mfHoldingSchema, folio.data.data.items) : null),
    [folio.data],
  );
  const base = perFolio && folioRows ? folioRows.rows : rows;
  const shown = useMemo(() => {
    if (!sort) return base;
    const list = [...base];
    list.sort((a, b) =>
      sort.key === "name"
        ? a.scheme_name.localeCompare(b.scheme_name) * sort.dir
        : nullLast(sortValue(a, sort.key), sortValue(b, sort.key), sort.dir),
    );
    return list;
  }, [base, sort]);
  const unpriced = rows.filter((h) => h.market_value === null || h.market_value === undefined);
  const totalsValue =
    typeof totals.market_value === "string"
      ? inr(totals.market_value)
      : {
          text: DASH,
          reason: "Value unavailable until every fund has a NAV",
          direction: "flat" as const,
        };

  const toggleSort = (k: SortKey) =>
    setSort((s) =>
      s && s.key === k ? (s.dir === 1 ? { key: k, dir: -1 } : null) : { key: k, dir: 1 },
    );

  return (
    <section
      aria-labelledby="pf-mf-holdings-h"
      className="flex flex-col gap-2"
      data-testid="pf-mf-holdings"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="pf-mf-holdings-h" className="text-lead font-semibold">
          Mutual funds
        </h2>
        <div className="flex flex-wrap gap-4">
          <label className="touch-target inline-flex items-center gap-2 text-body-sm">
            <input
              type="checkbox"
              data-testid="pf-mf-per-folio"
              checked={perFolio}
              onChange={(e) => setPerFolio(e.target.checked)}
            />
            Show each folio
          </label>
          <label className="touch-target inline-flex items-center gap-2 text-body-sm">
            <input
              type="checkbox"
              data-testid="pf-mf-show-exited"
              checked={includeExited}
              onChange={(e) => onIncludeExited(e.target.checked)}
            />
            Show exited schemes
          </label>
        </div>
      </div>
      <p className="text-caption text-text-2" data-testid="pf-mf-note">
        Units and amounts are from {MF_STATEMENT_SOURCE}.{" "}
        <span data-testid="pf-mf-attribution">{MF_NAV_SOURCE}</span>. Figures are{" "}
        {TOTAL_RETURN_LABEL}. NAVs more than 4 days old are marked stale and still used.{" "}
        <InfoPopover label="About total return">
          {getDefinition("mf_total_return").text}
        </InfoPopover>
      </p>
      {badRows > 0 ? (
        <Banner tone="warn" testId="pf-mf-bad-rows">
          {badRows} holding rows could not be read and are left out. Totals come from the server.
        </Banner>
      ) : null}
      {unpriced.length > 0 ? (
        <Banner tone="info" testId="pf-mf-unpriced">
          No NAV yet for {unpriced.map((h) => h.scheme_name).join(", ")}. Their value is shown as a
          dash and the total is not a partial sum.
        </Banner>
      ) : null}
      {perFolio && folio.isPending ? (
        <Skeleton className="h-24 w-full" label="Loading folios" />
      ) : null}
      {perFolio && folio.isError ? (
        <Banner tone="error" testId="pf-mf-folio-error">
          The per-folio rows could not be loaded. The scheme rows below are still correct.
        </Banner>
      ) : null}
      {shown.length === 0 ? (
        <EmptyState
          message={
            includeExited
              ? "No mutual fund holdings."
              : "No open mutual fund holdings. Turn on Show exited schemes to see sold-out funds."
          }
        />
      ) : (
        <div
          className="relative overflow-x-auto"
          role="region"
          aria-label="Mutual fund holdings table"
          tabIndex={0}
        >
          <table className="w-full min-w-[72rem] text-body-sm" data-testid="pf-mf-holdings-table">
            <caption className="sr-only">
              Mutual fund holdings: units, cost, NAV, value, P&amp;L and return
            </caption>
            <thead>
              <tr className="text-left text-caption text-text-2">
                {HEADERS.map((h) => (
                  <th
                    key={h.label}
                    scope="col"
                    aria-sort={
                      h.sort && sort?.key === h.sort
                        ? sort.dir === 1
                          ? "ascending"
                          : "descending"
                        : undefined
                    }
                    className={cx(
                      "p-2 font-medium",
                      h.num ? "text-right" : "",
                      h.label === "Scheme" ? "sticky left-0 z-10 bg-surface-1" : "",
                    )}
                  >
                    {h.sort ? (
                      <button
                        type="button"
                        data-testid={`pf-mf-sort-${h.sort}`}
                        onClick={() => toggleSort(h.sort as SortKey)}
                        className="touch-target inline-flex items-center underline-offset-2 hover:underline"
                      >
                        {h.label}
                      </button>
                    ) : h.sorts ? (
                      <div className="flex flex-col items-end">
                        <span>{h.label}</span>
                        {h.sorts.map((x) => (
                          <button
                            key={x.key}
                            type="button"
                            data-testid={`pf-mf-sort-${x.key}`}
                            aria-pressed={sort?.key === x.key}
                            onClick={() => toggleSort(x.key)}
                            className="touch-target inline-flex items-center text-caption underline underline-offset-2"
                          >
                            {x.label}
                            {sort?.key === x.key
                              ? sort.dir === 1
                                ? " (ascending)"
                                : " (descending)"
                              : ""}
                          </button>
                        ))}
                      </div>
                    ) : (
                      h.label
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((h, i) => (
                <Row
                  key={`${h.scheme_code}-${h.folio ?? i}`}
                  h={h}
                  testId={
                    perFolio && h.folio
                      ? `pf-mf-folio-row-${h.scheme_code}-${i}`
                      : `pf-mf-row-${h.scheme_code}`
                  }
                />
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-border font-medium" data-testid="pf-mf-totals-row">
                <th scope="row" className="sticky left-0 z-10 bg-surface-1 p-2 text-left">
                  Total, mutual funds
                </th>
                <td />
                <td />
                <td className="num p-2">
                  <Cell f={inr(totals.invested)} />
                </td>
                <td />
                <td className="num p-2">
                  <Cell f={totalsValue} />
                </td>
                <td className="num p-2">
                  <Cell
                    f={inr(totals.unrealized_pnl, {
                      signed: true,
                      reason: "needs a NAV for every fund",
                    })}
                  />
                </td>
                <td className="num p-2">
                  <Cell f={inr(totals.realized_pnl, { signed: true })} />
                </td>
                <td className="num p-2">
                  <Cell f={inr(totals.idcw_income, { signed: true })} />
                </td>
                <td />
                <td />
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      <p className="text-caption text-text-2">
        As of {asOf ?? "unknown"}. Sort order is for reading only; totals are computed by the
        server.
      </p>
    </section>
  );
}
