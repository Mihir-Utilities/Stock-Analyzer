import { ApiError } from "@/lib/api/client";
import { formatDate, formatNumber } from "@/lib/format";
import { displayNumber, isPlainDecimal, plainString, qtyDecimals, toDec } from "./decimal";

// Pure logic of the transaction form (docs/06 section 6.7, docs/03 section 12). Amounts stay
// strings end to end: they are validated as plain decimals and sent as strings, never parsed to
// floats (PF-12). The server remains the authority; these checks only save a round trip.

export interface TxnDraft {
  symbol: string;
  side: "buy" | "sell";
  qty: string;
  price: string;
  fees: string;
  tradeDate: string;
  note: string;
}

export type FieldKey = keyof TxnDraft;
export type FieldErrors = Partial<Record<FieldKey, string>>;

export interface TxnBody {
  symbol: string;
  side: "buy" | "sell";
  qty: string;
  price: string;
  fees: string;
  trade_date: string;
  note: string;
}

export const EMPTY_DRAFT: TxnDraft = {
  symbol: "",
  side: "buy",
  qty: "",
  price: "",
  fees: "",
  tradeDate: "",
  note: "",
};

const MAX_QTY = "1000000000";
/** Same as the server's moneyMax (apps/api internal/portfolio/input.go: 1e13) for price and fees. */
export const MAX_MONEY = "10000000000000";

/** True for a real calendar date written YYYY-MM-DD ("2026-02-31" is not one). */
export function isCalendarDate(v: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (m === null) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/** Client-side validation mirroring docs/03 section 12; `today` is the IST date (YYYY-MM-DD). */
export function validateDraft(
  d: TxnDraft,
  today: string,
): { errors: FieldErrors; body: TxnBody | null } {
  const errors: FieldErrors = {};
  const symbol = d.symbol.trim().toUpperCase();
  if (symbol === "") errors.symbol = "Enter the exchange symbol, for example TCS.";
  else if (!/^[A-Z0-9&-]{1,20}$/.test(symbol)) errors.symbol = "Use letters, digits, & or - only.";

  const qty = d.qty.trim();
  if (!isPlainDecimal(qty, 4)) errors.qty = "Enter a number with up to 4 decimals, e.g. 10.";
  else {
    const q = toDec(qty);
    if (q === null || !q.gt(0)) errors.qty = "Quantity must be greater than 0.";
    else if (q.gt(MAX_QTY)) errors.qty = "Quantity must be at most 1,000,000,000.";
  }

  const price = d.price.trim();
  if (!isPlainDecimal(price, 4)) errors.price = "Enter a price in INR with up to 4 decimals.";
  else if (!(toDec(price)?.gt(0) ?? false)) errors.price = "Price must be greater than 0.";
  else if (toDec(price)?.gt(MAX_MONEY)) {
    errors.price = "Price must be greater than 0 and at most 10,000,000,000,000.";
  }

  const fees = d.fees.trim();
  if (fees !== "" && !isPlainDecimal(fees, 4)) {
    errors.fees = "Enter fees in INR with up to 4 decimals, or leave empty for none.";
  } else if (fees !== "" && toDec(fees)?.gt(MAX_MONEY)) {
    errors.fees = "Fees must be 0 or more and at most 10,000,000,000,000.";
  }

  if (!isCalendarDate(d.tradeDate)) {
    errors.tradeDate = "Choose a real calendar date (YYYY-MM-DD).";
  } else if (d.tradeDate > today) {
    errors.tradeDate = "The trade date cannot be in the future.";
  }
  if (d.note.length > 500) errors.note = "The note can have at most 500 characters.";

  if (Object.keys(errors).length > 0) return { errors, body: null };
  return {
    errors,
    body: {
      symbol,
      side: d.side,
      qty,
      price,
      fees: fees === "" ? "0" : fees,
      trade_date: d.tradeDate,
      note: d.note,
    },
  };
}

/** The fields of `next` that really differ from the stored transaction (compared normalised). */
export function changedFields(orig: TxnDraft, next: TxnBody): Partial<TxnBody> {
  const changed: Partial<TxnBody> = {};
  if (next.symbol !== orig.symbol.trim().toUpperCase()) changed.symbol = next.symbol;
  if (next.side !== orig.side) changed.side = next.side;
  if (plainString(next.qty) !== plainString(orig.qty)) changed.qty = next.qty;
  if (plainString(next.price) !== plainString(orig.price)) changed.price = next.price;
  if (plainString(next.fees) !== plainString(orig.fees === "" ? "0" : orig.fees)) {
    changed.fees = next.fees;
  }
  if (next.trade_date !== orig.tradeDate) changed.trade_date = next.trade_date;
  if (next.note !== orig.note) changed.note = next.note;
  return changed;
}

/**
 * Weekend or listed-holiday warning (warning only; PF-06). `holidays` is null when the list is
 * not available for the year, in which case only weekends can be known.
 */
export function nonTradingWarning(
  date: string,
  holidays: ReadonlySet<string> | null,
): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  const shown = formatDate(date).text;
  if (day === 0 || day === 6) {
    return `${shown} is a weekend. The market was closed; check the date. You can still save it.`;
  }
  if (holidays?.has(date)) {
    return `${shown} is a listed market holiday. Check the date. You can still save it.`;
  }
  return null;
}

// ---- idempotency (docs/03 section 1: Idempotency-Key, 24 h; PF-11, PF-16, PF-17) ------------

export interface Attempt {
  key: string;
  bodyJson: string;
}

export function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (typeof c.randomUUID === "function") return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * One key per submit attempt. A retry of the same attempt (same body, previous try did not
 * succeed) reuses the key so the server collapses duplicates; any change of the body is a new
 * attempt with a new key (same key + different body would be a 409).
 */
export function nextAttempt(
  prev: Attempt | null,
  body: TxnBody,
  makeKey: () => string = newIdempotencyKey,
): Attempt {
  const bodyJson = JSON.stringify(body);
  return prev !== null && prev.bodyJson === bodyJson ? prev : { key: makeKey(), bodyJson };
}

// ---- server errors --------------------------------------------------------------------------

const FIELD_MAP: Record<string, FieldKey> = {
  symbol: "symbol",
  side: "side",
  qty: "qty",
  price: "price",
  fees: "fees",
  trade_date: "tradeDate",
  note: "note",
};

export interface TxnErrorView {
  message: string;
  fields: FieldErrors;
  /** Network, timeout or 5xx: retrying with the same Idempotency-Key is safe. */
  retryable: boolean;
  /** The response may have been lost after the server committed: the list should be refetched. */
  lost: boolean;
  /** 409: the request key was already used for different values, so the next try needs a new key. */
  conflict: boolean;
}

const NO_FLAGS = { retryable: false, lost: false, conflict: false } as const;

function qtyText(v: unknown): string {
  const s = typeof v === "string" ? v : "";
  return formatNumber(displayNumber(s), { decimals: qtyDecimals(s) }).text;
}

/** Turns an API failure into text for the form. The server's own detail is always shown. */
export function describeTxnError(err: unknown): TxnErrorView {
  if (!(err instanceof ApiError)) {
    return { message: "The transaction could not be saved.", fields: {}, ...NO_FLAGS };
  }
  if (err.code === "TIMEOUT" || err.code === "NETWORK" || err.status >= 500) {
    return {
      message: `${err.message} Nothing was confirmed; press Save again to retry safely (the same request key is reused, so it cannot be recorded twice). Check the list before changing values: if you change anything, it is sent as a new transaction.`,
      fields: {},
      retryable: true,
      lost: err.code === "TIMEOUT" || err.code === "NETWORK",
      conflict: false,
    };
  }
  if (err.code === "INSUFFICIENT_HOLDINGS") {
    const d = err.details ?? {};
    const date = typeof d["date"] === "string" ? formatDate(d["date"]).text : null;
    const detail =
      date !== null
        ? ` On ${date} you hold ${qtyText(d["held_qty"])} shares and the sell is for ${qtyText(d["sell_qty"])}.`
        : "";
    return {
      message: `${err.message}.${detail} Buys on the same day count before sells.`,
      fields: {},
      ...NO_FLAGS,
    };
  }
  const fields: FieldErrors = {};
  const raw = err.details?.["fields"];
  if (Array.isArray(raw)) {
    for (const f of raw) {
      if (typeof f !== "object" || f === null) continue;
      const rec = f as Record<string, unknown>;
      const key = typeof rec["field"] === "string" ? FIELD_MAP[rec["field"]] : undefined;
      if (key && typeof rec["message"] === "string") fields[key] = rec["message"];
    }
  }
  return {
    message:
      err.status === 409
        ? `${err.message} The server already holds a request with this key but different values. Check the transaction list; pressing Save again sends these values as a new request.`
        : err.message,
    fields,
    ...NO_FLAGS,
    conflict: err.status === 409,
  };
}
