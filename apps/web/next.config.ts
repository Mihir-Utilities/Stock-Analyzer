import type { NextConfig } from "next";
import { staticSecurityHeaders } from "./src/lib/security";

// docs/06-frontend-spec.md section 1: `/api/:path*` is rewritten to the Go API so cookies are
// first-party and there is no CORS. API_BASE_URL is the API origin (no trailing slash, no /api).
const apiBase = (process.env.API_BASE_URL ?? "http://localhost:8080").replace(/\/+$/, "");

// Build id for the service worker cache name (public/sw.js): the commit in CI, else the build time.
const buildId = (process.env.GITHUB_SHA ?? String(Date.now())).slice(0, 12);

const nextConfig: NextConfig = {
  env: { NEXT_PUBLIC_BUILD_ID: buildId },
  reactStrictMode: true,
  poweredByHeader: false,
  // D-OQ8: never run sharp (LGPL libvips). The app uses no raster images (docs/06a section 8).
  images: { unoptimized: true },
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiBase}/api/:path*` }];
  },
  async headers() {
    return [
      { source: "/:path*", headers: [...staticSecurityHeaders] },
      // The worker script must always be revalidated so a new version reaches the browser.
      // A stricter CSP than the page one: the worker only needs same-origin fetches (F15R-S10).
      {
        source: "/sw.js",
        headers: [
          { key: "Content-Security-Policy", value: "default-src 'none'; connect-src 'self'" },
          { key: "Cache-Control", value: "no-cache" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
};

export default nextConfig;
