import { z } from "zod";

// Shapes of docs/03 section 13 and B12 notes (openapi `Alert`, `AlertEvent`, `LinkCode`). Unknown
// fields are ignored; unknown values stay null (never 0).

export const alertTargetSchema = z.object({
  type: z.enum(["stock", "mf"]),
  symbol: z.string().nullish(),
  code: z.number().nullish(),
  name: z.string().nullish(),
});

export const alertSchema = z.object({
  id: z.number(),
  target: alertTargetSchema,
  kind: z.string(),
  params: z.record(z.string(), z.unknown()),
  status: z.enum(["active", "paused", "fired", "expired"]),
  one_shot: z.boolean(),
  cooldown_minutes: z.number(),
  expires_on: z.string().nullish(),
  last_fired_at: z.string().nullish(),
  created_at: z.string(),
});
export type AlertItem = z.infer<typeof alertSchema>;

export const alertPageSchema = z.object({
  items: z.array(alertSchema),
  next_cursor: z.string().nullable(),
});

export const alertEventSchema = z.object({
  id: z.number(),
  alert_id: z.number(),
  kind: z.string(),
  target: alertTargetSchema,
  fired_at: z.string(),
  delivery_status: z.string(),
  delivery_attempts: z.number(),
  delivered_at: z.string().nullish(),
  last_error: z.string().nullish(),
});
export type AlertEventItem = z.infer<typeof alertEventSchema>;

export const alertEventPageSchema = z.object({
  items: z.array(alertEventSchema),
  next_cursor: z.string().nullable(),
});

export const okSchema = z.object({ ok: z.boolean() });

export const linkCodeSchema = z.object({
  code: z.string(),
  expires_at: z.string(),
  bot_username: z.string().nullable(),
  deep_link: z.string().nullable(),
});
export type LinkCode = z.infer<typeof linkCodeSchema>;

export const meSchema = z.object({
  authenticated: z.boolean(),
  telegram_linked: z.boolean(),
  prefs: z.record(z.string(), z.unknown()).nullish(),
});

/** `details` of the 422 THRESHOLD_ALREADY_MET (B12 notes). */
export const thresholdDetailsSchema = z.object({
  kind: z.string(),
  threshold: z.number(),
  value: z.number(),
  as_of: z.string(),
});
