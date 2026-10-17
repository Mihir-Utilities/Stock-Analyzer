import type { NextConfig } from "next";
import { staticSecurityHeaders } from "./src/lib/security";

// docs/06-frontend-spec.md section 1: `/api/:path*` is rewritten to the Go API so cookies are
// first-party and there is no CORS. API_BASE_URL is the API origin (no trailing slash, no /api).
const apiBase = (process.env.API_BASE_URL ?? "http://localhost:8080").replace(/\/+$/, "");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // D-OQ8: never run sharp (LGPL libvips). The app uses no raster images (docs/06a section 8).
  images: { unoptimized: true },
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiBase}/api/:path*` }];
  },
  async headers() {
    return [{ source: "/:path*", headers: [...staticSecurityHeaders] }];
  },
};

export default nextConfig;
