"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { retryDelay, setUnauthorizedHandler, shouldRetry } from "@/lib/api/client";
import { loginUrlFor } from "@/lib/safe-next";

// Stale times per data type (docs/06 section 1), in ms. Screens pick the one they need.
export const STALE_TIME = {
  profile: 60_000,
  prices: 5 * 60_000,
  analysis: 10 * 60_000,
  fundamentals: 6 * 3_600_000,
  shareholding: 6 * 3_600_000,
  mf: 30 * 60_000,
  stockIndex: 3_600_000,
} as const;

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: shouldRetry, retryDelay, refetchOnWindowFocus: false },
    },
  });
}

/** Any API 401 clears every cache and returns to /login with a validated `next` (UI-15). */
export function handleUnauthorized(
  client: QueryClient,
  where: { pathname: string; search: string },
  go: (url: string) => void,
): void {
  client.clear();
  if (where.pathname === "/login") return; // never loop on the login page
  go(loginUrlFor(`${where.pathname}${where.search}`));
}

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(createQueryClient);

  useEffect(() => {
    setUnauthorizedHandler(() =>
      handleUnauthorized(client, window.location, (url) => window.location.assign(url)),
    );
    return () => setUnauthorizedHandler(null);
  }, [client]);

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
