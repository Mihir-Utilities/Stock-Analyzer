// @vitest-environment node
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { middleware } from "@/middleware";

// Review F01 #5: the login redirect is built from request.nextUrl.clone() (path and query replaced
// only), never from a hand-resolved request.url, and forwarded headers never inject another host.
describe("auth gate redirect behind a proxy (SEC-06)", () => {
  it("keeps the origin Next derived for the request and ignores forwarded-host input", () => {
    const req = new NextRequest("http://internal-service:10000/stocks/M%26M?tab=chart", {
      headers: {
        host: "internal-service:10000",
        "x-forwarded-host": "evil.example.net",
        "x-forwarded-proto": "https",
      },
    });
    const res = middleware(req);
    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get("location") ?? "", "http://internal-service:10000");
    expect(loc.host).toBe(req.nextUrl.host);
    expect(loc.host).not.toContain("evil.example.net");
    expect(loc.pathname).toBe("/login");
    expect(loc.searchParams.get("next")).toBe("/stocks/M%26M?tab=chart");
  });

  it("replaces the query instead of appending to the original one", () => {
    const res = middleware(new NextRequest("http://localhost:3000/mf?a=1&b=2"));
    const loc = new URL(res.headers.get("location") ?? "", "http://localhost:3000");
    expect([...loc.searchParams.keys()]).toEqual(["next"]);
  });

  it("lets a signed-in request through with a CSP", () => {
    const req = new NextRequest("http://internal-service:10000/", {
      headers: { cookie: "session=abc" },
    });
    const res = middleware(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("default-src");
  });
});
