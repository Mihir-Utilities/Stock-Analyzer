import Decimal from "decimal.js";
import type { AlertPrefill } from "@/components/alerts/AlertForm";
import { formatDate, formatInr } from "@/lib/format";
import type { Position } from "@/lib/stock/inv-schemas";

// Alert shortcut levels (docs/06 6.4b, docs/03 13a, ALS-01..ALS-04). Every level is plain decimal
// arithmetic on a fact already on the Analysis tab, rounded half up to 2 decimals; nothing here
// fetches a price or reads a clock.

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export type ShortcutKey = "below-10" | "below-20" | "sma200";

export interface ShortcutRow {
  key: ShortcutKey;
  /** The level in words, for the row heading. */
  label: string;
  /** Null when the input fact is missing or the level cannot be offered; then `reason` says why. */
  action: {
    kind: "price_above" | "price_below";
    /** Plain decimal text with 2 decimals, for example "1035.00". */
    level: string;
    /** The exact outcome, used as the button text. */
    button: string;
  } | null;
  /** The source fact with its value and as-of, always shown. */
  source: string | null;
  reason: string | null;
}

function dec(v: number | null | undefined): Decimal | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? new D(String(v)) : null;
}

/** `high x (1 - pct/100)` rounded half up to 2 decimals, as text. */
export function levelBelow(high: number, pct: number): string | null {
  const h = dec(high);
  if (h === null) return null;
  return h.mul(new D(100).minus(pct)).div(100).toFixed(2, Decimal.ROUND_HALF_UP);
}

function inr(level: string): string {
  return formatInr(Number(level)).text;
}

function asOfText(asOf: string | null | undefined): string {
  return asOf ? `as of ${formatDate(asOf).text}` : "as of an unknown date";
}

const SOURCE = "your imported prices";

export function shortcutRows(p: Position): ShortcutRow[] {
  const rows: ShortcutRow[] = [];
  const when = asOfText(p.as_of);
  const highText = typeof p.high_52w_close === "number" ? inr(String(p.high_52w_close)) : null;
  for (const pct of [10, 20] as const) {
    const key = pct === 10 ? "below-10" : "below-20";
    const label = `${pct}% below the 52-week highest close`;
    const level = typeof p.high_52w_close === "number" ? levelBelow(p.high_52w_close, pct) : null;
    if (level === null || highText === null) {
      rows.push({
        key,
        label,
        action: null,
        source: null,
        reason: "52-week highest close: not available (needs imported prices).",
      });
      continue;
    }
    rows.push({
      key,
      label,
      action: {
        kind: "price_below",
        level,
        button: `Alert when the price falls to ${inr(level)} or lower`,
      },
      source: `52-week highest close ${highText}, ${when}; ${SOURCE}`,
      reason: null,
    });
  }
  const sma = dec(p.sma200);
  const close = dec(p.close);
  const smaLabel = "200-day average";
  if (sma === null) {
    rows.push({
      key: "sma200",
      label: smaLabel,
      action: null,
      source: null,
      reason: "200-day average: needs 200 days of prices.",
    });
  } else {
    const level = sma.toFixed(2, Decimal.ROUND_HALF_UP);
    const source = `200-day average ${inr(level)}${close ? `, last close ${inr(close.toFixed(2, Decimal.ROUND_HALF_UP))}` : ""}, ${when}; ${SOURCE}`;
    if (close === null) {
      rows.push({
        key: "sma200",
        label: smaLabel,
        action: null,
        source,
        reason: "The last close is not available, so the direction cannot be chosen.",
      });
    } else if (close.equals(sma)) {
      rows.push({
        key: "sma200",
        label: smaLabel,
        action: null,
        source,
        reason:
          "The last close equals the 200-day average, so any alert here would already be met.",
      });
    } else if (close.greaterThan(sma)) {
      rows.push({
        key: "sma200",
        label: `${smaLabel} (the price is above it now)`,
        action: {
          kind: "price_below",
          level,
          button: `Alert when the price falls to ${inr(level)} or lower`,
        },
        source,
        reason: null,
      });
    } else {
      rows.push({
        key: "sma200",
        label: `${smaLabel} (the price is below it now)`,
        action: {
          kind: "price_above",
          level,
          button: `Alert when the price rises to ${inr(level)} or higher`,
        },
        source,
        reason: null,
      });
    }
  }
  return rows;
}

export function prefillFor(symbol: string, row: ShortcutRow): AlertPrefill | null {
  if (!row.action) return null;
  return { symbol, kind: row.action.kind, price: row.action.level };
}
