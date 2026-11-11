"use client";

import { useEffect } from "react";

/** Registers /sw.js (app shell only) in production builds; a failure is silent, the app works without it. */
export function PwaRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
      /* no worker: no offline shell, nothing else changes */
    });
  }, []);
  return null;
}
