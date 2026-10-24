"use client";

import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/Card";
import { cx } from "@/components/ui/cx";
import { fetchDbStatus } from "@/lib/imports/api";
import { describeError } from "@/lib/imports/errors";
import { formatMb, formatPercentOf } from "@/lib/imports/local-format";
import { DB_SOFT_LIMIT_MB, warnLevelFor, warnLevelText } from "@/lib/imports/storage";

export const DB_STATUS_KEY = ["admin", "db-status"] as const;

/** Database size from `GET /admin/status`. The query is shared by the wizard and the Storage tab. */
export function useDbStatus() {
  return useQuery({ queryKey: DB_STATUS_KEY, queryFn: () => fetchDbStatus(), staleTime: 60_000 });
}

/** DB size against the 380 MB budget with 70/85/95% warnings (docs/04 section 3.10). */
export function StorageMeter() {
  const q = useDbStatus();
  if (q.isPending) return <Card title="Database size" state="loading" testId="storage-meter" />;
  if (q.isError) {
    return (
      <Card
        title="Database size"
        state="error"
        message={`Database size is not available: ${describeError(q.error)}`}
        onRetry={() => void q.refetch()}
        source="API /admin/status"
        testId="storage-meter"
      />
    );
  }
  const { db, asOf } = q.data;
  const level = db.warn_level ?? warnLevelFor(db.size_mb);
  const pct = Math.max(0, Math.min(100, (db.size_mb / DB_SOFT_LIMIT_MB) * 100));
  const tone =
    level === "ok" ? "bg-accent" : level === "limit" || level === "95" ? "bg-down" : "bg-warn";
  return (
    <Card
      title="Database size"
      source="API /admin/status"
      asOf={asOf}
      state={level === "ok" ? "ready" : "partial"}
      message={level === "ok" ? undefined : warnLevelText(level)}
      testId="storage-meter"
    >
      <div className="flex flex-col gap-2">
        <p className="text-body text-text-1" data-testid="storage-size-text">
          {formatMb(db.size_mb)} of {DB_SOFT_LIMIT_MB} MB (
          {formatPercentOf(db.size_mb, DB_SOFT_LIMIT_MB)})
        </p>
        <div
          role="meter"
          aria-label="Database size"
          aria-valuemin={0}
          aria-valuemax={DB_SOFT_LIMIT_MB}
          aria-valuenow={Math.min(db.size_mb, DB_SOFT_LIMIT_MB)}
          aria-valuetext={`${formatMb(db.size_mb)} of ${DB_SOFT_LIMIT_MB} MB`}
          data-testid="storage-meter-bar"
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
        <p className="text-caption text-text-2">
          Marks at 70%, 85% and 95%. Price imports stop at 100%.
        </p>
      </div>
    </Card>
  );
}
