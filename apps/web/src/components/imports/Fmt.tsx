import type { Formatted } from "@/lib/format";

/** Renders a formatter result; an unknown value keeps its reason as a tooltip (UI-02). */
export function Fmt({ f }: { f: Formatted }) {
  return f.reason === null ? <>{f.text}</> : <span title={f.reason}>{f.text}</span>;
}
