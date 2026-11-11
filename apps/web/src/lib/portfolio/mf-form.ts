import { ApiError } from "@/lib/api/client";
import { formatDate, formatNumber } from "@/lib/format";
import { displayNumber, isPlainDecimal, money4, plainString, toDec } from "./decimal";
import { isCalendarDate, MAX_MONEY, newIdempotencyKey } from "./txn-form";
import Decimal from "decimal.js";
import { SWITCH_NOT_SUPPORTED_COPY } from "@/components/portfolio/text";

// Pure logic of the MF transaction form (docs/06 6.7a, docs/03 12a). Units, NAV and amounts stay
// strings end to end (never floats). The server stays the authority; these checks save a round trip.

/** The five v1 types (MFH-4). switch_in, switch_out and bonus_merger are not offered. */
export const MF_TXN_TYPES = [
  "purchase",
  "sip",
  "redemption",
  "idcw_payout",
  "idcw_reinvest",
] as const;
export type MfTxnType = (typeof MF_TXN_TYPES)[number];

export const MF_TYPE_LABEL: Record<string, string> = {
  purchase: "Purchase",
  sip: "SIP",
  redemption: "Redemption",
  idcw_payout: "IDCW payout",
  idcw_reinvest: "IDCW reinvestment",
  switch_in: "Switch in",
  switch_out: "Switch out",
  bonus_merger: "Bonus or merger",
};

export function typeLabel(t: string): string {
  return MF_TYPE_LABEL[t] ?? t.replace(/_/g, " ");
}

export interface MfDraft {
  schemeCode: string;
  schemeName: string;
  folio: string;
  type: MfTxnType;
  date: string;
  units: string;
  nav: string;
  amount: string;
  stampDuty: string;
  note: string;
}

export type MfFieldKey = keyof MfDraft;
export type MfFieldErrors = Partial<Record<MfFieldKey, string>>;

export interface MfTxnBody {
  scheme_code: number;
  folio: string;
  txn_type: MfTxnType;
  txn_date: string;
  units: string;
  nav: string;
  amount: string;
  stamp_duty: string;
  note: string;
}

export const EMPTY_MF_DRAFT: MfDraft = {
  schemeCode: "",
  schemeName: "",
  folio: "",
  type: "purchase",
  date: "",
  units: "",
  nav: "",
  amount: "",
  stampDuty: "",
  note: "",
};

const MAX_UNITS = "1000000000";
const EARLIEST = "1990-01-01";

export function validateMfDraft(
  d: MfDraft,
  today: string,
): { errors: MfFieldErrors; body: MfTxnBody | null } {
  const errors: MfFieldErrors = {};
  const code = Number(d.schemeCode);
  if (d.schemeCode.trim() === "" || !Number.isInteger(code) || code <= 0) {
    errors.schemeCode = "Search and pick the scheme (Direct or Regular, Growth or IDCW).";
  }
  const folio = d.folio.trim();
  if (folio.length < 1 || folio.length > 40) {
    errors.folio = "Enter the folio number from your statement (1 to 40 characters).";
  }
  const units = d.units.trim();
  if (!isPlainDecimal(units, 4)) errors.units = "Enter units with up to 4 decimals, e.g. 12.3450.";
  else if (!(toDec(units)?.gt(0) ?? false)) errors.units = "Units must be greater than 0.";
  else if (toDec(units)?.gt(MAX_UNITS)) errors.units = "Units must be at most 1,000,000,000.";

  const nav = d.nav.trim();
  if (!isPlainDecimal(nav, 4)) errors.nav = "Enter the NAV in INR with up to 4 decimals.";
  else if (!(toDec(nav)?.gt(0) ?? false)) errors.nav = "NAV must be greater than 0.";
  else if (toDec(nav)?.gt(MAX_MONEY)) errors.nav = "NAV is too large.";

  const amount = d.amount.trim();
  if (!isPlainDecimal(amount, 4)) errors.amount = "Enter the amount in INR with up to 4 decimals.";
  else if (!(toDec(amount)?.gt(0) ?? false)) errors.amount = "Amount must be greater than 0.";
  else if (toDec(amount)?.gt(MAX_MONEY)) errors.amount = "Amount is too large.";

  const stamp = d.stampDuty.trim();
  if (stamp !== "" && !isPlainDecimal(stamp, 4)) {
    errors.stampDuty = "Enter stamp duty in INR with up to 4 decimals, or leave empty for none.";
  }

  if (!isCalendarDate(d.date)) errors.date = "Choose a real calendar date (YYYY-MM-DD).";
  else if (d.date > today) errors.date = "The date cannot be in the future.";
  else if (d.date < EARLIEST) errors.date = "The date cannot be before 1 Jan 1990.";
  if (d.note.length > 500) errors.note = "The note can have at most 500 characters.";

  if (Object.keys(errors).length > 0) return { errors, body: null };
  return {
    errors,
    body: {
      scheme_code: code,
      folio,
      txn_type: d.type,
      txn_date: d.date,
      units,
      nav,
      amount,
      stamp_duty: stamp === "" ? "0" : stamp,
      note: d.note,
    },
  };
}

/** Units x NAV, exact; null when either is not a plain decimal. Shown as a hint, never submitted. */
export function unitsTimesNav(units: string, nav: string): string | null {
  const u = toDec(units.trim());
  const v = toDec(nav.trim());
  return u === null || v === null
    ? null
    : money4(u.times(v).toDecimalPlaces(4, Decimal.ROUND_HALF_UP));
}

/**
 * Why a stored row cannot be edited, or null when it can. A type this form does not offer, or a
 * folio or stamp duty the app could not read, is never guessed (it would be saved back as a
 * purchase, an empty folio or a zero charge): the row stays as it is.
 */
export function uneditableReason(t: {
  txn_type: string;
  folio?: string | null | undefined;
  stamp_duty?: string | null | undefined;
}): string | null {
  if (!(MF_TXN_TYPES as readonly string[]).includes(t.txn_type)) {
    return `${typeLabel(t.txn_type)} entries cannot be edited here. ${SWITCH_NOT_SUPPORTED_COPY}`;
  }
  if (t.folio === null || t.folio === undefined || t.folio === "") {
    return "its folio could not be read";
  }
  if (t.stamp_duty === null || t.stamp_duty === undefined) {
    return "its stamp duty could not be read";
  }
  return null;
}

/** The form values of a stored row; null when the row cannot be edited (see `uneditableReason`). */
export function draftFromTxn(t: {
  scheme_code: number;
  scheme_name: string;
  folio?: string | null | undefined;
  txn_type: string;
  txn_date: string;
  units: string;
  nav: string;
  amount: string;
  stamp_duty?: string | null | undefined;
  note?: string | null | undefined;
}): MfDraft | null {
  if (uneditableReason(t) !== null) return null;
  return {
    schemeCode: String(t.scheme_code),
    schemeName: t.scheme_name,
    folio: t.folio ?? "",
    type: t.txn_type as MfTxnType,
    date: t.txn_date,
    units: plainString(t.units),
    nav: plainString(t.nav),
    amount: plainString(t.amount),
    stampDuty: plainString(t.stamp_duty ?? "0"),
    note: t.note ?? "",
  };
}

/** The fields of `next` that differ from the stored row (compared normalised). `scheme_code` never changes. */
export function changedMfFields(orig: MfDraft, next: MfTxnBody): Partial<MfTxnBody> {
  const c: Partial<MfTxnBody> = {};
  if (next.folio !== orig.folio.trim()) c.folio = next.folio;
  if (next.txn_type !== orig.type) c.txn_type = next.txn_type;
  if (next.txn_date !== orig.date) c.txn_date = next.txn_date;
  if (plainString(next.units) !== plainString(orig.units)) c.units = next.units;
  if (plainString(next.nav) !== plainString(orig.nav)) c.nav = next.nav;
  if (plainString(next.amount) !== plainString(orig.amount)) c.amount = next.amount;
  if (plainString(next.stamp_duty) !== plainString(orig.stampDuty === "" ? "0" : orig.stampDuty)) {
    c.stamp_duty = next.stamp_duty;
  }
  if (next.note !== orig.note) c.note = next.note;
  return c;
}

// ---- idempotency (docs/03 section 1: Idempotency-Key, 24 h) ---------------------------------

export interface MfAttempt {
  key: string;
  bodyJson: string;
}

/** One key per submit attempt; the same body after a failed try reuses it, any change makes a new one. */
export function nextMfAttempt(
  prev: MfAttempt | null,
  body: MfTxnBody,
  makeKey: () => string = newIdempotencyKey,
): MfAttempt {
  const bodyJson = JSON.stringify(body);
  return prev !== null && prev.bodyJson === bodyJson ? prev : { key: makeKey(), bodyJson };
}

// ---- server messages --------------------------------------------------------------------------

const FIELD_MAP: Record<string, MfFieldKey> = {
  scheme_code: "schemeCode",
  folio: "folio",
  txn_type: "type",
  txn_date: "date",
  units: "units",
  nav: "nav",
  amount: "amount",
  stamp_duty: "stampDuty",
  note: "note",
};

export interface MfErrorView {
  message: string;
  fields: MfFieldErrors;
  retryable: boolean;
  lost: boolean;
  conflict: boolean;
}

const NO_FLAGS = { retryable: false, lost: false, conflict: false } as const;

function unitsText(v: unknown): string {
  const s = typeof v === "string" || typeof v === "number" ? String(v) : "";
  return formatNumber(displayNumber(s), { decimals: 4 }).text;
}

/** Turns an API failure into text for the form; the server's own detail is always kept. */
export function describeMfError(err: unknown): MfErrorView {
  if (!(err instanceof ApiError)) {
    return { message: "The transaction could not be saved.", fields: {}, ...NO_FLAGS };
  }
  if (err.code === "TIMEOUT" || err.code === "NETWORK" || err.status >= 500) {
    return {
      message: `${err.message} Nothing was confirmed; press Save again to retry safely (the same request key is reused, so it cannot be recorded twice). If you change anything, it is sent as a new transaction.`,
      fields: {},
      retryable: true,
      lost: err.code === "TIMEOUT" || err.code === "NETWORK",
      conflict: false,
    };
  }
  if (err.code === "INSUFFICIENT_UNITS") {
    const d = err.details ?? {};
    const date = typeof d["date"] === "string" ? formatDate(d["date"]).text : null;
    const detail =
      date !== null
        ? ` On ${date} the folio holds ${unitsText(d["held_units"])} units and the redemption is for ${unitsText(d["redeem_units"])} units.`
        : "";
    return {
      message: `${err.message}.${detail} A purchase on the same day counts before a redemption. Editing or deleting a transaction re-checks every later redemption of the same scheme and folio.`,
      fields: {},
      ...NO_FLAGS,
    };
  }
  if (err.code === "MF_TXN_TYPE_NOT_SUPPORTED") {
    return {
      message: `${err.message} ${SWITCH_NOT_SUPPORTED_COPY}`,
      fields: { type: "This type is not supported yet." },
      ...NO_FLAGS,
    };
  }
  const fields: MfFieldErrors = {};
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

/** Banner prefix per server warning (docs/03 12a); the server message follows. */
export const MF_WARNING_LABEL: Record<string, string> = {
  AMOUNT_MISMATCH: "Amount differs from units x NAV",
  UNITS_ROUNDED: "Units rounded",
  DUPLICATE_LOOKING_TXN: "Looks like a duplicate",
  NON_BUSINESS_DAY: "Non-business day",
  NAV_FEED_STARTS_AFTER_TXN: "NAV history starts later",
};
