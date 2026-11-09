import { ApiError } from "@/lib/api/client";
import { formatDate, formatInr, formatNumber } from "@/lib/format";
import { humanize } from "@/lib/dashboard/labels";
import { thresholdDetailsSchema } from "./schemas";

// Plain-language text for alert and Telegram states. No raw identifiers are shown.

const LAST_ERROR: Record<string, string> = {
  quiet_hours: "Held until quiet hours end",
  not_linked: "Telegram is not linked",
  bot_not_configured: "The Telegram bot is not set up yet",
  MAX_ATTEMPTS: "Gave up after repeated attempts",
};

export function lastErrorLabel(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  return LAST_ERROR[raw] ?? humanize(raw);
}

export const STATUS_LABEL: Record<string, string> = {
  active: "Active",
  paused: "Paused",
  fired: "Fired",
  expired: "Expired",
};

/** The inline message for a 422 THRESHOLD_ALREADY_MET (ALR-01, D-D): last imported bar, not live. */
export function thresholdMessage(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.code !== "THRESHOLD_ALREADY_MET") return null;
  const d = thresholdDetailsSchema.safeParse(error.details);
  if (!d.success) return "This threshold is already met at the last imported price.";
  const isNav = d.data.kind.startsWith("nav_");
  const money = (n: number) => (isNav ? formatNumber(n, { decimals: 4 }) : formatInr(n)).text;
  const when = formatDate(d.data.as_of).text;
  return isNav
    ? `Already true at the latest imported NAV of ${when}: NAV ${money(d.data.value)}, your threshold ${money(d.data.threshold)}. Choose a threshold that has not been reached yet.`
    : `Already true at the last imported bar of ${when}: close ${money(d.data.value)}, your threshold ${money(d.data.threshold)}. Choose a threshold that has not been reached yet.`;
}

/** Seconds left until `expiresAt` at instant `nowMs`; 0 when expired or unparsable. */
export function remainingSeconds(expiresAt: string, nowMs: number): number {
  const t = Date.parse(expiresAt);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.ceil((t - nowMs) / 1000));
}

/** `14:59` style countdown. */
export function countdownText(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Deep link is shown only for a t.me https address; anything else is dropped. */
export function safeDeepLink(link: string | null): string | null {
  return link !== null && /^https:\/\/t\.me\/[A-Za-z0-9_]+\?start=[A-Za-z0-9_-]+$/.test(link)
    ? link
    : null;
}

/** Message for a Telegram action failure (test message, unlink, link code). */
export function telegramErrorText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "RATE_LIMITED" || error.status === 429) {
      return error.retryAfterSeconds
        ? `Try again in ${error.retryAfterSeconds} seconds.`
        : "Try again in a minute.";
    }
    if (error.status === 409) return "Telegram is not linked yet.";
    if (error.status === 503 || error.code === "SOURCE_DOWN")
      return "The Telegram bot is not set up on the server yet, or Telegram did not accept the message.";
    if (error.code === "NOT_IMPLEMENTED")
      return "This function is not available on the server yet.";
    return error.message;
  }
  return "Something went wrong. Try again.";
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

const HOLDER: Record<string, string> = {
  promoter: "Promoter",
  fii: "FII",
  dii: "DII",
  mf: "Mutual funds",
};

/** One line describing the condition, from the kind and params; numbers go through lib/format. */
export function conditionText(kind: string, params: Record<string, unknown>): string {
  const inr = (v: unknown) => formatInr(num(v)).text;
  const n = (v: unknown, decimals = 2) => formatNumber(num(v), { decimals }).text;
  switch (kind) {
    case "price_above":
      return `Price at or above ${inr(params.price)}`;
    case "price_below":
      return `Price at or below ${inr(params.price)}`;
    case "day_change_pct":
      return `Day change of ${n(params.pct)}% ${
        params.direction === "either" ? "either way" : String(params.direction ?? "")
      }`.trim();
    case "wk52_high":
      return "New 52-week high";
    case "wk52_low":
      return "New 52-week low";
    case "ma_cross":
      return `${params.direction === "death" ? "Death" : "Golden"} cross of ${n(params.fast, 0)} and ${n(params.slow, 0)} day averages`;
    case "rsi_above":
      return `RSI rises through ${n(params.level)}`;
    case "rsi_below":
      return `RSI falls through ${n(params.level)}`;
    case "results_upcoming":
      return `Results due within ${n(params.days_before, 0)} days`;
    case "results_declared":
      return "New quarterly results";
    case "holding_change":
      return `${HOLDER[String(params.holder)] ?? "Holder"} holding changes by ${n(params.delta_pct)} points or more`;
    case "nav_above":
      return `NAV at or above ${n(params.nav, 4)}`;
    case "nav_below":
      return `NAV at or below ${n(params.nav, 4)}`;
    default:
      return humanize(kind);
  }
}

export function targetText(t: {
  type: string;
  symbol?: string | null;
  code?: number | null;
  name?: string | null;
}): string {
  if (t.type === "mf") return `${t.name ?? "Fund"} (scheme ${t.code ?? "unknown"})`;
  return t.symbol ?? "Unknown stock";
}
