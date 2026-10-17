import type { components, paths } from "./schema";

export type { components, paths };

/** Success envelope `{ data, meta, warnings }` (docs/03-api-spec.md section 1). */
export type SuccessEnvelope = components["schemas"]["SuccessEnvelope"];
/** Error envelope `{ error: { code, message, details } }`. */
export type ErrorEnvelope = components["schemas"]["ErrorEnvelope"];
export type ErrorBody = components["schemas"]["ErrorBody"];
export type Meta = components["schemas"]["Meta"];
export type Warning = components["schemas"]["Warning"];
export type FieldError = components["schemas"]["FieldError"];
