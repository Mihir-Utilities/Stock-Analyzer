"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Banner } from "@/components/ui/banners";
import { Card } from "@/components/ui/Card";
import { AsOfChip } from "@/components/ui/chips";
import { useAdminStatus, useBrokerStatus, useWatchlist } from "@/lib/dashboard/queries";
import { jobNameLabel, jobStatusLabel } from "@/lib/dashboard/labels";
import {
  asOfText,
  describeError,
  isOlderThanExpected,
  lastNavDate,
  lastPriceImportDate,
} from "@/lib/dashboard/state";
import { formatCount, formatDateTime } from "@/lib/format";

export const BROKER_EXPIRED_COPY = "Broker session expired. Reconnect to update prices.";

const linkClass =
  "inline-flex h-9 touch-target items-center rounded-control border border-border px-3 text-body-sm text-text-1 hover:bg-surface-3";

function Row({
  label,
  testId,
  children,
}: {
  label: string;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <div data-testid={testId} className="flex min-w-0 flex-col gap-1">
      <dt className="text-caption text-text-2">{label}</dt>
      <dd className="flex flex-wrap items-center gap-2 text-body-sm text-text-1">{children}</dd>
    </div>
  );
}

/** Error text with the request id (describeError) and a Retry that refetches only this row. */
function RowError({
  error,
  what,
  onRetry,
  testId,
}: {
  error: unknown;
  what: string;
  onRetry: () => void;
  testId: string;
}) {
  const u = describeError(error, what);
  return (
    <>
      <span data-testid={`${testId}-error`} className="text-text-2">
        {u.message}
      </span>
      {u.state === "error" ? (
        <button
          type="button"
          data-testid={`${testId}-retry`}
          onClick={onRetry}
          className="h-9 touch-target rounded-control border border-border px-3 text-body-sm text-text-1 hover:bg-surface-3"
        >
          Retry
        </button>
      ) : null}
    </>
  );
}

/** Ticks once a minute (no requests) so a countdown computed from a snapshot keeps moving. */
function useMinuteTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/** Last price import, price mode / broker countdown, MF freshness and last job status. */
export function HealthStrip() {
  const watch = useWatchlist();
  const broker = useBrokerStatus();
  const admin = useAdminStatus();
  const title = "Data health";

  const stocks = watch.data?.data.stocks ?? [];
  const funds = watch.data?.data.funds ?? [];
  const lastImport = lastPriceImportDate(stocks);
  const importStale = isOlderThanExpected(lastImport, new Date());
  const nav = lastNavDate(funds);

  const b = broker.data?.data;
  const tick = useMinuteTick(b?.enabled === true);
  // Minutes left at fetch time minus whole minutes elapsed since (F04R-6); never negative.
  const minutesLeft =
    b?.minutes_left === null || b?.minutes_left === undefined
      ? null
      : Math.max(0, b.minutes_left - Math.floor(Math.max(0, tick - broker.dataUpdatedAt) / 60_000));
  const brokerExpired =
    b?.enabled === true && (b.connected === false || b.needs_reconnect === true);

  const jobs = admin.data?.data.jobs ?? [];
  const job = jobs[0];

  return (
    <Card title={title} source="This app's own status" testId="dash-health">
      {brokerExpired ? (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Banner tone="warn" testId="broker-expired">
            {BROKER_EXPIRED_COPY}
          </Banner>
          <Link href="/settings" data-testid="broker-reconnect" className={linkClass}>
            Reconnect
          </Link>
        </div>
      ) : null}
      <dl className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Row label="Last price import" testId="health-import">
          {watch.isPending ? (
            <span className="text-text-2">Loading</span>
          ) : watch.isError ? (
            <RowError
              error={watch.error}
              what="Price import date"
              onRetry={() => void watch.refetch()}
              testId="health-import"
            />
          ) : (
            <>
              <AsOfChip asOf={asOfText(lastImport)} stale={importStale} />
              {lastImport === null ? (
                <span className="text-text-2">No prices imported yet.</span>
              ) : null}
              <Link href="/imports" data-testid="health-import-link" className={linkClass}>
                Import prices
              </Link>
            </>
          )}
        </Row>
        <Row label="Price source" testId="health-broker">
          {broker.isPending ? (
            <span className="text-text-2">Loading</span>
          ) : broker.isError ? (
            <RowError
              error={broker.error}
              what="Broker status"
              onRetry={() => void broker.refetch()}
              testId="health-broker"
            />
          ) : b && b.enabled ? (
            <span>
              {minutesLeft === null
                ? "Broker session: time left unknown"
                : `Broker session: ${formatCount(minutesLeft).text} min left`}
            </span>
          ) : (
            <span>Manual price mode: prices come from your imports.</span>
          )}
        </Row>
        <Row label="Mutual fund NAV" testId="health-mf">
          {watch.isPending ? (
            <span className="text-text-2">Loading</span>
          ) : nav === null ? (
            <span className="text-text-2">
              {funds.length === 0 ? "No funds in your watchlist." : "No NAV date known."}
            </span>
          ) : (
            <>
              <AsOfChip asOf={asOfText(nav)} />
              <span className="text-caption text-text-2">Source: AMFI NAV file</span>
            </>
          )}
        </Row>
        <Row label="Last job" testId="health-job">
          {admin.isPending ? (
            <span className="text-text-2">Loading</span>
          ) : admin.isError ? (
            <RowError
              error={admin.error}
              what="Job status"
              onRetry={() => void admin.refetch()}
              testId="health-job"
            />
          ) : job ? (
            <span>
              {jobNameLabel(job.job)}: {job.status ? jobStatusLabel(job.status) : "Status unknown"}
              {job.finished_at ? `, ${formatDateTime(job.finished_at).text}` : ""}
            </span>
          ) : (
            <span className="text-text-2">No job has run yet.</span>
          )}
        </Row>
      </dl>
    </Card>
  );
}
