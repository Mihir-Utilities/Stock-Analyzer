import { z } from "zod";

// Zod schemas for the import endpoints (docs/03 sections 4 and 14, openapi.yaml). Only the fields
// the screens read are listed; unknown extra fields are ignored.

export const IMPORT_KINDS = [
  "instruments",
  "prices",
  "holidays",
  "results_quarterly",
  "results_annual",
  "balance_cashflow",
  "fundamentals_long",
  "shareholding",
  "corporate_actions",
  "instrument_meta",
  "mf_statement",
] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

export const rowIssueSchema = z.object({
  row: z.number(),
  column: z.string(),
  message: z.string(),
  /** Stable machine code, set for mf_statement issues (for example UNMAPPED_FUND). */
  code: z.string().optional(),
});
export type RowIssue = z.infer<typeof rowIssueSchema>;

export const validateResultSchema = z.object({
  upload_id: z.string(),
  upload_group: z.string().nullable(),
  rows: z.number(),
  preview: z.array(z.record(z.string(), z.unknown())),
  errors: z.array(rowIssueSchema),
  warnings: z.array(rowIssueSchema),
  error_count: z.number(),
  warning_count: z.number(),
  estimated_growth_mb: z.number().nullable(),
  prices_already_adjusted: z.boolean().nullable(),
});
export type ValidateResult = z.infer<typeof validateResultSchema>;

export const commitResultSchema = z.object({
  batch_id: z.number(),
  inserted: z.number(),
  updated: z.number(),
  renamed: z.number(),
  post_import_job_id: z.number().nullable(),
  warnings: z.array(z.string()),
});
export type CommitResult = z.infer<typeof commitResultSchema>;

// ---- mf_statement (docs/03 12a, MFH-23, MFH-24) -----------------------------------------------

const optStr = z.string().nullish().catch(null);

export const mfCandidateSchema = z.object({
  scheme_code: z.number(),
  name: z.string(),
  fund_house: optStr,
  plan: z.string().catch("unknown"),
  option: z.string().catch("unknown"),
  isin: optStr,
  on_watchlist: z.boolean().catch(false),
  has_nav: z.boolean().catch(false),
});
export type MfCandidate = z.infer<typeof mfCandidateSchema>;

export const mfUnmappedSchema = z.object({
  fund_name: z.string(),
  fund_name_key: optStr,
  rows: z.number().catch(0),
  candidates: z.array(z.unknown()).catch([]),
});

export const mfFundSchema = z.object({
  fund_name: z.string(),
  fund_name_key: optStr,
  rows: z.number().catch(0),
  mapped: z.boolean().catch(false),
  scheme_code: z.number().nullish().catch(null),
  scheme_name: optStr,
  plan: optStr,
  option: optStr,
});
export type MfFund = z.infer<typeof mfFundSchema>;

export const mfDupGroupSchema = z.object({ rows: z.array(z.number()), count: z.number() });

export const mfPreviewSchema = z.object({
  date_from: optStr,
  date_to: optStr,
  rows_by_type: z.record(z.string(), z.number()).catch({}),
  funds: z.array(z.unknown()).catch([]),
  unmapped_funds: z.array(z.unknown()).catch([]),
  fund_mappings: z.array(z.unknown()).catch([]),
  duplicate_groups: z.array(z.unknown()).catch([]),
  duplicates_in_db: z.number().catch(0),
});
export type MfPreview = z.infer<typeof mfPreviewSchema>;

/** Validate and revalidate answer of the mf_statement kind: the usual envelope plus `mf`. */
export const mfValidateSchema = validateResultSchema.extend({ mf: mfPreviewSchema });
export type MfValidateResult = z.infer<typeof mfValidateSchema>;

export const mfCommitResultSchema = z.object({
  batch_id: z.number(),
  inserted: z.number(),
  skipped_duplicates: z.number().catch(0),
  warnings: z.array(z.string()).catch([]),
});
export type MfCommitResult = z.infer<typeof mfCommitResultSchema>;

export const pricesAdjustmentSchema = z.object({
  value: z.boolean().nullable(),
  set_at: z.string().nullable(),
});

export const adjustmentCheckSchema = z.object({
  bars: z.array(z.tuple([z.string(), z.number()])),
  ratio: z.number(),
  nearest_fraction: z.string().nullable(),
  hint: z.enum(["raw_likely", "adjusted_likely", "inconclusive"]),
});
export type AdjustmentCheck = z.infer<typeof adjustmentCheckSchema>;

export const instrumentCreatedSchema = z.object({
  id: z.number(),
  symbol: z.string(),
  warnings: z.array(z.string()),
});

export const symbolRowsSchema = z.object({ symbol: z.string(), rows: z.number() });

export const deletePreviewSchema = z.object({ rows: z.number() });
export const deleteResultSchema = z.object({
  deleted: z.number(),
  job_id: z.number().nullable(),
  batch_id: z.number().nullable(),
});

export const trimPreviewSchema = z.object({
  per_symbol: z.array(symbolRowsSchema),
  total_rows: z.number(),
  estimated_mb_freed: z.number(),
});
export const trimResultSchema = z.object({
  deleted: z.number(),
  per_symbol: z.array(symbolRowsSchema),
  batch_id: z.number().nullable(),
  job_id: z.number().nullable(),
});

/** `GET /stocks/index`: items are [id, symbol, name, flags] (docs/03 section 3). */
export const stockIndexSchema = z.object({
  items: z.array(z.tuple([z.number(), z.string(), z.string(), z.number()])),
});

/** `GET /admin/status`, the database part only (docs/03 section 15). */
export const adminDbSchema = z.object({
  db: z.object({
    size_mb: z.number(),
    warn_level: z.enum(["ok", "70", "85", "95", "limit"]).optional(),
  }),
});

/** `GET /imports/batches` item (docs/03 section 14). */
export const batchSchema = z.object({
  id: z.number(),
  kind: z.string(),
  upload_group: z.string().nullable(),
  row_count: z.number(),
  warning_count: z.number(),
  note: z.string().nullable(),
  created_at: z.string(),
  undone_at: z.string().nullable(),
});
export type Batch = z.infer<typeof batchSchema>;
export const batchListSchema = z.object({
  items: z.array(batchSchema),
  next_cursor: z.string().nullable().optional(),
});

export const undoResultSchema = z.object({
  batch_id: z.number(),
  removed: z.number(),
  post_import_job_id: z.number().nullable(),
  warnings: z.array(z.string()),
  earlier_batch_ids: z.array(z.number()),
});
export type UndoResult = z.infer<typeof undoResultSchema>;

/** Manual entry answer (201, or 200 when only updated): warnings are `{field, code, message}`. */
export const manualWarningSchema = z.object({
  field: z.string(),
  code: z.string(),
  message: z.string(),
});
export const manualResultSchema = z.object({
  id: z.number().optional(),
  batch_id: z.number(),
  inserted: z.number(),
  updated: z.number(),
  warnings: z.array(manualWarningSchema),
  post_import_job_id: z.number().nullable(),
});
export type ManualResult = z.infer<typeof manualResultSchema>;

export const manualDeleteSchema = z.object({
  deleted: z.number(),
  batch_id: z.number().nullable(),
  post_import_job_id: z.number().nullable(),
  warnings: z.array(z.string()),
});
export type ManualDelete = z.infer<typeof manualDeleteSchema>;
