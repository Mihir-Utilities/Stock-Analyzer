import { ApiError } from "@/lib/api/client";
import { fieldErrors } from "@/lib/imports/errors";
import { newIdempotencyKey } from "@/lib/portfolio/txn-form";

/** docs/03 section 13a: a note is 1 to 1,000 characters (characters, not bytes). */
export const NOTE_MAX = 1000;

export interface NoteDraft {
  note: string;
  reviewOn: string;
  txnId: string;
}

export const EMPTY_NOTE: NoteDraft = { note: "", reviewOn: "", txnId: "" };

export type NoteField = "note" | "reviewOn" | "txnId";
export type NoteErrors = Partial<Record<NoteField, string>>;

/** Length in characters (code points), the same count the server uses. */
export function charCount(s: string): number {
  return Array.from(s.trim()).length;
}

export interface NoteBody {
  note: string;
  review_on?: string;
  portfolio_txn_id?: number;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

/** Local checks only; the server stays the authority (the review date vs today needs the API's `today`). */
export function validateNote(d: NoteDraft): { errors: NoteErrors; body: NoteBody | null } {
  const errors: NoteErrors = {};
  const note = d.note.trim();
  if (note === "") errors.note = "Write a short note first.";
  else if (charCount(note) > NOTE_MAX) {
    errors.note = `Use at most ${NOTE_MAX.toLocaleString("en-US")} characters (now ${charCount(note).toLocaleString("en-US")}).`;
  } else if (CONTROL.test(note)) errors.note = "Remove control characters from the note.";
  const reviewOn = d.reviewOn.trim();
  if (reviewOn !== "" && !DATE.test(reviewOn)) errors.reviewOn = "Use a date as YYYY-MM-DD.";
  if (Object.keys(errors).length > 0) return { errors, body: null };
  const body: NoteBody = { note };
  if (reviewOn !== "") body.review_on = reviewOn;
  if (d.txnId !== "") body.portfolio_txn_id = Number(d.txnId);
  return { errors, body };
}

/** One Idempotency-Key per form opening; a changed body is a new attempt (same key + new body is 409). */
export interface NoteAttempt {
  key: string;
  bodyJson: string;
}

export function nextNoteAttempt(
  prev: NoteAttempt | null,
  body: NoteBody,
  makeKey: () => string = newIdempotencyKey,
): NoteAttempt {
  const bodyJson = JSON.stringify(body);
  return prev !== null && prev.bodyJson === bodyJson ? prev : { key: makeKey(), bodyJson };
}

const FIELD_MAP: Record<string, NoteField> = {
  note: "note",
  review_on: "reviewOn",
  portfolio_txn_id: "txnId",
};

export interface NoteErrorView {
  message: string;
  fields: NoteErrors;
  /** 409: the key was used for another body or the 500-note cap is reached. */
  conflict: boolean;
}

export function describeNoteError(err: unknown): NoteErrorView {
  const fields: NoteErrors = {};
  for (const f of fieldErrors(err)) {
    const k = FIELD_MAP[f.field];
    if (k && !(k in fields)) fields[k] = f.message;
  }
  if (err instanceof ApiError) {
    if (err.code === "CONFLICT") return { message: err.message, fields, conflict: true };
    if (Object.keys(fields).length > 0) {
      return { message: "Check the highlighted fields.", fields, conflict: false };
    }
    return {
      message: `${err.message}${err.requestId ? ` (request ${err.requestId})` : ""}`,
      fields,
      conflict: false,
    };
  }
  return {
    message: "Something went wrong. Your text is still here; try again.",
    fields,
    conflict: false,
  };
}
