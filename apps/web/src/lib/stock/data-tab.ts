import { apiRequest } from "@/lib/api/client";
import { pricesAdjustmentSchema } from "@/lib/imports/schemas";
import { formatDate } from "@/lib/format";

// Data tab (docs/06 6.4 Data, docs/01 3.7 adjustment policy, decision D-K). Only what the API
// serves is shown; what it does not serve (sources used, suspect row count, which stocks a batch
// touched) gets a stated reason instead of a number (assumption F08-3).

export const adjustmentKey = ["settings", "prices-adjustment"] as const;

export async function getPricesAdjustment() {
  const r = await apiRequest("/settings/prices-adjustment", { schema: pricesAdjustmentSchema });
  return r.data;
}

/** One honest sentence for the global PRICES_ALREADY_ADJUSTED setting (null = not chosen yet). */
export function adjustmentSentence(value: boolean | null): string {
  if (value === null) {
    return "You have not told the app whether your price files are raw or already adjusted. A prices file cannot be imported until you choose in the import wizard.";
  }
  return value
    ? "Your price files are treated as already adjusted for splits and bonus (PRICES_ALREADY_ADJUSTED is on). The app never multiplies those bars again, so confirming an action does not change them."
    : "Your price files are treated as raw (PRICES_ALREADY_ADJUSTED is off). History is adjusted only for splits and bonus you confirm, using the ratios you enter. Dividends are not adjusted, so returns are price returns.";
}

export const ADJUSTMENT_MIX_WARNING =
  "The setting applies to every price file. Each stored bar keeps the setting it was imported under, and a bar imported as already adjusted is never adjusted again. Do not mix raw and already adjusted files for one stock.";

export const ADJUSTMENT_CHECK_INFO =
  'Not sure which kind your file is? In the import wizard, choose "I don\'t know" and run the Adjustment check on a split or bonus you know about. It compares the closes around the ex-date and gives a hint only; you decide, and nothing is written by the check.';

const ISO = /\d{4}-\d{2}-\d{2}/;

/**
 * The ADJUSTMENT_CONFLICT warning text of docs/01 3.7. Always the spec sentence; the date is taken
 * from the API message when it has one and left out otherwise, never invented.
 */
export function adjustmentConflictText(message: string): string {
  const m = ISO.exec(message);
  const when = m ? `on ${formatDate(m[0]).text} ` : "";
  return `A possible split/bonus ${when}was found inside prices imported as already adjusted. Check which file is raw. Nothing was adjusted automatically.`;
}
