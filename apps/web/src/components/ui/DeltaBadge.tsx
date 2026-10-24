import { ArrowDown, ArrowUp, Minus } from "lucide-react";
import { cx } from "./cx";

/**
 * Arrow + signed value + colour; neutral for zero or unknown. `text` is already formatted by
 * format.ts (sign and %), `value` only decides direction. Arrow shape and sign are the non-colour
 * signal. Unknown shows "n/a", never 0.
 */
export function DeltaBadge({ value, text }: { value: number | null; text: string | null }) {
  const known = value !== null && Number.isFinite(value) && text !== null;
  const dir = !known || value === 0 ? "flat" : value > 0 ? "up" : "down";
  const Icon = dir === "up" ? ArrowUp : dir === "down" ? ArrowDown : Minus;
  return (
    <span
      data-testid="delta-badge"
      data-direction={dir}
      className={cx(
        "num inline-flex items-center gap-0.5 text-body-sm font-medium",
        dir === "up" && "text-up",
        dir === "down" && "text-down",
        dir === "flat" && "text-text-2",
      )}
    >
      <Icon size={12} strokeWidth={2} aria-hidden="true" />
      {known ? text : "n/a"}
    </span>
  );
}
