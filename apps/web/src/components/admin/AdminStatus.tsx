"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Banner } from "@/components/ui/banners";
import { Card } from "@/components/ui/Card";
import { cx } from "@/components/ui/cx";
import { Fmt } from "@/components/imports/Fmt";
import { ApiError, apiRequest } from "@/lib/api/client";
import { describeError } from "@/lib/dashboard/state";
import {
  formatCount,
  formatDateTime,
  formatDuration,
  formatMb,
  formatPercentOf,
  type Formatted,
} from "@/lib/format";
import { DB_SOFT_LIMIT_MB, warnLevelFor, warnLevelText } from "@/lib/imports/storage";
import {
  adminStatusFullSchema,
  holidayWarning,
  recentErrors,
  runDurationMs,
  SOURCE_ORDER,
  type AdminStatusFull,
  type JobRow,
  type SourceRow,
} from "@/lib/admin/schemas";

const SOURCE = "API /admin/status";
const NOT_REPORTED = "not reported by the server";
const TH = "py-1 pr-3 font-medium";

export const ADMIN_STATUS_KEY = ["admin", "status-page"] as const;

function useAdminPage() {
  return useQuery({
    queryKey: ADMIN_STATUS_KEY,
    queryFn: async ({ signal }) => {
      const r = await apiRequest("/admin/status", { schema: adminStatusFullSchema, signal });
      const when = formatDateTime(r.meta?.as_of ?? null);
      return { status: r.data, asOf: when.reason === null ? when.text : null };
    },
    staleTime: 60_000,
  });
}

const plain = (text: string, reason: string | null = null): Formatted => ({
  text,
  reason,
  direction: "flat",
});

function Dd({ label, value }: { label: string; value: Formatted }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-body-sm text-text-2">{label}</dt>
      <dd className="text-body text-text-1">
        <Fmt f={value} />
      </dd>
    </div>
  );
}

function SourceCard({
  name,
  row,
  asOf,
}: {
  name: string;
  row: SourceRow | undefined;
  asOf: string | null;
}) {
  const title = `Source: ${name}`;
  if (!row) {
    return (
      <Card
        title={title}
        state="empty"
        message="No health check has been recorded for this source yet."
        source={SOURCE}
        asOf={asOf}
        testId={`admin-source-${name}`}
      />
    );
  }
  const status = row.ok === true ? "OK" : row.ok === false ? "Failing" : "Unknown";
  const checked = formatDateTime(row.checked_at ?? null, { reason: NOT_REPORTED });
  return (
    <Card
      title={title}
      source={SOURCE}
      asOf={checked.reason === null ? checked.text : null}
      state={row.ok === false ? "partial" : "ready"}
      message={row.ok === false ? "The last check failed." : undefined}
      testId={`admin-source-${name}`}
    >
      <dl className="flex flex-col gap-1">
        <Dd label="Status" value={plain(status, row.ok == null ? NOT_REPORTED : null)} />
        <Dd
          label="Latency"
          value={formatDuration(row.latency_ms ?? null, { reason: NOT_REPORTED })}
        />
        <Dd
          label="Consecutive failures"
          value={formatCount(row.consecutive_failures ?? null, { reason: NOT_REPORTED })}
        />
        <Dd
          label="Paused until"
          value={row.disabled_until ? formatDateTime(row.disabled_until) : plain("Not paused")}
        />
        {row.note ? <Dd label="Note" value={plain(row.note)} /> : null}
      </dl>
    </Card>
  );
}

function JobsCard({ jobs, asOf }: { jobs: readonly JobRow[]; asOf: string | null }) {
  return (
    <Card
      title="Last runs"
      source={SOURCE}
      asOf={asOf}
      state={jobs.length === 0 ? "empty" : "ready"}
      message="No job has run yet."
      testId="admin-jobs"
    >
      <div
        className="overflow-x-auto"
        role="region"
        aria-label="Latest run of each job"
        tabIndex={0}
        data-testid="admin-jobs-scroll"
      >
        <table className="w-full text-left text-body-sm" data-testid="admin-jobs-table">
          <caption className="sr-only">Latest run of each job</caption>
          <thead>
            <tr className="text-text-2">
              <th scope="col" className={TH}>
                Job
              </th>
              <th scope="col" className={TH}>
                Status
              </th>
              <th scope="col" className={TH}>
                Finished
              </th>
              <th scope="col" className={cx(TH, "text-right")}>
                Duration
              </th>
              <th scope="col" className={cx(TH, "text-right")}>
                Rows written
              </th>
              <th scope="col" className="py-1 text-right font-medium">
                Items failed
              </th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.job} className="border-t border-border" data-testid="admin-job-row">
                <th scope="row" className="py-1 pr-3 font-medium text-text-1">
                  <span className="block max-w-48 truncate" title={j.job}>
                    {j.job}
                  </span>
                </th>
                <td className="py-1 pr-3 text-text-1">{j.status ?? "unknown"}</td>
                <td className="py-1 pr-3 text-text-1">
                  <Fmt
                    f={
                      j.finished_at
                        ? formatDateTime(j.finished_at)
                        : plain("—", j.status === "running" ? "still running" : NOT_REPORTED)
                    }
                  />
                </td>
                <td className="py-1 pr-3 text-right tabular-nums text-text-1">
                  <Fmt
                    f={formatDuration(runDurationMs(j), {
                      reason: j.finished_at ? NOT_REPORTED : "not finished",
                    })}
                  />
                </td>
                <td className="py-1 pr-3 text-right tabular-nums text-text-1">
                  <Fmt f={formatCount(j.rows_written ?? null, { reason: NOT_REPORTED })} />
                </td>
                <td className="py-1 text-right tabular-nums text-text-1">
                  <Fmt f={formatCount(j.items_failed ?? null, { reason: NOT_REPORTED })} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function CoverageCard({
  c,
  asOf,
}: {
  c: NonNullable<AdminStatusFull["coverage"]>;
  asOf: string | null;
}) {
  const rows: Array<[string, number | null | undefined]> = [
    ["Instruments", c.instruments],
    ["Tracked stocks", c.tracked],
    ["With prices", c.with_prices],
    ["With owner fundamentals", c.with_fundamentals],
    ["With shareholding", c.with_shareholding],
  ];
  return (
    <Card title="Coverage" source={SOURCE} asOf={asOf} testId="admin-coverage">
      <dl className="flex flex-col gap-1">
        {rows.map(([label, v]) => (
          <Dd key={label} label={label} value={formatCount(v ?? null, { reason: NOT_REPORTED })} />
        ))}
      </dl>
    </Card>
  );
}

function DbCard({ db, asOf }: { db: NonNullable<AdminStatusFull["db"]>; asOf: string | null }) {
  const size = db.size_mb ?? null;
  const level = db.warn_level ?? (size === null ? "ok" : warnLevelFor(size));
  const pct = size === null ? 0 : Math.max(0, Math.min(100, (size / DB_SOFT_LIMIT_MB) * 100));
  const tone =
    level === "ok" ? "bg-accent" : level === "limit" || level === "95" ? "bg-down" : "bg-warn";
  return (
    <Card
      title="Database size"
      source={SOURCE}
      asOf={asOf}
      state={size === null || level !== "ok" ? "partial" : "ready"}
      message={
        size === null ? "The server did not report the database size." : warnLevelText(level)
      }
      testId="admin-db"
    >
      {size === null ? null : (
        <div className="flex flex-col gap-2">
          <p className="text-body text-text-1" data-testid="admin-db-text">
            <Fmt f={formatMb(size)} /> of {DB_SOFT_LIMIT_MB} MB (
            <Fmt f={formatPercentOf(size, DB_SOFT_LIMIT_MB)} />)
            {level === "ok"
              ? ""
              : `. Warning level: ${level === "limit" ? "at limit" : `${level}%`}`}
          </p>
          <div
            role="meter"
            aria-label="Database size"
            aria-valuemin={0}
            aria-valuemax={DB_SOFT_LIMIT_MB}
            aria-valuenow={Math.min(size, DB_SOFT_LIMIT_MB)}
            aria-valuetext={`${formatMb(size).text} of ${DB_SOFT_LIMIT_MB} MB`}
            data-testid="admin-db-bar"
            data-level={level}
            className="relative h-3 w-full overflow-hidden rounded-chip border border-border bg-surface-2"
          >
            <div className={cx("h-full", tone)} style={{ width: `${pct}%` }} />
            {[70, 85, 95].map((t) => (
              <span
                key={t}
                aria-hidden="true"
                className="absolute top-0 h-full w-px bg-text-2"
                style={{ left: `${t}%` }}
              />
            ))}
          </div>
        </div>
      )}
      {db.tables && db.tables.length > 0 ? (
        <div
          className="mt-3 overflow-x-auto"
          role="region"
          aria-label="Largest tables"
          tabIndex={0}
          data-testid="admin-db-scroll"
        >
          <table className="w-full text-left text-body-sm" data-testid="admin-db-tables">
            <caption className="sr-only">Largest tables</caption>
            <thead>
              <tr className="text-text-2">
                <th scope="col" className={TH}>
                  Table
                </th>
                <th scope="col" className={cx(TH, "text-right")}>
                  Size
                </th>
                <th scope="col" className="py-1 text-right font-medium">
                  Rows
                </th>
              </tr>
            </thead>
            <tbody>
              {db.tables.map((t) => (
                <tr key={t.name} className="border-t border-border">
                  <th scope="row" className="py-1 pr-3 font-medium text-text-1">
                    <span className="block max-w-48 truncate" title={t.name}>
                      {t.name}
                    </span>
                  </th>
                  <td className="py-1 pr-3 text-right tabular-nums text-text-1">
                    <Fmt f={formatMb(t.mb ?? null, { reason: NOT_REPORTED })} />
                  </td>
                  <td className="py-1 text-right tabular-nums text-text-1">
                    <Fmt f={formatCount(t.rows ?? null, { reason: NOT_REPORTED })} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Card>
  );
}

function ErrorsCard({ jobs, asOf }: { jobs: readonly JobRow[]; asOf: string | null }) {
  const errs = recentErrors(jobs);
  return (
    <Card
      title="Recent errors"
      source={SOURCE}
      asOf={asOf}
      state={errs.length === 0 ? "empty" : "ready"}
      message="No failed or partial runs in the latest run of each job."
      testId="admin-errors"
    >
      <ul className="flex flex-col gap-2" data-testid="admin-error-list">
        {errs.map((j) => (
          <li key={j.job} className="text-body-sm">
            <span className="break-all font-medium text-text-1">{j.job}</span>{" "}
            <span className="text-text-2">
              ({j.status},{" "}
              <Fmt
                f={formatDateTime(j.finished_at ?? j.started_at ?? null, { reason: NOT_REPORTED })}
              />
              )
            </span>
            {/* React escapes the text; a server error string is never rendered as HTML (SEC-11). */}
            <p
              className="whitespace-pre-wrap break-words text-text-1"
              data-testid="admin-error-text"
            >
              {j.error}
            </p>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function HolidayCard({ years, asOf }: { years: readonly number[]; asOf: string | null }) {
  return (
    <Card
      title="Holiday lists"
      source={SOURCE}
      asOf={asOf}
      state={years.length === 0 ? "ready" : "partial"}
      message="A holiday list is missing."
      testId="admin-holidays"
    >
      {years.length === 0 ? (
        <p className="text-body text-text-1" data-testid="admin-holidays-ok">
          Every year in use has a holiday list.
        </p>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="admin-holiday-warnings">
          {years.map((y) => (
            <li key={y}>
              <Banner tone="warn">
                <span data-testid="admin-holiday-warning">{holidayWarning(y)}</span>{" "}
                <Link href="/imports" className="underline" data-testid="admin-holiday-import">
                  Open Import center
                </Link>
              </Banner>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function PolicyCard({ policy, asOf }: { policy: Record<string, unknown>; asOf: string | null }) {
  const entries = Object.entries(policy).filter(([, v]) =>
    ["string", "number", "boolean"].includes(typeof v),
  );
  return (
    <Card
      title="Storage policy"
      source={SOURCE}
      asOf={asOf}
      state={entries.length === 0 ? "empty" : "ready"}
      message="The server sent no simple values for the storage policy."
      testId="admin-policy"
    >
      <dl className="flex flex-col gap-1">
        {entries.map(([k, v]) => (
          <Dd key={k} label={k} value={typeof v === "number" ? formatCount(v) : plain(String(v))} />
        ))}
      </dl>
    </Card>
  );
}

const HOME_LINK =
  "touch-target inline-flex h-11 w-fit items-center rounded-control border border-border bg-surface-2 px-4 text-body-sm font-medium text-text-1 no-underline hover:bg-surface-3";

/** Admin status screen (docs/06 section 6.12): data health, read only, no job buttons in v1. */
export function AdminStatus() {
  const q = useAdminPage();
  const h1 = (
    <h1 className="text-title font-semibold text-text-1" data-testid="admin-status-title">
      Admin status
    </h1>
  );

  if (q.isPending) {
    return (
      <div className="flex flex-col gap-3" data-testid="admin-status">
        {h1}
        <Card title="Data health" state="loading" testId="admin-loading" />
      </div>
    );
  }
  if (q.isError) {
    const e = q.error;
    if (e instanceof ApiError && (e.status === 501 || e.code === "NOT_IMPLEMENTED")) {
      return (
        <div className="flex flex-col gap-3" data-testid="admin-status-na">
          <h1 className="text-title font-semibold text-text-1" data-testid="admin-status-na-title">
            Admin status
          </h1>
          <p
            className="max-w-prose text-body text-text-2"
            role="status"
            data-testid="admin-status-na-note"
          >
            Not available yet. The status endpoint (task B14) is not built yet, so sources, jobs,
            coverage and database size cannot be shown.
          </p>
          <Link href="/" data-testid="admin-status-na-home" className={HOME_LINK}>
            Go to Home
          </Link>
        </div>
      );
    }
    const d = describeError(e, "Admin status");
    return (
      <div className="flex flex-col gap-3" data-testid="admin-status">
        {h1}
        <Card
          title="Data health"
          state="error"
          message={d.message}
          onRetry={() => void q.refetch()}
          source={SOURCE}
          testId="admin-error"
        />
      </div>
    );
  }

  const { status: s, asOf } = q.data;
  const jobs = s.jobs ?? [];
  const sources = s.sources ?? [];
  return (
    <div className="flex flex-col gap-4" data-testid="admin-status">
      {h1}
      <h2 className="sr-only">Data health</h2>
      <p className="text-body-sm text-text-2" data-testid="admin-version">
        Version: {s.version ? s.version : "not reported by the server"}
      </p>
      <div className="grid grid-cols-1 gap-4 desktop:grid-cols-3">
        {SOURCE_ORDER.map((n) => (
          <SourceCard key={n} name={n} row={sources.find((r) => r.source === n)} asOf={asOf} />
        ))}
      </div>
      <HolidayCard years={s.holiday_list_missing_years ?? []} asOf={asOf} />
      <div className="grid grid-cols-1 gap-4 desktop:grid-cols-2">
        {s.coverage ? (
          <CoverageCard c={s.coverage} asOf={asOf} />
        ) : (
          <Card
            title="Coverage"
            state="empty"
            message="The server did not report coverage."
            source={SOURCE}
            asOf={asOf}
            testId="admin-coverage"
          />
        )}
        {s.db ? (
          <DbCard db={s.db} asOf={asOf} />
        ) : (
          <Card
            title="Database size"
            state="empty"
            message="The server did not report the database size."
            source={SOURCE}
            asOf={asOf}
            testId="admin-db"
          />
        )}
      </div>
      <JobsCard jobs={jobs} asOf={asOf} />
      <ErrorsCard jobs={jobs} asOf={asOf} />
      {s.storage_policy ? <PolicyCard policy={s.storage_policy} asOf={asOf} /> : null}
    </div>
  );
}
