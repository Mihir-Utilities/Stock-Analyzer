// Readable labels for API strings the dashboard prints. Known values come from docs/03 section 12
// (alert kinds, delivery statuses) and docs/04 section 1 (job statuses); anything else is
// humanised (snake_case / kebab-case to words) so a raw identifier is never shown.

/** "skipped_quiet_hours" -> "Skipped quiet hours"; empty input -> "Unknown". */
export function humanize(raw: string | null | undefined): string {
  const words = (raw ?? "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_\-\s]+/g, " ")
    .trim()
    .toLowerCase();
  if (words === "") return "Unknown";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function labeller(known: Record<string, string>) {
  return (raw: string | null | undefined): string => {
    const hit = raw === null || raw === undefined ? undefined : known[raw];
    return hit ?? humanize(raw);
  };
}

export const alertKindLabel = labeller({
  price_above: "Price above",
  price_below: "Price below",
  day_change_pct: "Day change",
  wk52_high: "New 52-week high",
  wk52_low: "New 52-week low",
  ma_cross: "Moving-average cross",
  rsi_above: "RSI above",
  rsi_below: "RSI below",
  results_upcoming: "Results upcoming",
  results_declared: "Results declared",
  holding_change: "Holding change",
  nav_above: "NAV above",
  nav_below: "NAV below",
});

export const deliveryStatusLabel = labeller({
  pending: "Pending",
  sent: "Sent",
  failed: "Failed",
  skipped_quiet_hours: "Skipped (quiet hours)",
});

export const jobStatusLabel = labeller({
  running: "Running",
  success: "Succeeded",
  succeeded: "Succeeded",
  partial: "Partly succeeded",
  failed: "Failed",
  skipped: "Skipped",
});

/** Event types may be owner-entered ("AGM", "Results"): only identifiers (snake_case) change. */
export function eventTypeLabel(raw: string | null | undefined): string {
  if (!raw || raw.trim() === "") return "Event";
  return /[_-]/.test(raw) ? humanize(raw) : raw;
}

/** Job names are identifiers such as `import_prices`: shown as words. */
export function jobNameLabel(raw: string | null | undefined): string {
  return raw ? humanize(raw) : "Job";
}
