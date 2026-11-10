import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSymbols, parseRange } from "@/lib/screener/compare";
import { screenerCsv } from "@/lib/screener/csv";
import { formatMetric, staleReasonText, stampText } from "@/lib/screener/display";
import { METRICS, SCREENER_LIMITS, metricHeader } from "@/lib/screener/metrics";
import {
  buildQuery,
  displayMetrics,
  emptyDraft,
  newFilter,
  parseNumber,
  savedNameError,
  specToDraft,
  toSavedSpec,
  type Draft,
  type FilterDraft,
} from "@/lib/screener/spec";
import { screenerItemSchema } from "@/lib/screener/schemas";
import { formatDerivedAsOf } from "@/lib/stock/fundamentals";
import { item } from "../mocks/f10-fixtures";

const docs = readFileSync(join(process.cwd(), "../../docs/03-api-spec.md"), "utf8");

function f(over: Partial<FilterDraft>): FilterDraft {
  return { ...newFilter(1), ...over };
}
const draftWith = (...filters: FilterDraft[]): Draft => ({ ...emptyDraft(), filters });

describe("metric whitelist (SCR-03 on the web side)", () => {
  it("equals the metric list in docs/03 section 9, in order", () => {
    const line = docs.split("\n").find((l) => l.includes("**Whitelisted metrics**")) ?? "";
    const keys = [...line.matchAll(/`([a-z0-9_]+)`/g)].map((m) => m[1]);
    expect(METRICS.map((m) => m.key)).toEqual(keys);
    expect(METRICS).toHaveLength(36);
  });
  it("every header names the unit; text metrics have none", () => {
    expect(metricHeader("roe")).toBe("ROE (percent)");
    expect(metricHeader("market_cap_cr")).toBe("Market cap (INR crore)");
    expect(metricHeader("sector")).toBe("Sector");
    expect(metricHeader("pe", { pe: "RATIO" })).toBe("P/E (times)");
  });
});

describe("request builder (SCR-02, SCR-04, SEC-04 UI side)", () => {
  it("builds numeric, between and text filters with real numbers", () => {
    const r = buildQuery({
      ...draftWith(
        f({ id: 1, metric: "roe", op: ">", a: "15" }),
        f({ id: 2, metric: "market_cap_cr", op: "between", a: "5000", b: "100000" }),
        f({ id: 3, metric: "sector", op: "in", list: "IT, Energy ," }),
      ),
      sortMetric: "roe",
      sortDir: "desc",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.filters).toEqual([
      { metric: "roe", op: ">", value: 15 },
      { metric: "market_cap_cr", op: "between", value: [5000, 100000] },
      { metric: "sector", op: "in", value: ["IT", "Energy"] },
    ]);
    expect(r.body.sort).toEqual({ metric: "roe", dir: "desc" });
    expect(r.body.limit).toBe(50);
    expect(r.body.universe).toEqual({ kind: "equity" });
  });

  it("accepts 12 filters and refuses a 13th", () => {
    const mk = (n: number) =>
      draftWith(...Array.from({ length: n }, (_, i) => f({ id: i + 1, a: "1" })));
    expect(buildQuery(mk(SCREENER_LIMITS.filters)).ok).toBe(true);
    const r = buildQuery(mk(SCREENER_LIMITS.filters + 1));
    expect(r.ok).toBe(false);
  });

  it("an empty or non-numeric value is an error, never 0", () => {
    for (const a of ["", " ", "abc", "1e3", "NaN", "Infinity", "1,5", "1e16", "--1"]) {
      const r = buildQuery(draftWith(f({ a })));
      expect(r.ok, `value ${JSON.stringify(a)}`).toBe(false);
    }
    expect(parseNumber("-0.5")).toBe(-0.5);
    expect(parseNumber("1000000000000000")).toBe(1e15);
  });

  it("between needs two ordered numbers; in needs 1 to 50 names", () => {
    expect(buildQuery(draftWith(f({ op: "between", a: "10", b: "5" }))).ok).toBe(false);
    expect(buildQuery(draftWith(f({ op: "between", a: "10", b: "" }))).ok).toBe(false);
    const many = Array.from({ length: 51 }, (_, i) => `S${i}`).join(",");
    expect(buildQuery(draftWith(f({ metric: "sector", op: "in", list: many }))).ok).toBe(false);
    expect(buildQuery(draftWith(f({ metric: "sector", op: "in", list: " , " }))).ok).toBe(false);
    expect(buildQuery(draftWith(f({ metric: "sector", op: "=", list: "x".repeat(101) }))).ok).toBe(
      false,
    );
  });

  it("a metric outside the whitelist or an operator that does not fit is refused", () => {
    expect(buildQuery(draftWith(f({ metric: "pe; DROP TABLE x", a: "1" }))).ok).toBe(false);
    expect(buildQuery(draftWith(f({ metric: "sector", op: ">", list: "a" }))).ok).toBe(false);
    expect(buildQuery(draftWith(f({ metric: "roe", op: "in", a: "1" }))).ok).toBe(false);
    expect(buildQuery({ ...draftWith(), sortMetric: "evil" }).ok).toBe(false);
  });

  it("SQL-looking text stays data inside the JSON body", () => {
    const text = "'; DROP TABLE screener_row; --";
    const r = buildQuery(draftWith(f({ metric: "sector", op: "=", list: text })));
    expect(r.ok).toBe(true);
    if (r.ok) expect(JSON.stringify(r.body)).toContain(JSON.stringify(text));
  });

  it("columns are whitelisted and de-duplicated; display order is filters, sort, columns", () => {
    const d: Draft = {
      ...draftWith(f({ metric: "roe", a: "1" })),
      sortMetric: "pe",
      columns: ["roe", "pb", "pb", "bogus"],
    };
    const r = buildQuery(d);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.columns).toEqual(["roe", "pb"]);
    expect(displayMetrics(r.body)).toEqual(["roe", "pe", "pb"]);
    expect(toSavedSpec(r.body)).not.toHaveProperty("limit");
  });

  it("saved specs load back into the builder; unknown metrics are dropped and reported", () => {
    let id = 0;
    const { draft, dropped } = specToDraft(
      {
        filters: [
          { metric: "pe", op: "between", value: [5, 15] },
          { metric: "sector", op: "in", value: ["IT", "Energy"] },
          { metric: "retired_metric", op: ">", value: 1 },
        ],
        sort: { metric: "pe", dir: "asc" },
        columns: ["roe", "nope"],
        universe: { kind: "etf", company_type: "financial", index: "NIFTY 50" },
      },
      () => ++id,
    );
    expect(dropped).toEqual(["retired metric"]);
    expect(draft.filters.map((x) => [x.metric, x.op, x.a, x.b, x.list])).toEqual([
      ["pe", "between", "5", "15", ""],
      ["sector", "in", "", "", "IT, Energy"],
    ]);
    expect(draft).toMatchObject({
      sortMetric: "pe",
      sortDir: "asc",
      columns: ["roe"],
      kind: "etf",
      companyType: "financial",
      index: "NIFTY 50",
    });
  });
});

describe("saved screen names (SCR-06)", () => {
  it("follows the server pattern", () => {
    expect(savedNameError("My screen (v2)")).toBeNull();
    expect(savedNameError("")).not.toBeNull();
    expect(savedNameError(" -lead")).not.toBeNull();
    expect(savedNameError("a/b")).not.toBeNull();
    expect(savedNameError("x".repeat(61))).not.toBeNull();
    expect(savedNameError("x".repeat(60))).toBeNull();
  });
});

describe("cell text (UI-02, FND-14)", () => {
  it("an unknown value is a dash with a reason, never 0, NaN or Infinity", () => {
    for (const v of [null, undefined]) {
      const r = formatMetric("roe", v, "not_available");
      expect(r.text).toBe("—");
      expect(r.reason).toBe("not available for this stock");
    }
    expect(formatMetric("roe", Number.NaN).text).toBe("—");
    expect(formatMetric("roe", Number.POSITIVE_INFINITY).text).toBe("—");
    expect(formatMetric("roe", null, "no_data_entered").reason).toBe("no data entered");
  });
  it("formats by unit through lib/format", () => {
    expect(formatMetric("roe", 18.5).text).toBe("18.50%");
    expect(formatMetric("pe", 24.3).text).toBe("24.30x");
    expect(formatMetric("market_cap_cr", 250000).text).toBe("₹2.50 L Cr");
    expect(formatMetric("fii_change_qoq", 0.5).text).toBe("+0.50 pp");
    expect(formatMetric("fii_change_qoq", -0.5).text).toBe("-0.50 pp");
    expect(formatMetric("quality_score", 71.24).text).toBe("71.2");
    expect(formatMetric("sector", "IT").text).toBe("IT");
  });
});

describe("stamps (D-R)", () => {
  it("shows the IST date and source, or says there is no owner data", () => {
    expect(
      stampText({
        last_updated: "2026-10-20",
        last_updated_source: "fundamentals",
        stale: false,
        stale_reason: null,
      }),
    ).toBe("20 Oct 2026 (fundamentals)");
    expect(
      stampText({
        last_updated: null,
        last_updated_source: null,
        stale: true,
        stale_reason: "no_owner_data",
      }),
    ).toBe("No owner data");
    expect(staleReasonText("fundamentals_older_than_120_days")).toMatch(/120 days/);
    expect(staleReasonText("shareholding_older_than_135_days")).toMatch(/135 days/);
  });
});

describe("CSV export (IMP-15 guard, SCR export)", () => {
  it("guards formulas, writes unknowns as empty cells and keeps units in headers", () => {
    const items = [
      screenerItemSchema.parse(
        item("TCS", { name: "=HYPERLINK(1)", values: { roe: 18.5, pe: null } }),
      ),
      screenerItemSchema.parse(
        item("M&M", {
          values: { roe: -2.5, pe: 10 },
          stale: true,
          stale_reason: "no_owner_data",
          last_updated: null,
          last_updated_source: null,
        }),
      ),
    ];
    const csv = screenerCsv(items, ["roe", "pe"], { roe: "PERCENT", pe: "RATIO" });
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe(
      "Symbol,Name,ROE (percent),P/E (times),Coverage (percent of metrics),Last updated (IST date),Last updated source,Stale,Stale reason",
    );
    expect(lines[1]).toBe("TCS,'=HYPERLINK(1),18.5,,83,2026-10-20,fundamentals,false,");
    expect(lines[2]).toBe("M&M,M&M Ltd,-2.5,10,83,,,true,no_owner_data");
  });
});

describe("compare input (CMP-03)", () => {
  it("2 to 5 distinct symbols of the server charset, upper-cased", () => {
    expect(parseSymbols("tcs, m&m bajaj-auto")).toEqual({
      ok: true,
      symbols: ["TCS", "M&M", "BAJAJ-AUTO"],
    });
    expect(parseSymbols("TCS,tcs").ok).toBe(false);
    expect(parseSymbols("TCS").ok).toBe(false);
    expect(parseSymbols("A,B,C,D,E,F").ok).toBe(false);
    expect(parseSymbols("TCS,<script>").ok).toBe(false);
    expect(parseSymbols("TCS,../x").ok).toBe(false);
    expect(parseSymbols(`TCS,${"X".repeat(21)}`).ok).toBe(false);
    expect(parseRange("5Y")).toBe("5Y");
    expect(parseRange("10Y")).toBe("1Y");
    expect(parseRange(null)).toBe("1Y");
  });
});

describe("derived_as_of (D05bGo-3)", () => {
  it("shows an RFC 3339 instant in IST and a plain date as a date", () => {
    expect(formatDerivedAsOf("2026-11-10T10:00:00Z").text).toBe("10 Nov 2026, 15:30 IST");
    expect(formatDerivedAsOf("2026-11-10T19:00:00Z").text).toBe("11 Nov 2026, 00:30 IST");
    expect(formatDerivedAsOf("2026-10-09").text).toBe("9 Oct 2026");
    expect(formatDerivedAsOf(null).reason).not.toBeNull();
  });
});
