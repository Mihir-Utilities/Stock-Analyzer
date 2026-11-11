import { ApiError, apiRequest } from "@/lib/api/client";
import { DASH, formatCount } from "@/lib/format";
import { describeError } from "./errors";
import {
  mfCandidateSchema,
  mfCommitResultSchema,
  mfDupGroupSchema,
  mfFundSchema,
  mfUnmappedSchema,
  mfValidateSchema,
  type MfCandidate,
  type MfFund,
  type MfValidateResult,
  type RowIssue,
} from "./schemas";
import { readRows } from "@/lib/portfolio/mf-schemas";
import { putMapping } from "@/lib/portfolio/mf-api";

// The mf_statement import (docs/03 12a, docs/01 7.9, MFH-23, MFH-24). Calls go to the same-origin
// API only. The preview shows normalised fields only; the file is never read in the browser.

export const MF_MAX_BYTES = 2 * 1024 * 1024;
export const MF_FILE_PATTERN = /\.(csv|txt|xlsx)$/i;

export async function validateMfStatement(file: File, signal?: AbortSignal) {
  const form = new FormData();
  form.append("file", file);
  const r = await apiRequest("/imports/mf_statement/validate", {
    method: "POST",
    body: form,
    schema: mfValidateSchema,
    signal,
  });
  return r.data;
}

/** Re-checks the stored upload against the current mappings; same upload id, 1 h TTL not extended. */
export async function revalidateMfStatement(uploadId: string) {
  const r = await apiRequest("/imports/mf_statement/revalidate", {
    method: "POST",
    body: { upload_id: uploadId },
    schema: mfValidateSchema,
  });
  return r.data;
}

export async function commitMfStatement(uploadId: string, note: string, excludedRows: number[]) {
  const body: { upload_id: string; note?: string; excluded_rows?: number[] } = {
    upload_id: uploadId,
  };
  if (note.trim()) body.note = note.trim();
  if (excludedRows.length > 0) body.excluded_rows = [...excludedRows].sort((a, b) => a - b);
  const r = await apiRequest("/imports/mf_statement/commit", {
    method: "POST",
    body,
    schema: mfCommitResultSchema,
  });
  return r.data;
}

export { putMapping };

/** Watchlist schemes first, everything else keeps the API order. The UI never picks one for the owner. */
export function orderCandidates(c: ReadonlyArray<MfCandidate>): MfCandidate[] {
  return [...c.filter((x) => x.on_watchlist), ...c.filter((x) => !x.on_watchlist)];
}

export interface UnmappedFund {
  fund_name: string;
  fund_name_key: string | null | undefined;
  rows: number;
  candidates: MfCandidate[];
}

export interface ReadMfPreview {
  unmapped: UnmappedFund[];
  funds: MfFund[];
  dupGroups: Array<{ rows: number[]; count: number }>;
  badRows: number;
}

/** Reads the `mf` block row by row so one bad candidate or fund never blanks the preview. */
export function readMfPreview(v: MfValidateResult): ReadMfPreview {
  let bad = 0;
  const un = readRows(mfUnmappedSchema, v.mf.unmapped_funds);
  bad += un.bad;
  const unmapped = un.rows.map((u): UnmappedFund => {
    const c = readRows(mfCandidateSchema, u.candidates);
    bad += c.bad;
    return {
      fund_name: u.fund_name,
      fund_name_key: u.fund_name_key,
      rows: u.rows,
      candidates: orderCandidates(c.rows),
    };
  });
  const funds = readRows(mfFundSchema, v.mf.funds);
  const dups = readRows(mfDupGroupSchema, v.mf.duplicate_groups);
  bad += funds.bad + dups.bad;
  return { unmapped, funds: funds.rows, dupGroups: dups.rows, badRows: bad };
}

/** Row errors other than the per-row UNMAPPED_FUND ones (those are answered by the mapping step). */
export function otherErrors(errors: ReadonlyArray<RowIssue>): RowIssue[] {
  return errors.filter((e) => e.code !== "UNMAPPED_FUND");
}

/** DUPLICATE_IN_FILE is informational: the rows stay selected (MFH-24). */
export function dupWarnings(w: ReadonlyArray<RowIssue>): RowIssue[] {
  return w.filter((x) => x.code === "DUPLICATE_IN_FILE");
}
export function otherWarnings(w: ReadonlyArray<RowIssue>): RowIssue[] {
  return w.filter((x) => x.code !== "DUPLICATE_IN_FILE");
}

/** Row 0 (whole file) and row 1 (the header) are file-level problems: they can never be excluded. */
export function isHeaderIssue(e: RowIssue): boolean {
  return e.row <= 1;
}

/** Errors that still block the commit: those not on an unticked data row (B15R-6). */
export function blockingErrors(errors: ReadonlyArray<RowIssue>, excluded: ReadonlySet<number>) {
  return errors.filter((e) => isHeaderIssue(e) || !excluded.has(e.row));
}

/**
 * Commit is allowed when no error blocks. The API lists only the first 200 errors: when more exist
 * the hidden ones cannot be unticked, so the count must be zero to proceed.
 */
export function canCommit(v: MfValidateResult | null, excluded: ReadonlySet<number>): boolean {
  if (v === null) return false;
  if (v.error_count === 0) return true;
  if (v.error_count > v.errors.length) return false;
  return blockingErrors(v.errors, excluded).length === 0;
}

/**
 * Plain copy for a failed call. The not-enabled .xlsx answer (B15R-1) gets its own sentence, but
 * only for a 422: the API sends no dedicated error code for it, only the message (F16R-3).
 */
export function isXlsxNotEnabled(e: unknown): boolean {
  return e instanceof ApiError && e.status === 422 && /xlsx not enabled/i.test(e.message);
}

export function describeMfError(e: unknown): string {
  if (isXlsxNotEnabled(e)) {
    return "Excel files are not enabled yet; save the statement as CSV.";
  }
  return describeError(e);
}

/**
 * Rows that will be written, as a range. The server tells how many rows are already stored but not
 * which, so an unticked row may be one of them: the count is between "rows minus both" and "rows
 * minus the larger of the two". Null when the numbers do not add up.
 */
export function rowsToImport(
  rows: number,
  excluded: number,
  duplicatesInDb: number,
): { min: number; max: number } | null {
  const min = rows - excluded - duplicatesInDb;
  const max = rows - Math.max(excluded, duplicatesInDb);
  if (![rows, excluded, duplicatesInDb].every(Number.isFinite) || max < 0) return null;
  return { min: Math.max(0, min), max };
}

/** "about 5 rows", or "between 4 and 5 rows" when an unticked row may already be stored. */
export function rowCountText(r: { min: number; max: number } | null): string {
  if (r === null) return `${DASH} rows`;
  return r.min === r.max
    ? `about ${formatCount(r.max).text} rows`
    : `between ${formatCount(r.min).text} and ${formatCount(r.max).text} rows`;
}

/** Plain-English text for the rows-by-type counts, in a fixed order. */
export const TYPE_ORDER = [
  "purchase",
  "sip",
  "redemption",
  "idcw_payout",
  "idcw_reinvest",
  "switch_in",
  "switch_out",
  "bonus_merger",
] as const;
