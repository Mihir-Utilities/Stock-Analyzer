import type { NextConfig } from "next";

// The /api rewrite to the Go API is added in F01 (see docs/06-frontend-spec.md section 1).
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
};

export default nextConfig;
