import { cx } from "./cx";

/** Placeholder with the final layout's dimensions (pass width/height classes). */
export function Skeleton({ className, label = "Loading" }: { className?: string; label?: string }) {
  return (
    <div
      role="status"
      aria-label={label}
      data-testid="skeleton"
      className={cx("animate-pulse rounded-control bg-surface-3", className ?? "h-4 w-full")}
    />
  );
}
