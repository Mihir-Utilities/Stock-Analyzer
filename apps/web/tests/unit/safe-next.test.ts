import { describe, expect, it } from "vitest";
import { loginUrlFor, safeNext } from "@/lib/safe-next";

// SEC-06: open redirect via `next`. Same-origin relative paths only.
describe("safeNext (SEC-06)", () => {
  it.each([
    ["/stocks/TCS", "/stocks/TCS"],
    ["/stocks/M%26M?tab=chart", "/stocks/M%26M?tab=chart"],
    ["/stocks/BAJAJ-AUTO", "/stocks/BAJAJ-AUTO"],
    ["/compare?symbols=TCS,INFY", "/compare?symbols=TCS,INFY"],
    ["/", "/"],
  ])("keeps the local path %s", (input, expected) => {
    expect(safeNext(input)).toBe(expected);
  });

  it.each([
    "//evil.com",
    "//evil.com/path",
    "///evil.com",
    "/\\evil.com",
    "\\\\evil.com",
    "\\/evil.com",
    "https://evil.com",
    "http://evil.com/x",
    "HTTPS://evil.com",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "evil.com",
    "stocks",
    "/%2F%2Fevil.com",
    "/%5Cevil.com",
    "/%2f/evil.com",
    "/\tevil.com",
    "/\n/evil.com",
    "/ /evil.com",
    "/\u0000/evil.com",
    "/%0d%0a//evil.com",
    "/%E0%A4%A",
    "",
  ])("rejects %j", (input) => {
    expect(safeNext(input)).toBe("/");
  });

  it("rejects null, undefined and very long values", () => {
    expect(safeNext(null)).toBe("/");
    expect(safeNext(undefined)).toBe("/");
    expect(safeNext(`/${"a".repeat(3000)}`)).toBe("/");
  });

  it("never loops back into /login", () => {
    expect(safeNext("/login")).toBe("/");
    expect(safeNext("/login?next=/stocks")).toBe("/");
  });

  it("builds the login URL with an encoded, validated next", () => {
    expect(loginUrlFor("/stocks/M%26M?tab=chart")).toBe(
      `/login?next=${encodeURIComponent("/stocks/M%26M?tab=chart")}`,
    );
    expect(loginUrlFor("/")).toBe("/login");
    expect(loginUrlFor("//evil.com")).toBe("/login");
  });
});
