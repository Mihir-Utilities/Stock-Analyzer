"use client";

import Link from "next/link";
import { Banner } from "@/components/ui/banners";
import { Card } from "@/components/ui/Card";
import { DataTable, type DataColumn } from "@/components/ui/DataTable";
import { Stat } from "@/components/ui/Stat";
import { getDefinition } from "@/lib/definitions";
import { formatDate, formatInr } from "@/lib/format";
import { asOfText } from "@/lib/dashboard/state";
import { displayNumber } from "@/lib/portfolio/decimal";
import type { Holding, PortfolioSummary } from "@/lib/portfolio/schemas";
import { flagText, inr, pct, PORTFOLIO_SOURCE, qty, reasonText, WARNING_LABEL } from "./text";

interface Warn {
  code: string;
  message: string;
}

/** API `warnings[]` as banners: review needed, unconfirmed, inconsistent, missing price. */
export function WarningBanners({ warnings }: { warnings: ReadonlyArray<Warn> }) {
  if (warnings.length === 0) return null;
  return (
    <div className="flex flex-col gap-2" data-testid="pf-warnings">
      {warnings.map((w, i) => (
        <Banner key={`${w.code}-${i}`} tone="warn" testId={`pf-warning-${w.code}`}>
          <strong>{WARNING_LABEL[w.code] ?? w.code}:</strong> {w.message}
        </Banner>
      ))}
    </div>
  );
}

export function SummaryCards({
  s,
  asOf,
  stale,
}: {
  s: PortfolioSummary;
  asOf: string | null;
  stale: boolean;
}) {
  const t = s.totals;
  const unrealizedPct = pct(t.unrealized_pct, true);
  const xirr = pct(s.returns.xirr_pct);
  const abs = pct(s.returns.absolute_return_pct, true);
  const xirrReason =
    (reasonText(s.returns.xirr_reason) ?? "not available") +
    (abs.reason === null
      ? `. Absolute return ${abs.text}${s.returns.absolute_return_basis ? ` (${s.returns.absolute_return_basis.replace(/_/g, " ")})` : ""}`
      : "");
  const bench = s.benchmark;
  const benchPct = pct(bench.xirr_pct);
  const diff =
    typeof s.returns.xirr_pct === "number" && typeof bench.xirr_pct === "number"
      ? s.returns.xirr_pct - bench.xirr_pct
      : null;
  const common = { source: PORTFOLIO_SOURCE, asOf } as const;
  return (
    <Card
      title="Summary"
      state={stale ? "stale" : "ready"}
      source={PORTFOLIO_SOURCE}
      asOf={asOf}
      testId="pf-summary"
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Invested"
          value={inr(t.invested).text}
          definition={getDefinition("avg_cost").text}
          {...common}
        />
        <Stat
          label="Current value"
          value={
            t.market_value === null || t.market_value === undefined
              ? null
              : inr(t.market_value).text
          }
          nullReason={reasonText(t.market_value_reason) ?? "no price available"}
          {...common}
        />
        <Stat
          label="Unrealized P&L"
          value={
            t.unrealized_pnl === null || t.unrealized_pnl === undefined
              ? null
              : inr(t.unrealized_pnl, { signed: true }).text
          }
          nullReason={reasonText(t.market_value_reason) ?? "no price available"}
          delta={{
            value: t.unrealized_pct ?? null,
            text: unrealizedPct.reason === null ? unrealizedPct.text : null,
          }}
          definition="Market value minus invested (average-cost basis). An estimate until sold."
          {...common}
        />
        <Stat
          label="Realized P&L"
          value={inr(t.realized_pnl, { signed: true }).text}
          definition="Profit or loss on sold shares, first-in first-out, after fees. Includes fully sold positions."
          {...common}
        />
        <Stat
          label="Day change"
          value={
            t.day_change === null || t.day_change === undefined
              ? null
              : inr(t.day_change, { signed: true }).text
          }
          nullReason={reasonText(t.day_change_reason) ?? "no earlier close"}
          {...common}
        />
        <Stat
          label="XIRR"
          value={xirr.reason === null ? xirr.text : null}
          nullReason={xirrReason}
          definition={getDefinition("xirr").text}
          {...common}
        />
        <Stat
          label="vs Nifty 50"
          value={benchPct.reason === null ? `${benchPct.text} Nifty 50 XIRR` : null}
          nullReason={reasonText(bench.reason) ?? "no benchmark series"}
          delta={
            diff === null
              ? { value: null, text: null }
              : { value: diff, text: `${pct(diff, true).text} pts vs yours` }
          }
          definition={bench.note ?? undefined}
          source="Nifty 50 price index, imported"
          asOf={bench.level_as_of ? asOfText(bench.level_as_of) : null}
        />
      </div>
    </Card>
  );
}

function holdingColumns(): DataColumn<Holding>[] {
  return [
    { id: "symbol", header: "Symbol", value: (h) => h.symbol, pinned: true },
    { id: "name", header: "Name", value: (h) => h.name },
    {
      id: "qty",
      header: "Qty",
      kind: "num",
      value: (h) => displayNumber(h.qty),
      display: (h) => qty(h.qty),
    },
    {
      id: "avg_cost",
      header: "Avg cost",
      kind: "num",
      value: (h) => displayNumber(h.avg_cost),
      display: (h) => inr(h.avg_cost).text,
      nullReason: "average cost is unknown for a fully sold position",
    },
    {
      id: "invested",
      header: "Invested",
      kind: "num",
      value: (h) => displayNumber(h.invested),
      display: (h) => inr(h.invested).text,
    },
    {
      id: "ltp",
      header: "LTP (latest close)",
      kind: "num",
      value: (h) => displayNumber(h.ltp),
      display: (h) => `${inr(h.ltp).text}${h.price_stale ? " (stale)" : ""}`,
      nullReason: "no valid close has been imported for this stock",
    },
    {
      id: "ltp_as_of",
      header: "Close as of",
      value: (h) => h.ltp_as_of ?? null,
      display: (h) => formatDate(h.ltp_as_of).text,
      nullReason: "no close imported",
    },
    {
      id: "market_value",
      header: "Value",
      kind: "num",
      value: (h) => displayNumber(h.market_value),
      display: (h) => inr(h.market_value).text,
      nullReason: "needs a valid close",
    },
    {
      id: "unrealized",
      header: "Unrealized P&L",
      kind: "num",
      value: (h) => displayNumber(h.unrealized_pnl),
      display: (h) => inr(h.unrealized_pnl, { signed: true }).text,
      nullReason: "needs a valid close",
    },
    {
      id: "unrealized_pct",
      header: "Unrealized %",
      kind: "num",
      value: (h) => h.unrealized_pct ?? null,
      display: (h) => pct(h.unrealized_pct, true).text,
      nullReason: "needs a valid close",
    },
    {
      id: "day_change",
      header: "Day change",
      kind: "num",
      value: (h) => displayNumber(h.day_change),
      display: (h) => inr(h.day_change, { signed: true }).text,
      nullReason:
        "no earlier close, or a split or bonus lies between the last two closes (see Notes)",
    },
    {
      id: "weight",
      header: "Weight",
      kind: "num",
      value: (h) => h.weight_pct ?? null,
      display: (h) => pct(h.weight_pct).text,
      nullReason: "needs a valid close",
    },
    {
      id: "realized",
      header: "Realized P&L",
      kind: "num",
      value: (h) => displayNumber(h.realized_pnl),
      display: (h) => inr(h.realized_pnl, { signed: true }).text,
    },
    {
      id: "notes",
      header: "Notes",
      value: (h) => holdingNotes(h) || null,
      nullReason: "none",
    },
  ];
}

/** Flags, split adjustments and review items of one holding, in words. */
export function holdingNotes(h: Holding): string {
  const parts: string[] = [];
  if (h.exited) parts.push("fully sold");
  for (const f of h.flags ?? []) parts.push(flagText(f));
  for (const a of h.adjustments_applied ?? []) {
    parts.push(`${a.type} ${formatDate(a.date).text} x${a.multiplier} applied`);
  }
  for (const r of h.review_needed ?? []) {
    parts.push(`review needed: ${r.type} ${formatDate(r.date).text} (${r.note})`);
  }
  const reason = reasonText(h.day_change_reason);
  if (h.day_change === null && reason) parts.push(`day change: ${reason}`);
  return parts.join("; ");
}

export function HoldingsSection({
  s,
  asOf,
  stale,
  showExited,
  onShowExited,
}: {
  s: PortfolioSummary;
  asOf: string | null;
  stale: boolean;
  showExited: boolean;
  onShowExited: (v: boolean) => void;
}) {
  const realized = formatInr(displayNumber(s.totals.realized_pnl), { signed: true }).text;
  return (
    <section
      aria-labelledby="pf-holdings-h"
      className="flex flex-col gap-2"
      data-testid="pf-holdings"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="pf-holdings-h" className="text-lead font-semibold">
          Holdings
        </h2>
        <label className="touch-target inline-flex items-center gap-2 text-body-sm">
          <input
            type="checkbox"
            data-testid="pf-show-exited"
            checked={showExited}
            onChange={(e) => onShowExited(e.target.checked)}
          />
          Show fully sold positions
        </label>
      </div>
      <p className="text-caption text-text-2" data-testid="pf-ltp-note">
        LTP is the latest valid close from your imported price files (manual price mode), not a live
        quote. Fully sold positions are hidden by default; their realized P&amp;L ({realized}) stays
        in the totals.
      </p>
      <DataTable
        label="Holdings"
        columns={holdingColumns()}
        rows={s.holdings}
        rowKey={(h) => h.symbol}
        state={s.holdings.length === 0 ? "empty" : "ready"}
        message="No open holdings. Add a transaction below, or import your transactions."
        source={PORTFOLIO_SOURCE}
        asOf={asOf}
        stale={stale}
        csvFilename="holdings"
        {...(s.allocation_excludes_unpriced
          ? { partialNote: "Some holdings have no price; value, weight and P&L exclude them." }
          : {})}
      />
      <p className="text-caption text-text-2">
        Open a stock for its page:{" "}
        {s.holdings.slice(0, 8).map((h, i) => (
          <span key={h.symbol}>
            {i > 0 ? ", " : ""}
            <Link
              href={`/stocks/${encodeURIComponent(h.symbol)}`}
              data-testid={`pf-stock-link-${h.symbol}`}
              className="touch-target inline-flex items-center text-accent underline"
            >
              {h.symbol}
            </Link>
          </span>
        ))}
      </p>
    </section>
  );
}
