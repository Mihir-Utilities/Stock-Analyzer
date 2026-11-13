import { z } from "zod";

// Shapes of docs/03 section 13a (openapi `JournalNote`, `JournalPageEnvelope`). Every optional
// field degrades on its own: a malformed price shows "unavailable" but the note still renders. An
// item without a usable id or note cannot be shown and is counted instead (JRN-25).

const txnSchema = z.object({
  id: z.number(),
  side: z.enum(["buy", "sell"]),
  qty: z.string(),
  price: z.string(),
  trade_date: z.string(),
});
export type JournalTxn = z.infer<typeof txnSchema>;

export interface JournalNote {
  id: number;
  symbol: string;
  noted_on: string | null;
  note: string;
  /** `null`: no imported price that day; `undefined`: missing or malformed in the response. */
  price_at_note: string | null | undefined;
  price_as_of: string | null;
  price_reason: string | null;
  review_on: string | null;
  status: "open" | "reviewed";
  review_due: boolean;
  portfolio_txn_id: number | null;
  txn: JournalTxn | null;
}

const itemSchema = z.object({
  id: z.number().int().positive(),
  note: z.string().min(1),
  symbol: z.string().catch(""),
  noted_on: z.string().nullable().catch(null),
  price_at_note: z.string().nullable().optional().catch(undefined),
  price_as_of: z.string().nullable().catch(null),
  price_reason: z.string().nullable().catch(null),
  review_on: z.string().nullable().catch(null),
  status: z.enum(["open", "reviewed"]).catch("open"),
  review_due: z.boolean().catch(false),
  portfolio_txn_id: z.number().nullable().catch(null),
  txn: txnSchema.nullable().catch(null),
});

export function parseNote(raw: unknown): JournalNote | null {
  const r = itemSchema.safeParse(raw);
  if (!r.success) return null;
  const d = r.data;
  return {
    id: d.id,
    symbol: d.symbol,
    noted_on: d.noted_on,
    note: d.note,
    price_at_note: d.price_at_note,
    price_as_of: d.price_as_of,
    price_reason: d.price_reason,
    review_on: d.review_on,
    status: d.status,
    review_due: d.review_due,
    portfolio_txn_id: d.portfolio_txn_id,
    txn: d.txn,
  };
}

export const journalPageSchema = z
  .object({
    items: z.array(z.unknown()),
    next_cursor: z.string().nullable().catch(null),
    today: z.string().nullable().catch(null),
    review_due_count: z.number().int().nonnegative().nullable().catch(null),
  })
  .transform((p) => {
    const items = p.items.map(parseNote);
    return {
      items: items.filter((n): n is JournalNote => n !== null),
      dropped: items.filter((n) => n === null).length,
      next_cursor: p.next_cursor,
      today: p.today,
      review_due_count: p.review_due_count,
    };
  });
export type JournalPage = z.output<typeof journalPageSchema>;

/** Create and patch answer with one note (a bad one is an error here: the caller needs the id). */
export const journalNoteSchema = z.unknown().transform((raw, ctx) => {
  const n = parseNote(raw);
  if (n === null) {
    ctx.addIssue({ code: "custom", message: "unexpected journal note" });
    return z.NEVER;
  }
  return n;
});

export const deletedSchema = z.object({ id: z.number(), deleted: z.boolean() });
