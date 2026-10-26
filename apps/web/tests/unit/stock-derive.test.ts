import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api/client";
import {
  changeOn,
  headerPrice,
  humanReason,
  performanceRows,
  ratioChange,
  isValidSymbol,
  softFlags,
  unconfirmedCopy,
  unconfirmedDates,
} from "@/lib/stock/derive";
import { REFRESH_COPY, rateLimitedCopy, runRefresh, type RefreshDeps } from "@/lib/stock/refresh";
import { indicatorsDataSchema, profileDataSchema } from "@/lib/stock/schemas";
import * as fx from "../mocks/stock-fixtures";

const profile = profileDataSchema.parse(fx.profileData);

describe("headerPrice", () => {
  it("manual mode: last bar close and change against the previous bar", () => {
    const p = headerPrice(profile, [
      ["2026-10-08", 1, 1, 1, 100, 1],
      ["2026-10-09", 1, 1, 1, 110, 1],
    ]);
    expect(p.kind).toBe("last_close");
    expect(p.ltp).toBe(110);
    expect(p.change).toBe(10);
    expect(p.changePct).toBeCloseTo(10, 6);
  });
  it("a single bar has no change (null, not 0)", () => {
    const p = headerPrice(profile, [["2026-10-09", 1, 1, 1, 110, 1]]);
    expect(p.change).toBeNull();
    expect(p.changePct).toBeNull();
  });
  it("no bars: none with a reason", () => {
    expect(headerPrice(profile, null).kind).toBe("none");
  });
  it("a quote row wins", () => {
    const q = {
      ...profile,
      quote: { ltp: 5, change: 1, change_pct: 25, quote_ts: "2026-10-09T10:00:00Z" },
    };
    expect(headerPrice(q, [["2026-10-09", 1, 1, 1, 110, 1]]).kind).toBe("quote");
  });
});

describe("warnings and flags", () => {
  const w = [
    { code: "UNCONFIRMED_ACTION", message: "Possible split on 2026-09-01 not yet confirmed" },
  ];
  it("extracts detected dates and builds the exact copy", () => {
    expect(unconfirmedDates(w)).toEqual(["2026-09-01"]);
    expect(unconfirmedCopy("2026-09-01", -50)).toBe(
      "Possible split or bonus on 1 Sep 2026: price changed -50.0%. Confirm to adjust history.",
    );
  });
  it("leaves the percentage out when it cannot be computed", () => {
    expect(unconfirmedCopy("2026-09-01", null)).toBe(
      "Possible split or bonus on 1 Sep 2026. Confirm to adjust history.",
    );
  });
  it("changeOn needs the previous bar", () => {
    const b = fx.bars(5);
    expect(changeOn(b, b[0]![0])).toBeNull();
    expect(changeOn(b, "1999-01-01")).toBeNull();
  });
  it("soft flag: threshold is 20% inclusive, covered and dismissed dates are skipped", () => {
    const b: Array<[string, number, number, number, number, number]> = [
      ["2026-01-01", 1, 1, 1, 100, 1],
      ["2026-01-02", 1, 1, 1, 80, 1], // exactly -20%
      ["2026-01-03", 1, 1, 1, 65, 1], // -18.75%
      ["2026-01-04", 1, 1, 1, 50, 1], // -23%
    ];
    expect(softFlags(b, new Set()).map((s) => s.date)).toEqual(["2026-01-02", "2026-01-04"]);
    expect(softFlags(b, new Set(["2026-01-02"])).map((s) => s.date)).toEqual(["2026-01-04"]);
    expect(softFlags(b, new Set(), new Set(["2026-01-04"])).map((s) => s.date)).toEqual([
      "2026-01-02",
    ]);
  });
  it("humanReason maps codes and never returns an empty string", () => {
    expect(humanReason("insufficient_history")).toBe("insufficient history");
    expect(humanReason(null, "x")).toBe("x");
    expect(humanReason("some_new_code")).toBe("some new code");
  });
});

describe("performance rows", () => {
  it("keeps nulls as null with reasons", () => {
    const ind = indicatorsDataSchema.parse(fx.indicatorsData);
    const rows = performanceRows(ind);
    expect(rows.map((r) => r.label)).toEqual(["1W", "1M", "3M", "6M", "1Y", "3Y", "5Y"]);
    expect(rows.find((r) => r.id === "6m")).toMatchObject({
      value: null,
      reason: "insufficient history",
    });
    expect(rows.find((r) => r.id === "3m")?.value).toBe(-4.5);
  });
});

describe("refresh flow (docs/06 section 4.3)", () => {
  const mk = (statuses: Array<{ status: string; error?: string }>): RefreshDeps => {
    let t = 0;
    let i = 0;
    return {
      start: async () => 12,
      job: async () => ({ data: statuses[Math.min(i++, statuses.length - 1)]! }),
      sleep: async (ms) => {
        t += ms;
      },
      now: () => t,
    };
  };
  it("ok after polling", async () => {
    expect(await runRefresh("TCS", mk([{ status: "running" }, { status: "ok" }]))).toEqual({
      kind: "ok",
    });
  });
  it("broker_session_missing", async () => {
    expect(
      await runRefresh("TCS", mk([{ status: "failed", error: "broker_session_missing" }])),
    ).toEqual({ kind: "broker_session_missing" });
  });
  it("times out after 3 minutes of polling", async () => {
    expect(await runRefresh("TCS", mk([{ status: "running" }]))).toEqual({ kind: "timeout" });
  });
  it("429 gives minutes, rounded up", async () => {
    const deps = mk([]);
    deps.start = async () => {
      throw new ApiError("RATE_LIMITED", "x", 429, { retry_after_seconds: 61 });
    };
    expect(await runRefresh("TCS", deps)).toEqual({ kind: "rate_limited", minutes: 2 });
    expect(rateLimitedCopy(2)).toBe("You refreshed this recently. Try again in 2 min.");
    expect(REFRESH_COPY.timeout).toBe("Still working; data will update at the next scheduled run.");
  });
});

// UI-09: field coverage for `/stocks/{symbol}` and `/indicators` (docs/06 section 8).
function sourceText(dir: string): string {
  let out = "";
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) out += sourceText(p);
    else if (/\.(tsx?|ts)$/.test(f)) out += readFileSync(p, "utf8");
  }
  return out;
}

describe("UI-09 field map", () => {
  const map = JSON.parse(
    readFileSync(join(process.cwd(), "../../docs/field-map.json"), "utf8"),
  ) as Record<string, Record<string, string>>;
  const src = sourceText(join(process.cwd(), "src"));
  const flat = (o: Record<string, unknown>, prefix = ""): string[] =>
    Object.entries(o).flatMap(([k, v]) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? flat(v as Record<string, unknown>, `${prefix}${k}.`)
        : [`${prefix}${k}`],
    );
  const cases: Array<[string, string[]]> = [
    [
      "GET /stocks/{symbol}",
      flat({
        ...fx.profileData,
        hint: 1,
        backfill: { status: 1, job_id: 1 },
        quote: {
          ltp: 1,
          prev_close: 1,
          change: 1,
          change_pct: 1,
          day_high: 1,
          day_low: 1,
          wk52_high: 1,
          wk52_low: 1,
          volume: 1,
          market_cap_cr: 1,
          quote_ts: 1,
          source: 1,
        },
      }),
    ],
    [
      "GET /stocks/{symbol}/indicators",
      [
        "as_of",
        "bars",
        "price_basis",
        "source",
        "last_close",
        "returns",
        "technicals",
        "scores",
        "null_reasons",
        "units",
        "warnings",
        "series",
        "analysis",
      ],
    ],
  ];
  it("conditional fields are listed with their rendering condition", () => {
    const entry = map["GET /stocks/{symbol}"]?.["broker_ok"] ?? "";
    expect(entry).toMatch(/^conditional:header-refresh\|.*broker/);
  });
  for (const [endpoint, fields] of cases) {
    it(`${endpoint}: every field is mapped to an existing data-testid`, () => {
      const m = map[endpoint] ?? {};
      for (const f of fields) {
        const entry = m[f];
        expect(entry, `${endpoint} field ${f} is not in docs/field-map.json`).toBeTruthy();
        // "not-rendered|reason": honest status, a reason is required (F05R-7).
        if (entry!.startsWith("not-rendered|")) {
          expect(entry!.length, `${f} needs a reason`).toBeGreaterThan("not-rendered|".length + 20);
          continue;
        }
        // "conditional:<id>|condition": the id must exist in the source; the condition itself is
        // asserted by the render test below.
        const id = entry!.startsWith("conditional:") ? entry!.slice(12).split("|")[0] : entry;
        const base = (id as string).replace(/-\*$/, "");
        expect(src.includes(base), `data-testid ${id} (field ${f}) is not in the source`).toBe(
          true,
        );
      }
    });
  }
});

describe("F05R-1 ratioChange", () => {
  const act = (o: Record<string, unknown>) => ({
    id: 1,
    ex_date: "2026-09-01",
    type: "split_or_bonus",
    status: "detected",
    ...o,
  });
  it("is r - 1 of the matched fraction: 1/5 gives -80, 2/3 gives about -33.33", () => {
    expect(ratioChange([act({ ratio_num: 1, ratio_den: 5 })], "2026-09-01")).toBeCloseTo(-80, 9);
    expect(ratioChange([act({ ratio_num: 2, ratio_den: 3 })], "2026-09-01")).toBeCloseTo(
      -33.333,
      2,
    );
  });
  it("is null without a usable ratio, another date, a confirmed row or no actions", () => {
    expect(ratioChange([act({ ratio_num: null, ratio_den: null })], "2026-09-01")).toBeNull();
    expect(ratioChange([act({ ratio_num: 1, ratio_den: 0 })], "2026-09-01")).toBeNull();
    expect(ratioChange([act({ ratio_num: 1, ratio_den: 5 })], "2026-09-02")).toBeNull();
    expect(
      ratioChange([act({ status: "confirmed", ratio_num: 1, ratio_den: 5 })], "2026-09-01"),
    ).toBeNull();
    expect(ratioChange(null, "2026-09-01")).toBeNull();
  });
});

describe("F05R-1 soft flag with the covered day missing from the served bars", () => {
  const bars: Array<[string, number, number, number, number, number]> = [
    ["2026-08-31", 1, 1, 1, 100, 1],
    ["2026-09-02", 1, 1, 1, 20, 1],
  ];
  it("a covered date inside the gap explains the drop; an uncovered one does not", () => {
    expect(softFlags(bars, new Set(["2026-09-01"]))).toEqual([]);
    expect(softFlags(bars, new Set())).toHaveLength(1);
    expect(softFlags(bars, new Set(["2026-09-03"]))).toHaveLength(1);
  });
});

describe("F05R-3 runRefresh abort", () => {
  it("returns aborted after the signal fires and stops polling", async () => {
    const ctl = new AbortController();
    let polls = 0;
    const deps: RefreshDeps = {
      start: async () => 1,
      job: async () => {
        polls++;
        return { data: { status: "running" } };
      },
      sleep: async () => {
        if (polls === 1) ctl.abort();
      },
      now: () => 0,
    };
    expect(await runRefresh("TCS", deps, ctl.signal)).toEqual({ kind: "aborted" });
    expect(polls).toBe(1);
  });
});

describe("F05R-9 symbol guard", () => {
  it("accepts the API charset case-insensitively and rejects the rest", () => {
    for (const s of ["TCS", "m&m", "BAJAJ-AUTO", "3MINDIA"]) expect(isValidSymbol(s)).toBe(true);
    for (const s of ["", "-X", "&X", "A B", "../x", "A".repeat(31)])
      expect(isValidSymbol(s)).toBe(false);
  });
});
