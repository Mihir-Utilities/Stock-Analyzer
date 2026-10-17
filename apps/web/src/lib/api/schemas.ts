import { z } from "zod";
import type { ErrorEnvelope, Meta, Warning } from "@analyzer/api-types";

// Runtime validation of the envelopes in docs/03-api-spec.md section 1. The `satisfies` checks tie
// each schema to the types generated from openapi.yaml, so a contract change breaks the build here.

export const metaSchema = z
  .object({
    as_of: z.string().optional(),
    source: z.string().optional(),
    stale: z.boolean().optional(),
    stale_age_hours: z.number().optional(),
    interval: z.enum(["1d", "1w"]).optional(),
    excluded_for_missing: z.record(z.string(), z.number()).optional(),
  })
  .catchall(z.unknown()) satisfies z.ZodType<Meta>;

export const warningSchema = z.object({
  code: z.string(),
  message: z.string(),
}) satisfies z.ZodType<Warning>;

export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
}) satisfies z.ZodType<ErrorEnvelope>;

/** Success envelope with the endpoint-specific `data` schema supplied by the caller. */
export function successEnvelopeSchema<T extends z.ZodType>(data: T) {
  return z.object({
    data,
    meta: metaSchema.optional(),
    warnings: z.array(warningSchema).optional(),
  });
}

/** Generic `{ items, next_cursor }` page (docs/03 section 1, pagination). */
export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), next_cursor: z.string().nullable() });
}
