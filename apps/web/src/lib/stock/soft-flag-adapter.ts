// Dismissal of the softer split/bonus notice (decisions D-O, D-U). The endpoints that store a
// dismissal (`flag_dismissals`) belong to task B07, which is not merged yet, so there is nothing
// to call. B07's UI work fills `dismissSoftFlag` and flips `SOFT_FLAG_DISMISS_AVAILABLE`; until
// then the Dismiss control is shown disabled with this reason (F05-5). Nothing is stored locally:
// a browser-only dismissal would silently differ from the server's after B07.

export const SOFT_FLAG_DISMISS_AVAILABLE = false;

export const SOFT_FLAG_DISMISS_UNAVAILABLE_REASON =
  "Dismiss is not available yet: saving a dismissal needs the corporate-action service, which is not built.";

export async function dismissSoftFlag(symbol: string, date: string): Promise<void> {
  throw new Error(`${SOFT_FLAG_DISMISS_UNAVAILABLE_REASON} (${symbol}, ${date})`);
}

/** Confirm / Reject of a detected action (UNCONFIRMED_ACTION banner) is the same dependency. */
export const ACTION_DECISION_AVAILABLE = false;

export const ACTION_DECISION_UNAVAILABLE_REASON =
  "Confirm and Reject are not available yet: they need the corporate-action service, which is not built.";
