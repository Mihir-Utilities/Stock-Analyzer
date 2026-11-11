"use client";

import { useEffect } from "react";

/** Registers /sw.js (app shell only) in production builds; a failure is silent, the app works without it. */
export function PwaRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;
    // The build id in the URL gives each deploy its own worker cache (public/sw.js).
    const build = encodeURIComponent(process.env.NEXT_PUBLIC_BUILD_ID ?? "dev");
    navigator.serviceWorker.register(`/sw.js?v=${build}`, { scope: "/" }).catch(() => {
      /* no worker: no offline shell, nothing else changes */
    });
  }, []);
  return null;
}
