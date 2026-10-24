import { z } from "zod";

// Zod schemas for the import endpoints (docs/03 sections 4 and 14, openapi.yaml). Only the fields
// the screens read are listed; unknown extra fields are ignored.

export const IMPORT_KINDS = ["instruments", "prices"] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

export const rowIssueSchema = z.object({
  row: z.number(),
  column: z.string(),
  message: z.string(),
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
