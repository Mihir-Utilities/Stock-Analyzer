import { AlertTriangle, FlaskConical, Info } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "./cx";

/**
 * Fixed copy for forecast views; it has no dismiss control (docs/06a section 4). Callers may pass
 * the exact copy owned by docs/06 and docs/05; this default never shows a single target price.
 */
export const EXPERIMENTAL_COPY =
  "Experimental. Model output is a probability range, not advice and not a target price.";

export function ExperimentalBanner({ children = EXPERIMENTAL_COPY }: { children?: ReactNode }) {
  return (
    <div
      role="note"
      data-testid="experimental-banner"
      className="flex items-start gap-2 rounded-control border border-exp bg-surface-2 px-3 py-2 text-body-sm text-text-1"
    >
      <FlaskConical
        size={16}
        strokeWidth={1.75}
        className="mt-0.5 shrink-0 text-exp"
        aria-hidden="true"
      />
      <span>{children}</span>
    </div>
  );
}

/** Page or card level banner for API `warnings[]` and notes; always rendered, never hidden. */
export function Banner({
  tone = "info",
  children,
  testId = "banner",
}: {
  tone?: "info" | "warn" | "error";
  children: ReactNode;
  testId?: string;
}) {
  const Icon = tone === "info" ? Info : AlertTriangle;
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      data-testid={testId}
      data-tone={tone}
      className={cx(
        "flex items-start gap-2 rounded-control border bg-surface-2 px-3 py-2 text-body-sm text-text-1",
        tone === "error" ? "border-down" : tone === "warn" ? "border-warn" : "border-info",
      )}
    >
      <Icon
        size={16}
        strokeWidth={1.75}
        className={cx(
          "mt-0.5 shrink-0",
          tone === "error" ? "text-down" : tone === "warn" ? "text-warn" : "text-info",
        )}
        aria-hidden="true"
      />
      <span>{children}</span>
    </div>
  );
}
