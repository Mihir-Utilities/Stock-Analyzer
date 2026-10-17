import { NextResponse, type NextRequest } from "next/server";
import { contentSecurityPolicy, gateDecision, newNonce, SESSION_COOKIE } from "@/lib/security";

// Auth gate (docs/06-frontend-spec.md section 1): no `session` cookie -> /login?next=<safe path>.
// The cookie is only checked for presence here; the API is the authority and answers 401 for a
// stale one, which clears caches and returns to /login (lib/api/client.ts).
export function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const decision = gateDecision(pathname, search, request.cookies.has(SESSION_COOKIE));
  if (decision.action === "redirect") {
    return NextResponse.redirect(new URL(decision.location, request.url));
  }

  const nonce = newNonce();
  const csp = contentSecurityPolicy(nonce, process.env.NODE_ENV === "development");
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  // Everything except Next's static assets and files in /public that carry no HTML.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|theme-init.js|manifest.webmanifest).*)"],
};
