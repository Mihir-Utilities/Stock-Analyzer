import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { BUSY_COPY, searchQuery, startMfRefresh, type SearchParams } from "@/lib/mf/api";
import { parseCodes } from "@/lib/mf/compare";
import {
  MF_ATTRIBUTION,
  daysBetween,
  reasonText,
  returnRows,
  sipGrowth,
  validateSip,
} from "@/lib/mf/derive";
import { runMfRefresh } from "@/lib/mf/refresh";
import { detailSchema, searchSchema, sipSchema } from "@/lib/mf/schemas";
import * as fx from "../mocks/mf-fixtures";
import { createMockFetch } from "../mocks/mock-fetch";
import { fail } from "../mocks/imports-fixtures";

const base: SearchParams = {
  q: "",
  category: "",
  fundHouse: "",
  plan: "direct",
  option: "growth",
  includeAll: false,
  group: false,
};

describe("attribution text (SAF-03, D-W 7, B10-8)", () => {
  it("is exactly 'NAV data: AMFI, via mfapi.in' with the comma", () => {
    expect(MF_ATTRIBUTION).toBe("NAV data: AMFI, via mfapi.in");
    expect(fx.ATTRIBUTION).toBe(MF_ATTRIBUTION);
  });
});

describe("SIP form validation (MF-11)", () => {
  const ok = { amount: "5000", start: "2024-01-01", end: "", day: "1" };
  it("accepts days 1 to 28 and rejects 0, 29, 30, 31 and non-numbers", () => {
    for (const d of ["1", "15", "28"]) expect(validateSip({ ...ok, day: d }).day).toBeUndefined();
    for (const d of ["0", "29", "30", "31", "", "1.5", "abc", "-1"]) {
      expect(validateSip({ ...ok, day: d }).day).toMatch(/1 to 28/);
    }
  });
  it("checks amount, start and end", () => {
    expect(validateSip(ok)).toEqual({});
    expect(validateSip({ ...ok, amount: "0" }).amount).toBeDefined();
    expect(validateSip({ ...ok, amount: "10.123" }).amount).toBeDefined();
    expect(validateSip({ ...ok, amount: "1000000001" }).amount).toBeDefined();
    expect(validateSip({ ...ok, amount: "0.10" }).amount).toBeUndefined();
    expect(validateSip({ ...ok, start: "" }).start).toBeDefined();
    expect(validateSip({ ...ok, start: "1989-12-31" }).start).toMatch(/1990/);
    expect(validateSip({ ...ok, start: "2024-02-30" }).start).toBeDefined();
    expect(validateSip({ ...ok, end: "2023-12-31" }).end).toBeDefined();
    expect(validateSip({ ...ok, end: "2024-06-30" }).end).toBeUndefined();
  });
});

describe("SIP growth path (decimal safe)", () => {
  it("accumulates exact units and invested, and ends at the end NAV", () => {
    const res = fx.sip();
    const g = sipGrowth(res.schedule, res.amount, { date: "2026-03-31", nav: 106.3 });
    expect(g.map((p) => p.invested)).toEqual([5000, 10000, 15000, 15000]);
    expect(g[0]?.value).toBe(5000);
    expect(g[2]?.value).toBeCloseTo(150.5 * 105, 6);
    expect(g).toHaveLength(4);
    expect(g[3]).toEqual({ date: "2026-03-31", invested: 15000, value: 150.5 * 106.3 });
  });
  it("0.1 + 0.2 style units stay exact", () => {
    const g = sipGrowth(
      [
        { date: "2026-01-01", nav_date: "2026-01-01", nav: 1, units: "0.1" },
        { date: "2026-02-01", nav_date: "2026-02-01", nav: 1, units: "0.2" },
      ],
      "0.10",
    );
    expect(g[1]?.value).toBe(0.3);
    expect(g[1]?.invested).toBe(0.2);
  });
  it("an empty schedule has no points (never a zero point)", () => {
    expect(sipGrowth([], "5000", { date: "2026-03-31", nav: 1 })).toEqual([]);
  });
});

describe("returns rows (MF-04, MF-100)", () => {
  it("a null window carries its reason", () => {
    const d = detailSchema.parse(fx.detail());
    const rows = returnRows(d);
    expect(rows).toHaveLength(8);
    const r5 = rows.find((r) => r.key === "r_5y");
    expect(r5?.value).toBeNull();
    expect(r5?.reason).toBe("history is shorter than this window");
    expect(rows.find((r) => r.key === "r_1y")).toMatchObject({ value: 12.34, basis: "CAGR" });
    expect(rows.find((r) => r.key === "r_1m")).toMatchObject({ basis: "Absolute" });
  });
  it("no NAV rows: every key is null with the no-NAV reason", () => {
    const env = fx.noNavDetail({ status: "queued", job_id: 7 }).body as { data: unknown };
    const rows = returnRows(detailSchema.parse(env.data));
    expect(rows.every((r) => r.value === null && r.reason === "no NAV data yet")).toBe(true);
  });
  it("reason codes read as words; unknown codes are not hidden", () => {
    expect(reasonText("weekly_nav")).toMatch(/weekly/);
    expect(reasonText("period_too_short")).toMatch(/30 days/);
    expect(reasonText("something_new")).toBe("something new");
    expect(reasonText(null)).toBe("not available");
  });
  it("days between dates", () => {
    expect(daysBetween("2026-10-01", "2026-10-05")).toBe(4);
  });
});

describe("compare codes (MF-94)", () => {
  it("accepts 2 to 5 distinct numeric codes", () => {
    expect(parseCodes("120503, 118989")).toEqual({ ok: true, codes: [120503, 118989] });
    expect(parseCodes("1,2,3,4,5").ok).toBe(true);
  });
  it("rejects 1, 6, duplicates and non-numeric", () => {
    for (const bad of ["", "1", "1,2,3,4,5,6", "1,1", "a,2", "1,-2", "1,0"]) {
      expect(parseCodes(bad).ok).toBe(false);
    }
  });
});

describe("search request (docs/03 section 10)", () => {
  it("sends plan/option defaults, trims, and drops empty filters", () => {
    expect(searchQuery({ ...base, q: "  parag " }, undefined)).toMatchObject({
      q: "parag",
      plan: "direct",
      option: "growth",
      include_all: undefined,
      group: undefined,
      limit: 25,
      cursor: undefined,
    });
  });
  it("Show all keeps explicit filters only", () => {
    const q = searchQuery(
      { ...base, includeAll: true, plan: "any", option: "any", group: true },
      "c1",
    );
    expect(q).toMatchObject({
      include_all: true,
      plan: undefined,
      option: undefined,
      group: true,
      cursor: "c1",
    });
  });
});

describe("schemas stay honest (UI-02)", () => {
  it("accepts null NAV and null 1Y but rejects a string NAV", () => {
    const base = fx.item(1, { latest_nav: null, return_1y_pct: null, last_nav_date: null });
    expect(searchSchema.safeParse({ items: [base], next_cursor: null }).success).toBe(true);
    expect(
      searchSchema.safeParse({ items: [fx.item(1, { latest_nav: "12" })], next_cursor: null })
        .success,
    ).toBe(false);
  });
  it("SIP with no executed installment has null value and null xirr", () => {
    const r = sipSchema.parse(
      fx.sip({
        value: null,
        xirr_pct: null,
        absolute_return_pct: null,
        schedule: null,
        installments: 0,
      }),
    );
    expect(r.value).toBeNull();
    expect(r.schedule).toBeNull();
  });
});

describe("refresh (cooldown 429, busy 409, job polling)", () => {
  it("429 gives the cooldown minutes from details.retry_after_seconds", async () => {
    const mock = createMockFetch({
      "POST /mf/schemes/120503/refresh": fail(429, "RATE_LIMITED", "slow down", {
        retry_after_seconds: 125,
      }),
    });
    vi.stubGlobal("fetch", mock.impl);
    const o = await runMfRefresh(120503);
    expect(o).toEqual({ kind: "rate_limited", minutes: 3 });
    expect(mock.calls[0]?.headers.get("X-Requested-With")).toBe("fetch");
    vi.unstubAllGlobals();
  });
  it("409 becomes the BUSY message", async () => {
    vi.stubGlobal(
      "fetch",
      createMockFetch({ "POST /mf/schemes/5/refresh": fail(409, "CONFLICT", "busy") }).impl,
    );
    await expect(startMfRefresh("5")).rejects.toMatchObject({ code: "BUSY", message: BUSY_COPY });
    const o = await runMfRefresh(5);
    expect(o).toEqual({ kind: "failed", message: BUSY_COPY });
    vi.unstubAllGlobals();
  });
  it("polls the job until ok", async () => {
    let n = 0;
    const o = await runMfRefresh(1, undefined, {
      start: async () => 9,
      job: async () => ({ data: { status: ++n < 2 ? "running" : "ok" } }),
      sleep: async () => undefined,
      now: () => 0,
    });
    expect(o).toEqual({ kind: "ok" });
    expect(n).toBe(2);
  });
  it("an ApiError is still an ApiError", () => {
    expect(new ApiError("BUSY", "x", 409)).toBeInstanceOf(Error);
  });
});

describe("field map for the /mf endpoints (UI-09 style)", () => {
  it("every mapped test id exists in the MF components, the chart frame or the footer", () => {
    const map = JSON.parse(
      readFileSync(join(process.cwd(), "../../docs/field-map.json"), "utf8"),
    ) as Record<string, Record<string, string>>;
    const read = (f: string) => readFileSync(join(process.cwd(), f), "utf8");
    const src = [
      ...["MfBrowse", "MfDetail", "MfCompare", "NavChart", "SipCalculator", "parts"].map((f) =>
        read(`src/components/mf/${f}.tsx`),
      ),
      read("src/components/charts/ChartFrame.tsx"),
      read("src/components/shell/Footer.tsx"),
      read("src/components/ui/chips.tsx"),
    ].join("\n");
    const endpoints = Object.keys(map).filter((k) => k.includes("/mf/"));
    expect(endpoints).toHaveLength(7);
    for (const ep of endpoints) {
      for (const [field, entry] of Object.entries(map[ep] ?? {})) {
        const id = entry.split("|")[0] as string;
        if (id === "not-rendered") continue;
        expect(src.includes(id.replace(/-\*$/, "")), `${ep} ${field} -> ${id}`).toBe(true);
      }
    }
  });
});
