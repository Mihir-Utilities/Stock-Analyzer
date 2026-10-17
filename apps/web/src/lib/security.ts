// Security headers and the auth-gate decision, kept pure so they can be unit tested
// (SEC-06, docs/06-frontend-spec.md section 1, CLAUDE.md section 4).

import { loginUrlFor } from "./safe-next";

export const SESSION_COOKIE = "session";

/** Paths that never need the session cookie. `/login` is public; `/api` answers 401 itself. */
export function isPublicPath(pathname: string): boolean {
  return (
    pathname === "/login" ||
    pathname.startsWith("/login/") ||
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname === "/theme-init.js" ||
    pathname === "/manifest.webmanifest" ||
    pathname === "/favicon.ico"
  );
}

export type GateDecision = { action: "next" } | { action: "redirect"; location: string };

/** No `session` cookie on a protected path -> /login with a validated `next`. */
export function gateDecision(pathname: string, search: string, hasSession: boolean): GateDecision {
  if (isPublicPath(pathname) || hasSession) return { action: "next" };
  return { action: "redirect", location: loginUrlFor(`${pathname}${search}`) };
}

/**
 * CSP from docs/06 section 1, plus a per-request nonce: Next.js emits inline bootstrap scripts, and
 * `script-src 'self'` alone would block them. Still no third-party script, font, frame or
 * connection is allowed. Development additionally needs 'unsafe-eval' for React's debugging tools.
 */
export function contentSecurityPolicy(nonce: string, dev = false): string {
  const script = ["'self'", `'nonce-${nonce}'`, ...(dev ? ["'unsafe-eval'"] : [])].join(" ");
  return [
    "default-src 'self'",
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    `script-src ${script}`,
    "connect-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** Headers added to every response (CSP is added per request by middleware). */
export const staticSecurityHeaders: ReadonlyArray<{ key: string; value: string }> = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
