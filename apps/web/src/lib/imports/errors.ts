import { ApiError } from "@/lib/api/client";

export interface FieldMessage {
  field: string;
  message: string;
}

/** `details.fields[]` of a 422 (docs/03 section 1). */
export function fieldErrors(error: unknown): FieldMessage[] {
  if (!(error instanceof ApiError)) return [];
  const fields = error.details?.fields;
  if (!Array.isArray(fields)) return [];
  const out: FieldMessage[] = [];
  for (const f of fields) {
    if (typeof f === "object" && f !== null) {
      const rec = f as Record<string, unknown>;
      if (typeof rec.field === "string" && typeof rec.message === "string") {
        out.push({ field: rec.field, message: rec.message });
      }
    }
  }
  return out;
}

export function fieldMessage(error: unknown, field: string): string | null {
  return fieldErrors(error).find((f) => f.field === field)?.message ?? null;
}

/** One plain sentence for any thrown value; never raw stack or JSON. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "NOT_IMPLEMENTED")
      return "This function is not available on the server yet.";
    return error.message;
  }
  return "Something went wrong. Try again.";
}

export function isApiError(error: unknown, code: string): boolean {
  return error instanceof ApiError && error.code === code;
}
