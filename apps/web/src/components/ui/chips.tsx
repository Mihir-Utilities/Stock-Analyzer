import type { ReactNode } from "react";
import { cx } from "./cx";

function Chip({
  children,
  testId,
  tone = "neutral",
}: {
  children: ReactNode;
  testId: string;
  tone?: "neutral" | "warn";
}) {
  return (
    <span
      data-testid={testId}
      className={cx(
        "inline-flex items-center gap-1 rounded-chip border bg-surface-2 px-2 py-0.5 text-micro",
        tone === "warn" ? "border-warn text-text-1" : "border-border text-text-2",
      )}
    >
      {children}
    </span>
  );
}

/** Source of a number, e.g. "AMFI NAV file". */
export function SourceChip({ source }: { source: string }) {
  return <Chip testId="source-chip">Source: {source}</Chip>;
}

/** As-of date. Stale gets an amber border and the word "stale", so colour is not the only signal. */
export function AsOfChip({ asOf, stale = false }: { asOf: string | null; stale?: boolean }) {
  return (
    <Chip testId="asof-chip" tone={stale ? "warn" : "neutral"}>
      {asOf === null ? "As of: unknown" : `As of ${asOf}`}
      {stale ? " (stale)" : ""}
    </Chip>
  );
}

/** Data depth, e.g. "5 quarters, 4 years" (text built by the caller via format.ts). */
export function DepthChip({ text }: { text: string }) {
  return <Chip testId="depth-chip">{text}</Chip>;
}
