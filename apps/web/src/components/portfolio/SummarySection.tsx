"use client";

import { Banner } from "@/components/ui/banners";
import { Card } from "@/components/ui/Card";
import { Stat } from "@/components/ui/Stat";
import { getDefinition } from "@/lib/definitions";
import { asOfText } from "@/lib/dashboard/state";
import type { PortfolioSummary } from "@/lib/portfolio/schemas";
import { benchmarkDeltaText, inr, pct, PORTFOLIO_SOURCE, reasonText, WARNING_LABEL } from "./text";

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
              : { value: diff, text: benchmarkDeltaText(diff) }
          }
          definition={bench.note ?? undefined}
          source="Nifty 50 price index, imported"
          asOf={bench.level_as_of ? asOfText(bench.level_as_of) : null}
        />
      </div>
    </Card>
  );
}
