import { describe, expect, it } from "vitest";
import {
  DASH,
  asText,
  fiscalAnnualLabel,
  fiscalQuarterLabel,
  fiscalYear,
  formatCount,
  formatCrore,
  formatDate,
  formatDateTime,
  formatFraction,
  formatFreshness,
  formatInr,
  formatMb,
  formatMultiple,
  formatNumber,
  formatPercent,
  formatPercentOf,
  formatRatio,
  formatRelative,
  setGroupingPreference,
} from "@/lib/format";

describe("UI-24: formatInr (Indian grouping)", () => {
  it("groups in lakhs and crores", () => {
    expect(formatInr(1234567.89).text).toBe("₹12,34,567.89");
    expect(formatInr(999).text).toBe("₹999.00");
    expect(formatInr(1000).text).toBe("₹1,000.00");
    expect(formatInr(100000).text).toBe("₹1,00,000.00");
    expect(formatInr(123456789012).text).toBe("₹1,23,45,67,89,012.00");
  });
  it("handles zero, negative, tiny and negative zero", () => {
    expect(formatInr(0).text).toBe("₹0.00");
    expect(formatInr(-0).text).toBe("₹0.00");
    expect(formatInr(-1234.5).text).toBe("-₹1,234.50");
    expect(formatInr(0.004).text).toBe("₹0.00");
    expect(formatInr(-0.004).text).toBe("₹0.00");
    expect(formatInr(0.005).text).toBe("₹0.01");
  });
  it("rounds half away from zero on the decimal string, not binary floats", () => {
    expect(formatInr(1.005).text).toBe("₹1.01");
    expect(formatInr(2.675, { decimals: 2 }).text).toBe("₹2.68");
  });
  it("supports western grouping through the setting", () => {
    expect(formatInr(1234567.89, { grouping: "western" }).text).toBe("₹1,234,567.89");
    setGroupingPreference("western");
    expect(formatInr(1234567).text).toBe("₹1,234,567.00");
    setGroupingPreference("indian");
    expect(formatInr(1234567).text).toBe("₹12,34,567.00");
  });
  it("handles huge values without exponent notation", () => {
    expect(formatInr(1e21).text).not.toMatch(/e/i);
  });
});

describe("UI-24: formatCrore", () => {
  it("uses Cr below 1,00,000 Cr and L Cr from there", () => {
    expect(formatCrore(123456).text).toBe("₹1.23 L Cr");
    expect(formatCrore(99999).text).toBe("₹99,999 Cr");
    expect(formatCrore(100000).text).toBe("₹1.00 L Cr");
    expect(formatCrore(2345678).text).toBe("₹23.46 L Cr");
    expect(formatCrore(12345).text).toBe("₹12,345 Cr");
  });
  it("keeps 2 decimals below 1,000 Cr so small values are not shown as 0", () => {
    expect(formatCrore(0.4).text).toBe("₹0.40 Cr");
    expect(formatCrore(523.456).text).toBe("₹523.46 Cr");
    expect(formatCrore(0).text).toBe("₹0.00 Cr");
  });
  it("signs negatives", () => {
    expect(formatCrore(-250000).text).toBe("-₹2.50 L Cr");
    expect(formatCrore(-1500).text).toBe("-₹1,500 Cr");
  });
});

describe("UI-24: formatPercent (percent numbers) and formatFraction", () => {
  it("shows 2 dp and an explicit sign for changes", () => {
    expect(formatPercent(12.345, { signed: true }).text).toBe("+12.35%");
    expect(formatPercent(-0.5, { signed: true }).text).toBe("-0.50%");
    expect(formatPercent(12.3).text).toBe("12.30%");
    expect(formatPercent(-3).text).toBe("-3.00%");
  });
  it("zero is neutral; negative zero and values rounding to zero show 0.00%", () => {
    expect(formatPercent(0, { signed: true }).text).toBe("0.00%");
    expect(formatPercent(-0, { signed: true }).text).toBe("0.00%");
    expect(formatPercent(-0.001, { signed: true }).text).toBe("0.00%");
  });
  it("formatFraction multiplies by 100 (ML probabilities, ret_q*)", () => {
    expect(formatFraction(0.1234).text).toBe("12.34%");
    expect(formatFraction(-0.05, { signed: true }).text).toBe("-5.00%");
    expect(formatFraction(0.1234, { decimals: 0 }).text).toBe("12%");
  });
  it("reports the direction for arrows", () => {
    expect(formatPercent(1, { signed: true }).direction).toBe("up");
    expect(formatPercent(-1, { signed: true }).direction).toBe("down");
    expect(formatPercent(0, { signed: true }).direction).toBe("flat");
    expect(formatPercent(null).direction).toBe("flat");
  });
});

describe("UI-24: formatMultiple and numbers", () => {
  it("multiples", () => {
    expect(formatMultiple(23.456).text).toBe("23.46x");
    expect(formatMultiple(-4).text).toBe("-4.00x");
    expect(formatMultiple(0).text).toBe("0.00x");
  });
  it("plain numbers and counts use Indian grouping", () => {
    expect(formatNumber(1234567.891, { decimals: 1 }).text).toBe("12,34,567.9");
    expect(formatCount(2231).text).toBe("2,231");
    expect(formatCount(12345678).text).toBe("1,23,45,678");
    expect(formatCount(-1500).text).toBe("-1,500");
  });
});

describe("UI-02: every null shows a dash and a reason", () => {
  const all = [
    formatInr,
    formatCrore,
    formatPercent,
    formatFraction,
    formatMultiple,
    formatNumber,
    formatCount,
  ] as const;
  it("null, undefined, NaN and Infinity never render as 0/NaN/Infinity", () => {
    for (const f of all) {
      for (const v of [null, undefined, NaN, Infinity, -Infinity]) {
        const r = f(v);
        expect(r.text).toBe(DASH);
        expect(r.reason).toBeTruthy();
        expect(r.text).not.toMatch(/0|NaN|Infinity/);
      }
    }
  });
  it("uses the supplied reason, with a default otherwise", () => {
    expect(formatPercent(null, { reason: "n/m: base is negative" })).toMatchObject({
      text: DASH,
      reason: "n/m: base is negative",
    });
    expect(formatMultiple(null, { reason: "loss making" }).reason).toBe("loss making");
    expect(formatInr(null).reason).toBe("no data");
  });
  it("non-null values have no reason", () => {
    expect(formatInr(1).reason).toBeNull();
  });
  it("dates and fiscal labels also carry a reason when unknown", () => {
    expect(formatDate(null)).toMatchObject({ text: DASH });
    expect(formatDate("garbage").reason).toBeTruthy();
    expect(formatDateTime(undefined).reason).toBeTruthy();
    expect(formatRelative(null).reason).toBeTruthy();
    expect(fiscalQuarterLabel(null).reason).toBeTruthy();
  });
  it("asText gives chart formatters a plain string", () => {
    expect(asText(formatPercent)(null)).toBe(DASH);
    expect(asText(formatPercent)(5)).toBe("5.00%");
  });
});

describe("UI-24: dates (IST)", () => {
  it("formats a date-only string without timezone shifts", () => {
    expect(formatDate("2026-10-10").text).toBe("10 Oct 2026");
    expect(formatDate("2026-01-01").text).toBe("1 Jan 2026");
    expect(formatDate("2026-12-31").text).toBe("31 Dec 2026");
  });
  it("rejects impossible calendar dates", () => {
    expect(formatDate("2026-02-30").text).toBe(DASH);
  });
  it("formats instants in IST, including across midnight", () => {
    expect(formatDateTime("2026-10-10T10:00:00Z").text).toBe("10 Oct 2026, 15:30 IST");
    expect(formatDateTime("2026-10-10T19:00:00Z").text).toBe("11 Oct 2026, 00:30 IST");
    expect(formatDateTime("2026-12-31T18:29:00Z").text).toBe("31 Dec 2026, 23:59 IST");
    expect(formatDateTime("2026-12-31T18:30:00Z").text).toBe("1 Jan 2027, 00:00 IST");
  });
  it("formats a date-time string that already carries an offset", () => {
    expect(formatDateTime("2026-10-10T15:30:00+05:30").text).toBe("10 Oct 2026, 15:30 IST");
  });
});

describe("formatRelative", () => {
  const now = new Date("2026-10-10T12:00:00Z");
  it("renders minutes, hours and days", () => {
    expect(formatRelative("2026-10-10T11:59:40Z", now).text).toBe("just now");
    expect(formatRelative("2026-10-10T11:55:00Z", now).text).toBe("5m ago");
    expect(formatRelative("2026-10-10T10:00:00Z", now).text).toBe("2h ago");
    expect(formatRelative("2026-10-07T12:00:00Z", now).text).toBe("3d ago");
  });
  it("falls back to the date after 30 days and handles the future", () => {
    expect(formatRelative("2026-08-01T12:00:00Z", now).text).toBe("1 Aug 2026");
    expect(formatRelative("2026-10-10T14:00:00Z", now).text).toBe("in 2h");
    expect(formatRelative("2026-10-10T12:00:20Z", now).text).toBe("just now");
  });
});

describe("FND-01: fiscal labels", () => {
  it("FY is the year of the March end", () => {
    expect(fiscalYear("2026-03-31")).toBe(2026);
    expect(fiscalYear("2026-04-01")).toBe(2027);
    expect(fiscalYear("2026-06-30")).toBe(2027);
    expect(fiscalYear("2027-03-31")).toBe(2027);
  });
  it("quarter labels at all boundaries", () => {
    expect(fiscalQuarterLabel("2026-09-30").text).toBe("Q2 FY27 (Sep 2026)");
    expect(fiscalQuarterLabel("2026-03-31").text).toBe("Q4 FY26 (Mar 2026)");
    expect(fiscalQuarterLabel("2026-06-30").text).toBe("Q1 FY27 (Jun 2026)");
    expect(fiscalQuarterLabel("2026-12-31").text).toBe("Q3 FY27 (Dec 2026)");
    expect(fiscalQuarterLabel("2025-12-31").text).toBe("Q3 FY26 (Dec 2025)");
    expect(fiscalQuarterLabel("2027-03-31").text).toBe("Q4 FY27 (Mar 2027)");
  });
  it("annual labels", () => {
    expect(fiscalAnnualLabel("2026-03-31").text).toBe("FY26 (Mar 2026)");
    expect(fiscalAnnualLabel("2027-03-31").text).toBe("FY27 (Mar 2027)");
  });
  it("a period end that is not a quarter end gets a reason, not a guess", () => {
    const r = fiscalQuarterLabel("2026-08-15");
    expect(r.text).toBe(DASH);
    expect(r.reason).toMatch(/quarter end/);
    expect(fiscalAnnualLabel("2026-09-30").text).toBe(DASH);
  });
  it("century boundary keeps two digits", () => {
    expect(fiscalAnnualLabel("2100-03-31").text).toBe("FY00 (Mar 2100)");
  });
});

describe("formatFreshness (source and as-of chips)", () => {
  it("builds source and as-of text", () => {
    expect(formatFreshness({ source: "AMFI NAV file", asOf: "2026-10-09" })).toEqual({
      source: "AMFI NAV file",
      asOf: "9 Oct 2026",
      text: "AMFI NAV file, as of 9 Oct 2026",
    });
  });
  it("shows a reason when the as-of date is unknown", () => {
    const r = formatFreshness({ source: "Owner import", asOf: null });
    expect(r.asOf).toBe(DASH);
    expect(r.text).toBe("Owner import, as of unknown");
  });
});

describe("UI-24: review fixes (crore tier, grouping preference, F13a helpers, IST midnight)", () => {
  it("formatCrore picks the tier from the rounded value: 99,999.6 is lakh-crore", () => {
    expect(formatCrore(99999.6).text).toBe("₹1.00 L Cr");
    expect(formatCrore(99999.4).text).toBe("₹99,999 Cr");
    expect(formatCrore(-99999.6).text).toBe("-₹1.00 L Cr");
    expect(formatCrore(999.996).text).toBe("₹1,000 Cr");
  });
  it("formatPercent and formatMultiple honour the western grouping preference", () => {
    expect(formatPercent(1234567.891).text).toBe("12,34,567.89%");
    expect(formatMultiple(1234567.891).text).toBe("12,34,567.89x");
    setGroupingPreference("western");
    try {
      expect(formatPercent(1234567.891).text).toBe("1,234,567.89%");
      expect(formatMultiple(1234567.891).text).toBe("1,234,567.89x");
      expect(formatPercent(1234567.891, { grouping: "indian" }).text).toBe("12,34,567.89%");
    } finally {
      setGroupingPreference("indian");
    }
  });
  it("formatMb: unit, grouping, small values keep two decimals, unknown has a reason", () => {
    expect(formatMb(12.345).text).toBe("12.3 MB");
    expect(formatMb(1234.56).text).toBe("1,234.6 MB");
    expect(formatMb(0.01).text).toBe("0.01 MB");
    expect(formatMb(0).text).toBe("0.0 MB");
    expect(formatMb(-0.04).direction).toBe("down");
    for (const v of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      const f = formatMb(v);
      expect([f.text, f.reason === null]).toEqual([DASH, false]);
    }
  });
  it("formatRatio uses 4 decimals; formatPercentOf never shows -0.0% and needs a positive total", () => {
    expect(formatRatio(0.5).text).toBe("0.5000");
    expect(formatRatio(null).reason).not.toBeNull();
    expect(formatPercentOf(1, 380).text).toBe("0.3%");
    expect(formatPercentOf(-0.0001, 380).text).toBe("0.0%");
    expect(formatPercentOf(1.005, 100).text).toBe("1.0%");
    expect(formatPercentOf(5, 0).text).toBe(DASH);
    expect(formatPercentOf(5, 0).reason).not.toBeNull();
    expect(formatPercentOf(null, 10).text).toBe(DASH);
  });
  it("IST midnight: the instant just before and after 00:00 IST lands on different days", () => {
    expect(formatDate("2026-10-10T18:29:59Z").text).toBe("10 Oct 2026");
    expect(formatDate("2026-10-10T18:30:00Z").text).toBe("11 Oct 2026");
    expect(formatDateTime("2026-10-10T18:30:00Z").text).toBe("11 Oct 2026, 00:00 IST");
    expect(formatDate(new Date("2026-12-31T18:30:00Z")).text).toBe("1 Jan 2027");
  });
});
