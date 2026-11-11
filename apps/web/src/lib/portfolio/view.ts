"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

// The All / Equity / Mutual funds switcher state (docs/06 6.7a). The view is a filter: the UI sends
// `view` explicitly (MFH-14: the API default is equity, the UI default is All) and never computes
// totals itself.

export const VIEWS = ["all", "equity", "mf"] as const;
export type PortfolioView = (typeof VIEWS)[number];

export const VIEW_LABEL: Record<PortfolioView, string> = {
  all: "All",
  equity: "Equity",
  mf: "Mutual funds",
};

/** An unknown or missing value falls back to All. */
export function parseView(raw: string | null | undefined): PortfolioView {
  return (VIEWS as readonly string[]).includes(raw ?? "") ? (raw as PortfolioView) : "all";
}

/** The query string with `view` set and the other parameters kept; `all` is written out explicitly. */
export function withView(search: string, view: PortfolioView): string {
  const p = new URLSearchParams(search);
  p.set("view", view);
  return p.toString();
}

function locationSearch(): string {
  return typeof window === "undefined" ? "" : window.location.search;
}

/**
 * The URL is the state (`?view=`). Switching rewrites the URL with history.replaceState (Next syncs
 * `useSearchParams` with it) and never reloads the page; back/forward and a changed URL are
 * followed. Outside the app router (tests) the location is read directly.
 */
export function useViewParam(): [PortfolioView, (v: PortfolioView) => void] {
  const sp = useSearchParams();
  const fromUrl = parseView(
    sp ? sp.get("view") : new URLSearchParams(locationSearch()).get("view"),
  );
  const [view, setView] = useState<PortfolioView>(fromUrl);
  // Next reports our own history.replaceState a moment later. Rapid arrow presses write several
  // views before the first report arrives, so the views we wrote are remembered and a report of one
  // of them is ignored; any other change of the URL (back/forward) is followed.
  const pending = useRef<PortfolioView[]>([]);
  const lastUrl = useRef<PortfolioView>(fromUrl);
  const clear = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (lastUrl.current === fromUrl) return;
    lastUrl.current = fromUrl;
    const i = pending.current.indexOf(fromUrl);
    if (i >= 0) {
      pending.current = pending.current.slice(i + 1);
      return;
    }
    pending.current = [];
    setView(fromUrl);
  }, [fromUrl]);
  useEffect(
    () => () => {
      if (clear.current !== null) clearTimeout(clear.current);
    },
    [],
  );
  const change = useCallback((v: PortfolioView) => {
    setView(v);
    pending.current = [...pending.current, v];
    if (clear.current !== null) clearTimeout(clear.current);
    clear.current = setTimeout(() => {
      pending.current = [];
    }, 1500);
    if (typeof window !== "undefined") {
      const url = `${window.location.pathname}?${withView(window.location.search, v)}${window.location.hash}`;
      window.history.replaceState(window.history.state, "", url);
    }
  }, []);
  return [view, change];
}
