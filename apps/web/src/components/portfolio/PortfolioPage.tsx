"use client";

import Link from "next/link";
import { useState } from "react";
import { Card } from "@/components/ui/Card";
import { ToastProvider } from "@/components/ui/overlays";
import { describeError, asOfText } from "@/lib/dashboard/state";
import { usePortfolioSummaryFull } from "@/lib/portfolio/api";
import { AdjustmentsPanel, DividendsCard } from "./AdjustmentsPanel";
import { ChartsSection } from "./ChartsSection";
import { HoldingsSection, SummaryCards, WarningBanners } from "./SummarySection";
import { MANUAL_PRICE_NOTE, PORTFOLIO_SOURCE } from "./text";
import { TxnSection } from "./TxnSection";

function Body() {
  const [showExited, setShowExited] = useState(false);
  const q = usePortfolioSummaryFull(showExited);

  let top;
  let symbols: string[] = [];
  if (q.isPending) {
    top = <Card title="Summary" state="loading" testId="pf-summary" />;
  } else if (q.isError) {
    const u = describeError(q.error, "The portfolio summary");
    top = (
      <Card
        title="Summary"
        state={u.state}
        message={u.message}
        onRetry={() => void q.refetch()}
        source={PORTFOLIO_SOURCE}
        testId="pf-summary"
      />
    );
  } else {
    const s = q.data.data;
    const asOf = asOfText(q.data.meta?.as_of ?? s.as_of);
    const stale = q.data.meta?.stale === true;
    symbols = s.holdings.map((h) => h.symbol);
    top = (
      <>
        <WarningBanners warnings={q.data.warnings} />
        <SummaryCards s={s} asOf={asOf} stale={stale} />
        <HoldingsSection
          s={s}
          asOf={asOf}
          stale={stale}
          showExited={showExited}
          onShowExited={setShowExited}
        />
        <ChartsSection s={s} asOf={asOf} />
        <DividendsCard s={s} asOf={asOf} />
      </>
    );
  }
  return (
    <>
      {top}
      <TxnSection symbols={symbols} />
      <AdjustmentsPanel />
    </>
  );
}

/** Portfolio screen (docs/06 section 6.7). Stocks only; manual price mode. */
export function PortfolioPage() {
  return (
    <ToastProvider>
      <div className="flex flex-col gap-4" data-testid="portfolio-page">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-page font-semibold text-text-1">Portfolio</h1>
          <Link
            href="/imports"
            data-testid="portfolio-import-link"
            className="touch-target inline-flex items-center text-body-sm text-accent underline"
          >
            Import transactions
          </Link>
        </div>
        <p className="text-body-sm text-text-2" data-testid="pf-manual-note">
          {MANUAL_PRICE_NOTE} Values are estimates from your own records, not advice.
        </p>
        <Body />
      </div>
    </ToastProvider>
  );
}
