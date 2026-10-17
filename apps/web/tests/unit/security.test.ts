// @vitest-environment node
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { middleware, config } from "@/middleware";
import {
  contentSecurityPolicy,
  gateDecision,
  isPublicPath,
  staticSecurityHeaders,
} from "@/lib/security";

describe("auth gate (docs/06 section 1)", () => {
  it("redirects to /login with an encoded next when there is no session cookie", () => {
    expect(gateDecision("/stocks/M%26M", "?tab=chart", false)).toEqual({
      action: "redirect",
      location: `/login?next=${encodeURIComponent("/stocks/M%26M?tab=chart")}`,
    });
  });

  it("lets a request with a session cookie through", () => {
    expect(gateDecision("/portfolio", "", true)).toEqual({ action: "next" });
  });

  it("keeps /login and /api public", () => {
    for (const p of ["/login", "/api/v1/healthz", "/api/v1/auth/login"]) {
      expect(isPublicPath(p)).toBe(true);
    }
    expect(isPublicPath("/loginx")).toBe(false);
    expect(isPublicPath("/apiary")).toBe(false);
  });

  it("does not turn a protocol-relative path into an off-origin redirect (SEC-06)", () => {
    const d = gateDecision("//evil.com", "", false);
    expect(d).toEqual({ action: "redirect", location: "/login" });
  });
});

describe("middleware", () => {
  it("redirects an anonymous visit to /login?next=", () => {
    const res = middleware(new NextRequest("http://localhost:3000/stocks?tab=chart"));
    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get("location") ?? "");
    expect(loc.origin).toBe("http://localhost:3000");
    expect(loc.pathname).toBe("/login");
    expect(loc.searchParams.get("next")).toBe("/stocks?tab=chart");
  });

  it("never redirects off-origin even for a hostile path (SEC-06)", () => {
    const res = middleware(new NextRequest("http://localhost:3000//evil.com/x"));
    const loc = new URL(res.headers.get("location") ?? "http://localhost:3000/");
    expect(loc.origin).toBe("http://localhost:3000");
  });

  it("serves /login without a cookie and attaches a per-request CSP nonce", () => {
    const a = middleware(new NextRequest("http://localhost:3000/login"));
    const b = middleware(new NextRequest("http://localhost:3000/login"));
    const cspA = a.headers.get("content-security-policy") ?? "";
    const cspB = b.headers.get("content-security-policy") ?? "";
    expect(cspA).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+'/);
    expect(cspA).not.toBe(cspB);
  });

  it("passes through when the session cookie exists", () => {
    const req = new NextRequest("http://localhost:3000/", { headers: { cookie: "session=abc" } });
    expect(middleware(req).status).toBe(200);
  });

  it("does not run for static assets", () => {
    expect(config.matcher[0]).toContain("_next/static");
  });
});

describe("security headers (CLAUDE.md section 4)", () => {
  const csp = contentSecurityPolicy("N0NCE");

  it("matches the documented CSP and adds no third-party source", () => {
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("img-src 'self' data:");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("script-src 'self' 'nonce-N0NCE'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/https?:/);
    expect(csp).not.toContain("unsafe-eval");
    expect(contentSecurityPolicy("N", true)).toContain("'unsafe-eval'");
  });

  it("ships the static headers", () => {
    const keys = staticSecurityHeaders.map((h) => h.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        "X-Content-Type-Options",
        "X-Frame-Options",
        "Referrer-Policy",
        "Strict-Transport-Security",
        "Permissions-Policy",
      ]),
    );
  });
});
