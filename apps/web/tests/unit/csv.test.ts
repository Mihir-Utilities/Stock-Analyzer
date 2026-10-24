import { describe, expect, it } from "vitest";
import { csvCell, toCsv } from "@/components/ui/csv";

describe("IMP-15 CSV export is injection safe", () => {
  it.each([
    ["=cmd|' /C calc'!A0", "'=cmd|' /C calc'!A0"],
    ["+1+1", "'+1+1"],
    ["-2+3", "'-2+3"],
    ["@SUM(A1)", "'@SUM(A1)"],
    ["\tTAB", "'\tTAB"],
  ])("prefixes %j with an apostrophe", (input, expected) => {
    expect(csvCell(input)).toBe(expected);
  });

  it("prefixes before quoting, and quotes commas, quotes and newlines", () => {
    expect(csvCell('=HYPERLINK("http://x","y")')).toBe(`"'=HYPERLINK(""http://x"",""y"")"`);
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
  });

  it("leaves numbers numeric and never writes NaN, Infinity or null text", () => {
    expect(csvCell(-5.5)).toBe("-5.5");
    expect(csvCell(Number.NaN)).toBe("");
    expect(csvCell(Number.POSITIVE_INFINITY)).toBe("");
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });

  it("builds rows with CRLF and applies the rule to headers as well", () => {
    expect(toCsv(["=h", "v"], [["x", 1]])).toBe("'=h,v\r\nx,1\r\n");
  });
});
