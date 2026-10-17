import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import { Providers } from "@/components/shell/Providers";
import { themeStylesheet } from "@/lib/theme/theme-css";
import { interLatin, interLatinExt } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "India Stock & MF Analyzer",
  description: "Personal research tool. Not investment advice.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Reading the request headers opts the app into dynamic rendering, which is what lets Next
  // attach the per-request CSP nonce (middleware.ts) to its own bootstrap scripts.
  await headers();
  return (
    <html
      lang="en"
      data-theme="dark"
      suppressHydrationWarning
      className={`${interLatin.variable} ${interLatinExt.variable}`}
    >
      <head>
        <style id="theme-tokens" dangerouslySetInnerHTML={{ __html: themeStylesheet() }} />
        {/* Same-origin file (no inline script under the CSP): sets data-theme before first paint. */}
        {/* A blocking script is the point here: it must run before first paint to avoid a flash. */}
        {/* eslint-disable-next-line @next/next/no-sync-scripts */}
        <script src="/theme-init.js" />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
