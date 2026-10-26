import type { Batch } from "./schemas";

/** Kinds whose batches can be undone within 30 days (docs/03 section 14, B06b-4). */
export const UNDOABLE_KINDS: readonly string[] = [
  "results_quarterly",
  "results_annual",
  "balance_cashflow",
  "fundamentals_long",
  "shareholding",
  "corporate_actions",
];

export const UNDO_WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;

export const KIND_NAMES: Record<string, string> = {
  prices: "Prices",
  instruments: "Stock list",
  holidays: "Holidays",
  results_quarterly: "Quarterly results",
  results_annual: "Annual results",
  balance_cashflow: "Balance sheet and cash flow",
  fundamentals_long: "Fundamentals (long format)",
  shareholding: "Shareholding",
  corporate_actions: "Corporate actions",
  instrument_meta: "Sector and index tags",
  manual_form: "Manual entry",
  screener_xlsx: "Screener file",
};

export type UndoVerdict = { undoable: true } | { undoable: false; reason: string };

/** Whether the Undo button is offered. The API stays authoritative (409 on any other case). */
export function undoVerdict(batch: Batch, now: number = Date.now()): UndoVerdict {
  if (batch.undone_at !== null) return { undoable: false, reason: "Already undone." };
  if (batch.kind === "manual_form") {
    return {
      undoable: false,
      reason: "Manual entries cannot be undone here. Delete the manual period or enter it again.",
    };
  }
  if (!UNDOABLE_KINDS.includes(batch.kind)) {
    return {
      undoable: false,
      reason: "This kind of batch cannot be undone. Import corrected data to change it.",
    };
  }
  const created = Date.parse(batch.created_at);
  if (!Number.isNaN(created) && now - created > UNDO_WINDOW_DAYS * DAY_MS) {
    return { undoable: false, reason: `Older than ${UNDO_WINDOW_DAYS} days.` };
  }
  return { undoable: true };
}
