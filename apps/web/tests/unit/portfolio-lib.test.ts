import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api/client";
import { formatInr } from "@/lib/format";
import {
  isPlainDecimal,
  mulMoney,
  plainString,
  qtyDecimals,
  sumMoney,
  tradeAmount,
} from "@/lib/portfolio/decimal";
import {
  describeTxnError,
  EMPTY_DRAFT,
  newIdempotencyKey,
  nextAttempt,
  nonTradingWarning,
  validateDraft,
  type TxnDraft,
} from "@/lib/portfolio/txn-form";

const TODAY = "2026-10-26";
const good: TxnDraft = {
  ...EMPTY_DRAFT,
  symbol: " tcs ",
  qty: "10.5",
  price: "4000.1234",
  tradeDate: "2026-10-23",
};

describe("PF-12: decimal precision (no floats for money)", () => {
  it("0.1 + 0.2 is exactly 0.3000", () => {
    expect(sumMoney(["0.1", "0.2"])).toEqual({ sum: "0.3000", missing: 0 });
    expect(0.1 + 0.2).not.toBe(0.3); // the float trap this guards against
  });
  it("sums many 4-decimal values without drift and counts unknowns instead of adding 0", () => {
    const many = Array.from({ length: 1000 }, () => "0.1000");
    expect(sumMoney(many).sum).toBe("100.0000");
    expect(sumMoney(["1.0000", null, "abc", "2.5000"])).toEqual({ sum: "3.5000", missing: 2 });
  });
  it("products and trade amounts are exact; fees raise a buy cost and cut sell proceeds (PF-14)", () => {
    expect(mulMoney("0.1", "3")).toBe("0.3000");
    expect(mulMoney("1", null)).toBeNull();
    expect(tradeAmount("buy", "3", "0.1", "0.0001")).toBe("0.3001");
    expect(tradeAmount("sell", "3", "0.1", "0.0001")).toBe("0.2999");
    expect(tradeAmount("buy", "12", "3500", "0.1")).toBe("42000.1000");
    expect(tradeAmount("buy", "x", "1", "")).toBeNull();
  });
  it("display bridge: format.ts shows the exact 2-decimal text", () => {
    const sum = sumMoney(["1234.5678", "0.0022"]).sum;
    expect(sum).toBe("1234.5700");
    expect(formatInr(Number(sum)).text).toBe("₹1,234.57");
  });
  it("decimal helpers", () => {
    expect(isPlainDecimal("10.5", 4)).toBe(true);
    expect(isPlainDecimal("1e3", 4)).toBe(false);
    expect(isPlainDecimal("1.12345", 4)).toBe(false);
    expect(isPlainDecimal("-1", 4)).toBe(false);
    expect(plainString("10.0000")).toBe("10");
    expect(plainString("100.5000")).toBe("100.5");
    expect(qtyDecimals("10.5000")).toBe(1);
    expect(qtyDecimals("10.0000")).toBe(0);
  });
});

describe("transaction draft validation (docs/03 section 12)", () => {
  it("accepts a valid draft and sends amounts as the typed strings", () => {
    const r = validateDraft(good, TODAY);
    expect(r.errors).toEqual({});
    expect(r.body).toEqual({
      symbol: "TCS",
      side: "buy",
      qty: "10.5",
      price: "4000.1234",
      fees: "0",
      trade_date: "2026-10-23",
      note: "",
    });
  });
  it.each([
    ["qty", { qty: "0" }],
    ["qty", { qty: "1e3" }],
    ["qty", { qty: "1.00001" }],
    ["qty", { qty: "1000000001" }],
    ["qty", { qty: "" }],
    ["price", { price: "0" }],
    ["price", { price: "-5" }],
    ["fees", { fees: "-1" }],
    ["symbol", { symbol: "" }],
    ["tradeDate", { tradeDate: "" }],
    ["tradeDate", { tradeDate: "2026-10-27" }],
    ["note", { note: "x".repeat(501) }],
  ] as const)("rejects an invalid %s", (field, patch) => {
    const r = validateDraft({ ...good, ...patch }, TODAY);
    expect(r.body).toBeNull();
    expect(r.errors[field]).toBeTruthy();
  });
});

describe("PF-06: weekend or holiday date is a warning, not an error", () => {
  it("2026-10-24 is a Saturday: warning text, yet the draft validates", () => {
    const w = nonTradingWarning("2026-10-24", null);
    expect(w).toMatch(/weekend/);
    expect(w).toMatch(/24 Oct 2026/);
    expect(validateDraft({ ...good, tradeDate: "2026-10-24" }, TODAY).body).not.toBeNull();
  });
  it("a listed holiday warns; a trading day and a missing list do not", () => {
    expect(nonTradingWarning("2026-10-20", new Set(["2026-10-20"]))).toMatch(/holiday/);
    expect(nonTradingWarning("2026-10-20", new Set())).toBeNull();
    expect(nonTradingWarning("2026-10-20", null)).toBeNull();
    expect(nonTradingWarning("", null)).toBeNull();
  });
});

describe("PF-11/16/17: Idempotency-Key per submit attempt", () => {
  const body = validateDraft(good, TODAY).body!;
  it("keys are UUID v4 shaped and unique", () => {
    const a = newIdempotencyKey();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(newIdempotencyKey()).not.toBe(a);
  });
  it("a retry of the same attempt reuses the key; a changed body gets a new key", () => {
    let n = 0;
    const make = () => `k${++n}`;
    const first = nextAttempt(null, body, make);
    const retry = nextAttempt(first, body, make);
    expect(retry.key).toBe(first.key);
    const changed = nextAttempt(first, { ...body, qty: "11" }, make);
    expect(changed.key).not.toBe(first.key);
    expect(nextAttempt(null, body, make).key).toBe("k3"); // new attempt after success
  });
});

describe("server errors", () => {
  it("INSUFFICIENT_HOLDINGS shows the server message and the held and sold quantities (PF-01)", () => {
    const e = new ApiError(
      "INSUFFICIENT_HOLDINGS",
      "A sell would exceed the quantity held on its date",
      422,
      { transaction_id: 0, date: "2026-10-05", held_qty: "10.0000", sell_qty: "15.0000" },
    );
    const v = describeTxnError(e);
    expect(v.message).toContain("A sell would exceed the quantity held on its date");
    expect(v.message).toContain("5 Oct 2026");
    expect(v.message).toContain("you hold 10 shares");
    expect(v.message).toContain("sell is for 15");
    expect(v.message).toMatch(/same day count before sells/);
    expect(v.retryable).toBe(false);
  });
  it("validation fields map to form fields; network and 5xx are retryable", () => {
    const v = describeTxnError(
      new ApiError("UNPROCESSABLE", "Validation failed", 422, {
        fields: [{ field: "trade_date", message: "must not be in the future" }],
      }),
    );
    expect(v.fields.tradeDate).toBe("must not be in the future");
    expect(
      describeTxnError(new ApiError("NETWORK", "Could not reach the server.", 0)).retryable,
    ).toBe(true);
    expect(describeTxnError(new ApiError("INTERNAL", "boom", 503)).retryable).toBe(true);
    expect(
      describeTxnError(new ApiError("CONFLICT", "Idempotency-Key reused", 409)).message,
    ).toMatch(/different values/);
  });
});
