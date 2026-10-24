/** Join class names, skipping falsy values. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** Shared state vocabulary for Card and chart frames (docs/06a section 4). */
export type ViewState = "ready" | "loading" | "empty" | "partial" | "stale" | "error";
