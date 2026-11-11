import { z } from "zod";

// GET /admin/status (docs/03 section 15). Row shapes follow the table columns in docs/02
// (`source_health`, `ingestion_run`); the doc names the rows but not their JSON keys, so every
// field is optional and an absent one is shown as a dash with a reason (F15-1).
const str = z.string().nullish();
const num = z.number().nullish();

export const sourceRowSchema = z.object({
  source: z.string(),
  checked_at: str,
  ok: z.boolean().nullish(),
  latency_ms: num,
  consecutive_failures: num,
  disabled_until: str,
  note: str,
});

export const jobRowSchema = z.object({
  job: z.string(),
  started_at: str,
  finished_at: str,
  status: str,
  rows_written: num,
  items_total: num,
  items_failed: num,
  error: str,
});

export const adminStatusFullSchema = z.object({
  sources: z.array(sourceRowSchema).nullish(),
  jobs: z.array(jobRowSchema).nullish(),
  coverage: z
    .object({
      instruments: num,
      tracked: num,
      with_prices: num,
      with_fundamentals: num,
      with_shareholding: num,
    })
    .nullish(),
  db: z
    .object({
      size_mb: num,
      tables: z.array(z.object({ name: z.string(), mb: num, rows: num })).nullish(),
      warn_level: z.enum(["ok", "70", "85", "95", "limit"]).nullish(),
    })
    .nullish(),
  holiday_list_missing_years: z.array(z.number()).nullish(),
  version: str,
  // docs/03 writes `{...}`: keys are unspecified, so primitives are listed as key and value (F15-2).
  storage_policy: z.record(z.string(), z.unknown()).nullish(),
});

export type AdminStatusFull = z.infer<typeof adminStatusFullSchema>;
export type SourceRow = z.infer<typeof sourceRowSchema>;
export type JobRow = z.infer<typeof jobRowSchema>;

/** Sources the owner sees (docs/06 section 6.12). The broker is dormant in manual price mode. */
export const SOURCE_ORDER = ["mfapi", "amfi", "telegram"] as const;

/** Failed or partial latest runs that carry an error text (F15-3). */
export function recentErrors(jobs: readonly JobRow[]): JobRow[] {
  const when = (j: JobRow) => j.finished_at ?? j.started_at ?? "";
  return jobs
    .filter((j) => (j.status === "failed" || j.status === "partial") && !!j.error)
    .sort((a, b) => when(b).localeCompare(when(a)))
    .slice(0, 50);
}

/** Wall time of a finished run in ms; null while running or when a timestamp is missing. */
export function runDurationMs(job: JobRow): number | null {
  if (!job.started_at || !job.finished_at) return null;
  const a = Date.parse(job.started_at);
  const b = Date.parse(job.finished_at);
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? b - a : null;
}

export function holidayWarning(year: number): string {
  return `Holiday list missing for ${year}: weekends only; import holidays.csv`;
}
