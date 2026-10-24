"use client";

import Link from "next/link";
import { Banner } from "@/components/ui/banners";
import { Card } from "@/components/ui/Card";
import { AsOfChip } from "@/components/ui/chips";
import { useAdminStatus, useBrokerStatus, useWatchlist } from "@/lib/dashboard/queries";
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
            <span className="text-text-2">
              {describeError(watch.error, "Price import date").message}
            </span>
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
            <span className="text-text-2">
              {describeError(broker.error, "Broker status").message}
            </span>
          ) : b && b.enabled ? (
            <span>
              {b.minutes_left === null || b.minutes_left === undefined
                ? "Broker session: time left unknown"
                : `Broker session: ${formatCount(b.minutes_left).text} min left`}
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
            <span className="text-text-2">{describeError(admin.error, "Job status").message}</span>
          ) : job ? (
            <span>
              {job.job ?? "job"}: {job.status ?? "status unknown"}
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
