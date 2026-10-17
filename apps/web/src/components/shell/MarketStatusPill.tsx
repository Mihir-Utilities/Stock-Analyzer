// Placeholder (F01): the live open/closed state arrives with the price header (F05). Until then
// the pill says plainly that nothing is known, instead of guessing from the clock.
export function MarketStatusPill() {
  return (
    <span
      data-testid="market-status-pill"
      title="Market status is not available yet. Prices come from your imports, so no live quote is shown."
      className="inline-flex items-center gap-1.5 rounded-chip bg-surface-3 px-2.5 py-1 text-caption text-text-2"
    >
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-text-3" />
      Market status: <span aria-label="not available">&mdash;</span>
    </span>
  );
}
