import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api/client";
import {
  ALERT_KINDS,
  KIND_FIELDS,
  exactNumber,
  targetTypeFor,
  validateCooldown,
  validateExpiry,
  validateParams,
  validateTarget,
} from "@/lib/alerts/kinds";
import {
  conditionText,
  countdownText,
  lastErrorLabel,
  remainingSeconds,
  safeDeepLink,
  telegramErrorText,
  thresholdMessage,
} from "@/lib/alerts/text";
import { signOut, validatePasswordChange } from "@/lib/auth/session";

describe("alert params mirror the API rules (docs/03 section 13, B12-1)", () => {
  it("covers all 13 kinds", () => {
    expect(ALERT_KINDS).toHaveLength(13);
    for (const k of ALERT_KINDS) expect(KIND_FIELDS[k]).toBeDefined();
  });

  it("price is a decimal checked as text; JSON number only when it prints back unchanged", () => {
    expect(validateParams("price_above", { price: "4000.5" }).params).toEqual({ price: 4000.5 });
    expect(validateParams("price_above", { price: "0.1" }).params).toEqual({ price: 0.1 });
    expect(exactNumber("0.30")).toBe(0.3);
    expect(exactNumber("12345678901234567")).toBeNull(); // more than 15 significant digits
    expect(validateParams("price_above", { price: "1e5" }).errors.price).toMatch(/plain number/);
    expect(validateParams("price_above", { price: "0" }).errors.price).toMatch(/greater than 0/);
    expect(validateParams("price_above", { price: "" }).errors.price).toMatch(/Enter price/);
    expect(validateParams("price_above", { price: "1.23456" }).errors.price).toMatch(/4 decimals/);
    expect(validateParams("nav_below", { nav: "-5" }).errors.nav).toBeDefined();
  });

  it("applies the documented ranges", () => {
    const day = (pct: string, direction = "up") =>
      validateParams("day_change_pct", { pct, direction });
    expect(day("0.1").params).toEqual({ pct: 0.1, direction: "up" });
    expect(day("0.09").errors.pct).toBeDefined();
    expect(day("50").errors.pct).toBeUndefined();
    expect(day("50.01").errors.pct).toBeDefined();
    expect(day("5", "sideways").errors.direction).toBeDefined();
    expect(validateParams("rsi_above", { level: "99" }).params).toEqual({ level: 99 });
    expect(validateParams("rsi_below", { level: "100" }).errors.level).toBeDefined();
    expect(validateParams("results_upcoming", { days_before: "14" }).params).toEqual({
      days_before: 14,
    });
    expect(
      validateParams("results_upcoming", { days_before: "15" }).errors.days_before,
    ).toBeDefined();
    expect(validateParams("results_upcoming", { days_before: "2.5" }).errors.days_before).toMatch(
      /whole/,
    );
    expect(validateParams("holding_change", { holder: "fii", delta_pct: "20" }).params).toEqual({
      holder: "fii",
      delta_pct: 20,
    });
    expect(
      validateParams("holding_change", { holder: "bank", delta_pct: "1" }).errors.holder,
    ).toBeDefined();
  });

  it("ma_cross needs slow greater than fast", () => {
    const ma = (fast: string, slow: string) =>
      validateParams("ma_cross", { fast, slow, direction: "golden" });
    expect(ma("50", "200").params).toEqual({ fast: 50, slow: 200, direction: "golden" });
    expect(ma("50", "50").errors.slow).toMatch(/greater than the fast/);
    expect(ma("4", "200").errors.fast).toBeDefined();
    expect(ma("50", "301").errors.slow).toBeDefined();
  });

  it("kinds without parameters send an empty object", () => {
    for (const k of ["wk52_high", "wk52_low", "results_declared"] as const) {
      expect(validateParams(k, {}).params).toEqual({});
    }
  });

  it("targets, cooldown and expiry", () => {
    expect(targetTypeFor("nav_above")).toBe("mf");
    expect(targetTypeFor("price_above")).toBe("stock");
    expect(validateTarget("price_above", { symbol: " TCS ", code: "" }).target).toEqual({
      type: "stock",
      symbol: "TCS",
    });
    expect(validateTarget("price_above", { symbol: "", code: "" }).error?.field).toBe("symbol");
    expect(validateTarget("nav_above", { symbol: "", code: "120503" }).target).toEqual({
      type: "mf",
      code: 120503,
    });
    expect(validateTarget("nav_above", { symbol: "", code: "0" }).error?.field).toBe("code");
    expect(validateCooldown("")).toEqual({ error: null, value: null });
    expect(validateCooldown("0").value).toBe(0);
    expect(validateCooldown("-1").error).toBeDefined();
    expect(validateExpiry("2027-03-31").value).toBe("2027-03-31");
    expect(validateExpiry("2027-02-30").error).toBeDefined();
    expect(validateExpiry("31/03/2027").error).toBeDefined();
  });
});

describe("alert text (ALR-01, no raw identifiers)", () => {
  it("THRESHOLD_ALREADY_MET names the last imported bar, not a live price", () => {
    const e = new ApiError("THRESHOLD_ALREADY_MET", "x", 422, {
      kind: "price_above",
      threshold: 4000,
      value: 4123.5,
      as_of: "2026-10-23",
    });
    const m = thresholdMessage(e);
    expect(m).toContain("last imported bar of 23 Oct 2026");
    expect(m).toContain("₹4,123.50");
    expect(m).toContain("₹4,000.00");
    expect(thresholdMessage(new ApiError("CONFLICT", "x", 409))).toBeNull();
  });

  it("NAV variant says latest imported NAV", () => {
    const e = new ApiError("THRESHOLD_ALREADY_MET", "x", 422, {
      kind: "nav_below",
      threshold: 10,
      value: 9.5,
      as_of: "2026-10-23",
    });
    expect(thresholdMessage(e)).toContain("latest imported NAV of 23 Oct 2026");
  });

  it("condition and error labels never show snake_case", () => {
    for (const k of ALERT_KINDS) expect(conditionText(k, {})).not.toMatch(/[a-z]_[a-z]/);
    expect(lastErrorLabel("quiet_hours")).toBe("Held until quiet hours end");
    expect(lastErrorLabel("some_new_error")).toBe("Some new error");
    expect(lastErrorLabel(null)).toBeNull();
    expect(conditionText("price_above", { price: 4000 })).toBe("Price at or above ₹4,000.00");
  });

  it("countdown is pure arithmetic on fixed instants", () => {
    const exp = "2026-10-24T09:15:00Z";
    const t0 = Date.parse("2026-10-24T09:00:00Z");
    expect(remainingSeconds(exp, t0)).toBe(900);
    expect(countdownText(900)).toBe("15:00");
    expect(countdownText(65)).toBe("1:05");
    expect(remainingSeconds(exp, t0 + 901_000)).toBe(0);
    expect(remainingSeconds("garbage", t0)).toBe(0);
  });

  it("deep links are accepted only for https t.me", () => {
    expect(safeDeepLink("https://t.me/my_bot?start=A7K9Q2XM")).not.toBeNull();
    expect(safeDeepLink("javascript:alert(1)")).toBeNull();
    expect(safeDeepLink("https://evil.example/?start=A")).toBeNull();
    expect(safeDeepLink(null)).toBeNull();
  });

  it("Telegram errors are plain sentences", () => {
    expect(telegramErrorText(new ApiError("RATE_LIMITED", "x", 429, undefined, null, 40))).toBe(
      "Try again in 40 seconds.",
    );
    expect(telegramErrorText(new ApiError("CONFLICT", "x", 409))).toMatch(/not linked/);
    expect(telegramErrorText(new ApiError("SOURCE_DOWN", "x", 503))).toMatch(/bot is not set up/);
  });
});

describe("password and sign-out rules (SEC)", () => {
  it("mirrors the API policy", () => {
    const ok = validatePasswordChange("old-password-1", "new-password-12", "new-password-12");
    expect(ok).toEqual({ current: null, new: null, confirm: null });
    expect(validatePasswordChange("", "new-password-12", "new-password-12").current).toBeTruthy();
    expect(validatePasswordChange("a", "short", "short").new).toMatch(/12/);
    expect(
      validatePasswordChange("same-password-1", "same-password-1", "same-password-1").new,
    ).toMatch(/differ/);
    expect(validatePasswordChange("a", "new-password-12", "other").confirm).toBeTruthy();
    expect(validatePasswordChange("a", "x".repeat(201), "x".repeat(201)).new).toMatch(/200/);
  });

  it("signOut clears state and goes to /login, also on 401, but not on a network error", async () => {
    const calls: string[] = [];
    const deps = (request: (p: string) => Promise<unknown>) => ({
      request: ((p: string) => request(p)) as never,
      clear: () => calls.push("clear"),
      go: (u: string) => calls.push(`go:${u}`),
    });
    await signOut(
      true,
      deps(async (p) => calls.push(p)),
    );
    expect(calls).toEqual(["/auth/logout-all", "clear", "go:/login"]);
    calls.length = 0;
    await signOut(
      false,
      deps(async () => Promise.reject(new ApiError("UNAUTHENTICATED", "x", 401))),
    );
    expect(calls).toEqual(["clear", "go:/login"]);
    calls.length = 0;
    await expect(
      signOut(
        false,
        deps(async () => Promise.reject(new ApiError("NETWORK", "x", 0))),
      ),
    ).rejects.toBeInstanceOf(ApiError);
    expect(calls).toEqual([]);
  });
});
