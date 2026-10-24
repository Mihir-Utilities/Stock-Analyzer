"use client";

import Link from "next/link";
import { Banner } from "@/components/ui/banners";
import { formatDate, formatPercent } from "@/lib/format";
import {
  changeOn,
  softFlags,
  coveredDates,
  unconfirmedCopy,
  unconfirmedDates,
} from "@/lib/stock/derive";
import {
  ACTION_DECISION_AVAILABLE,
  ACTION_DECISION_UNAVAILABLE_REASON,
  SOFT_FLAG_DISMISS_AVAILABLE,
  SOFT_FLAG_DISMISS_UNAVAILABLE_REASON,
} from "@/lib/stock/soft-flag-adapter";
import type { Bar, CorporateAction, StockProfile } from "@/lib/stock/schemas";

export interface ApiWarning {
  code: string;
  message: string;
}

export const MANUAL_MODE_COPY =
  "Manual price mode: prices come from the files you import. Nothing is fetched live.";

const small =
  "inline-flex h-9 touch-target items-center rounded-control border border-border px-3 text-body-sm text-text-1 disabled:cursor-not-allowed disabled:opacity-60";

export function mergeWarnings(lists: ReadonlyArray<ReadonlyArray<ApiWarning>>): ApiWarning[] {
  const seen = new Set<string>();
  const out: ApiWarning[] = [];
  for (const l of lists)
    for (const w of l) {
      const k = `${w.code}|${w.message}`;
      if (!seen.has(k)) {
        seen.add(k);
        out.push(w);
      }
    }
  return out;
}

/** Page level banners (docs/06 4.5): notices, stale, limited history, warnings[] always shown. */
export function StockBanners({
  profile,
  warnings,
  bars,
  confirmedMarkers,
  eventActions,
}: {
  profile: StockProfile;
  warnings: ReadonlyArray<ApiWarning>;
  bars: ReadonlyArray<Bar> | null;
  confirmedMarkers: ReadonlyArray<{ date: string }>;
  eventActions: ReadonlyArray<CorporateAction> | null;
}) {
  const f = profile.freshness;
  const unconfirmed = unconfirmedDates(warnings);
  const others = warnings.filter((w) => w.code !== "UNCONFIRMED_ACTION");
  const soft = bars ? softFlags(bars, coveredDates(confirmedMarkers, warnings, eventActions)) : [];
  return (
    <div className="flex flex-col gap-2" data-testid="stock-banners">
      {profile.price_mode !== "broker" ? (
        <Banner tone="info" testId="manual-mode-banner">
          {MANUAL_MODE_COPY}
        </Banner>
      ) : null}
      {f.prices_stale && !profile.flags.no_prices ? (
        <Banner tone="warn" testId="stale-banner">
          Prices are stale: the last imported bar is{" "}
          {formatDate(f.prices_as_of, { reason: "unknown" }).text}.{" "}
          <Link
            href="/imports"
            className="touch-target inline-flex items-center underline"
            data-testid="stale-import-link"
          >
            Import newer prices
          </Link>
        </Banner>
      ) : null}
      {profile.flags.limited_history ? (
        <Banner tone="info" testId="limited-history-banner">
          Limited history: the imported prices start later than expected, so long-range figures may
          show as unavailable.
        </Banner>
      ) : null}
      {profile.flags.series_warning ? (
        <Banner tone="info" testId="series-banner">
          This stock trades in series {profile.flags.series_warning}, not the regular EQ series.
          Prices and rules can differ.
        </Banner>
      ) : null}
      {unconfirmed.map((d) => (
        <div key={d} data-testid="unconfirmed-action" className="flex flex-col gap-2">
          <Banner tone="warn" testId="unconfirmed-banner">
            {unconfirmedCopy(d, bars ? changeOn(bars, d) : null)}
          </Banner>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="action-confirm"
              disabled={!ACTION_DECISION_AVAILABLE}
              title={ACTION_DECISION_UNAVAILABLE_REASON}
              className={small}
            >
              Confirm
            </button>
            <button
              type="button"
              data-testid="action-reject"
              disabled={!ACTION_DECISION_AVAILABLE}
              title={ACTION_DECISION_UNAVAILABLE_REASON}
              className={small}
            >
              Reject
            </button>
            {!ACTION_DECISION_AVAILABLE ? (
              <span className="text-caption text-text-2">{ACTION_DECISION_UNAVAILABLE_REASON}</span>
            ) : null}
          </div>
        </div>
      ))}
      {soft.map((s) => (
        <div key={s.date} data-testid="soft-flag" className="flex flex-col gap-2">
          <Banner tone="info" testId="soft-flag-banner">
            Split/bonus or real move? The close fell{" "}
            {formatPercent(Math.abs(s.dropPct), { decimals: 1 }).text} on {formatDate(s.date).text}.
            No corporate action is recorded for that day.
          </Banner>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="soft-flag-dismiss"
              disabled={!SOFT_FLAG_DISMISS_AVAILABLE}
              title={SOFT_FLAG_DISMISS_UNAVAILABLE_REASON}
              className={small}
            >
              Dismiss
            </button>
            <Link
              href={`/stocks/${encodeURIComponent(profile.symbol)}?tab=events`}
              data-testid="soft-flag-add-action"
              className={small}
            >
              Add corporate action
            </Link>
            {!SOFT_FLAG_DISMISS_AVAILABLE ? (
              <span className="text-caption text-text-2">
                {SOFT_FLAG_DISMISS_UNAVAILABLE_REASON}
              </span>
            ) : null}
          </div>
        </div>
      ))}
      {others.map((w) => (
        <Banner key={`${w.code}|${w.message}`} tone="warn" testId={`warning-${w.code}`}>
          {w.message}
        </Banner>
      ))}
    </div>
  );
}
