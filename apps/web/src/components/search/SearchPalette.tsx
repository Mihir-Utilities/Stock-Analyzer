"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { apiRequest } from "@/lib/api/client";
import { fetchStockIndex, searchFunds, searchStocksServer, type FundHit } from "@/lib/search/api";
import {
  FLAG,
  MAX_RESULTS,
  buildEntries,
  normalizeQuery,
  searchEntries,
  type IndexEntry,
  type IndexItem,
} from "@/lib/search/rank";
import {
  indexedDbStore,
  loadStockIndex,
  pushRecent,
  readRecents,
  type IndexStore,
  type RecentItem,
} from "@/lib/search/store";

// Global search palette (docs/06 section 4.1). Ctrl/Cmd+K or `/` opens it. The stock index is
// loaded at mount (IndexedDB cache) so opening is instant; funds use a 250 ms debounced server
// search. Combobox pattern: focus stays in the input, arrows move aria-activedescendant.

export const FUND_DEBOUNCE_MS = 250;
export const EMPTY_MATCH_TEXT = "No match. Try the company name or exchange symbol.";
export const NO_STOCKS_TEXT = "No stocks yet. Import instruments.csv or add a stock.";

type Row =
  | { kind: "stock"; key: string; label: string; sub: string; flags: number; href: string }
  | { kind: "fund"; key: string; label: string; sub: string; flags: 0; href: string };

const stockRow = (symbol: string, name: string, flags: number): Row => ({
  kind: "stock",
  key: symbol,
  label: symbol,
  sub: name,
  flags,
  href: `/stocks/${encodeURIComponent(symbol)}`,
});

const fundRow = (f: FundHit): Row => ({
  kind: "fund",
  key: String(f.code),
  label: f.name,
  sub: f.sub,
  flags: 0,
  href: `/mf/${f.code}`,
});

const recentRow = (r: RecentItem): Row =>
  r.kind === "stock"
    ? stockRow(r.key, r.sub, 0)
    : { kind: "fund", key: r.key, label: r.label, sub: r.sub, flags: 0, href: `/mf/${r.key}` };

function badgesFor(flags: number): string[] {
  const out: string[] = [];
  if (flags & FLAG.suspended) out.push("Suspended");
  if (flags & FLAG.delisted) out.push("Delisted");
  if (flags & FLAG.nonEquity) out.push("ETF/REIT");
  // `No broker data` is not shown: manual price mode (decision D-1), bit 1 is always 0.
  return out;
}

function isEditable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
}

export interface SearchPaletteProps {
  /** Test seams; production uses IndexedDB and the shared API client. */
  store?: IndexStore;
  request?: typeof apiRequest;
}

export function SearchPalette({ store, request = apiRequest }: SearchPaletteProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [entries, setEntries] = useState<IndexEntry[] | null>(null);
  const [indexState, setIndexState] = useState<"loading" | "ready" | "failed">("loading");
  const [serverStocks, setServerStocks] = useState<IndexItem[]>([]);
  const [funds, setFunds] = useState<FundHit[]>([]);
  const [fundsState, setFundsState] = useState<"idle" | "loading" | "error">("idle");
  const [recents, setRecents] = useState<RecentItem[]>([]);

  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const listId = useId();
  const titleId = useId();

  // Load the stock index once at mount so the palette opens instantly (UI-05).
  useEffect(() => {
    let alive = true;
    const s = store ?? indexedDbStore();
    loadStockIndex({ store: s, fetchIndex: () => fetchStockIndex(request) })
      .then(({ snapshot, refresh }) => {
        if (!alive) return;
        setEntries(buildEntries(snapshot.items));
        setIndexState("ready");
        void refresh?.then((next) => {
          if (alive && next) setEntries(buildEntries(next.items));
        });
      })
      .catch(() => {
        if (alive) setIndexState("failed");
      });
    return () => {
      alive = false;
    };
  }, [store, request]);

  const openPalette = useCallback(() => {
    returnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setRecents(readRecents());
    setQuery("");
    setActive(0);
    setOpen(true);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    const back = returnFocus.current ?? triggerRef.current;
    returnFocus.current = null;
    back?.focus();
  }, []);

  // Global shortcuts: Ctrl/Cmd+K toggles; `/` opens unless the user is typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (open) close();
        else openPalette();
      } else if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey && !open) {
        if (isEditable(e.target)) return;
        e.preventDefault();
        openPalette();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close, openPalette]);

  // Native <dialog>: modal, focus trap, Esc handled through the cancel event.
  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (open && !d.open) {
      if (typeof d.showModal === "function") d.showModal();
      else d.setAttribute("open", "");
      inputRef.current?.focus();
    }
    if (!open && d.open) {
      if (typeof d.close === "function") d.close();
      else d.removeAttribute("open");
    }
  }, [open]);
  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    const onCancel = (e: Event) => {
      e.preventDefault();
      close();
    };
    d.addEventListener("cancel", onCancel);
    return () => d.removeEventListener("cancel", onCancel);
  }, [close]);

  const trimmed = query.trim();
  const normalized = normalizeQuery(query);

  const stockHits = useMemo<Row[]>(() => {
    if (normalized === "") return [];
    if (indexState === "ready" && entries) {
      return searchEntries(entries, query, MAX_RESULTS).map((h) =>
        stockRow(h.entry.symbol, h.entry.name, h.entry.flags),
      );
    }
    return serverStocks.map(([, symbol, name, flags]) => stockRow(symbol, name, flags));
  }, [entries, indexState, normalized, query, serverStocks]);

  // Server fallback for stocks when the index could not be loaded.
  useEffect(() => {
    if (!open || indexState !== "failed" || normalized === "") return;
    const ctl = new AbortController();
    const t = setTimeout(() => {
      searchStocksServer(trimmed, request, ctl.signal).then(setServerStocks, () => {
        if (!ctl.signal.aborted) setServerStocks([]);
      });
    }, FUND_DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [open, indexState, normalized, trimmed, request]);

  // Funds: debounced server search (250 ms), cancelled when the query changes.
  useEffect(() => {
    if (!open || trimmed.length < 2) {
      // Clearing derived results when the query is too short; no external subscription involved.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFunds([]);
      setFundsState("idle");
      return;
    }
    const ctl = new AbortController();
    setFundsState("loading");
    const t = setTimeout(() => {
      searchFunds(trimmed, request, ctl.signal).then(
        (hits) => {
          if (ctl.signal.aborted) return;
          setFunds(hits);
          setFundsState("idle");
        },
        () => {
          if (ctl.signal.aborted) return;
          setFunds([]);
          setFundsState("error");
        },
      );
    }, FUND_DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [open, trimmed, request]);

  const showRecents = normalized === "" && recents.length > 0;
  const stockRows = showRecents
    ? recents.filter((r) => r.kind === "stock").map(recentRow)
    : stockHits;
  const fundRows = showRecents
    ? recents.filter((r) => r.kind === "fund").map(recentRow)
    : funds.map(fundRow);
  const flat = useMemo(() => [...stockRows, ...fundRows], [stockRows, fundRows]);
  const activeRow = flat[Math.min(active, flat.length - 1)];
  const optionId = (r: Row) => `${listId}-${r.kind}-${r.key}`;

  const choose = (r: Row) => {
    pushRecent({ kind: r.kind, key: r.key, label: r.label, sub: r.sub });
    returnFocus.current = null; // navigation moves focus to the new page
    setOpen(false);
    router.push(r.href);
  };

  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (flat.length === 0) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((a) => (Math.min(a, flat.length - 1) + step + flat.length) % flat.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (activeRow) choose(activeRow);
    }
  };

  const noStocksAtAll = indexState === "ready" && entries !== null && entries.length === 0;
  const searching = normalized !== "";
  const nothing = searching && stockRows.length === 0 && fundRows.length === 0;
  const settled = fundsState !== "loading" && (indexState !== "loading" || stockRows.length > 0);

  const group = (title: string, rows: Row[], groupId: string) =>
    rows.length === 0 ? null : (
      <div
        role="group"
        aria-labelledby={groupId}
        data-testid={`search-group-${title.toLowerCase()}`}
      >
        <div id={groupId} className="px-3 pb-1 pt-2 text-micro font-medium uppercase text-text-2">
          {title}
        </div>
        {rows.map((r) => {
          const isActive = activeRow === r;
          return (
            <div
              key={`${r.kind}-${r.key}`}
              id={optionId(r)}
              role="option"
              aria-selected={isActive}
              data-testid={`search-result-${r.kind}-${r.key}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(r)}
              onMouseMove={() => setActive(flat.indexOf(r))}
              className={`flex min-h-11 cursor-pointer items-center gap-3 px-3 py-2 ${
                isActive ? "bg-accent-weak" : ""
              }`}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-body font-medium text-text-1" title={r.label}>
                  {r.label}
                </span>
                {r.sub ? (
                  <span className="block truncate text-caption text-text-2" title={r.sub}>
                    {r.sub}
                  </span>
                ) : null}
              </span>
              {badgesFor(r.flags).map((b) => (
                <span
                  key={b}
                  data-testid={`search-badge-${b.toLowerCase().replace(/\W+/g, "-")}`}
                  className="shrink-0 rounded-chip border border-border bg-surface-2 px-2 py-0.5 text-micro text-text-1"
                >
                  {b}
                </span>
              ))}
            </div>
          );
        })}
      </div>
    );

  const announce = open
    ? !searching
      ? showRecents
        ? `${flat.length} recent searches`
        : ""
      : nothing && settled
        ? "No match"
        : `${flat.length} results`
    : "";

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={openPalette}
        aria-label="Search stocks and funds"
        aria-haspopup="dialog"
        aria-keyshortcuts="Control+K Meta+K /"
        data-testid="search-trigger"
        className="flex h-11 min-w-11 items-center gap-2 rounded-control border border-border bg-surface-2 px-3 text-body text-text-2 hover:text-text-1 desktop:h-9"
      >
        <span aria-hidden="true">Search</span>
        <kbd className="hidden rounded-control border border-border px-1 text-micro desktop:inline">
          Ctrl K
        </kbd>
      </button>
      <dialog
        ref={dialogRef}
        aria-labelledby={titleId}
        data-testid="search-dialog"
        onClick={(e) => {
          if (e.target === dialogRef.current) close();
        }}
        className="m-0 mx-auto mt-[10vh] w-[calc(100%-1rem)] max-w-xl rounded-card border border-border bg-surface-1 p-0 text-text-1 backdrop:bg-black/50"
      >
        <h2 id={titleId} className="sr-only">
          Search stocks and funds
        </h2>
        {open ? (
          <div className="flex max-h-[70vh] flex-col">
            <div className="flex items-center gap-2 border-b border-border p-2">
              <input
                ref={inputRef}
                type="text"
                role="combobox"
                aria-label="Search stocks and funds"
                aria-expanded={flat.length > 0}
                aria-controls={listId}
                aria-autocomplete="list"
                aria-activedescendant={activeRow ? optionId(activeRow) : undefined}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                placeholder="Symbol, company or fund name"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                onKeyDown={onInputKey}
                data-testid="search-input"
                className="h-11 min-w-0 flex-1 rounded-control bg-surface-2 px-3 text-lead text-text-1 placeholder:text-text-3"
              />
              <button
                type="button"
                onClick={close}
                data-testid="search-close"
                className="h-11 rounded-control px-3 text-body text-text-2 hover:text-text-1"
              >
                Close
              </button>
            </div>
            <div
              id={listId}
              role="listbox"
              aria-label="Search results"
              data-testid="search-results"
              className="min-h-0 flex-1 overflow-y-auto py-1"
            >
              {showRecents ? (
                <div className="px-3 pt-2 text-micro font-medium uppercase text-text-2">Recent</div>
              ) : null}
              {group("Stocks", stockRows, `${listId}-g-stocks`)}
              {group("Funds", fundRows, `${listId}-g-funds`)}
            </div>
            <div className="border-t border-border px-3 py-2 text-caption text-text-2">
              {noStocksAtAll && !searching ? (
                <p data-testid="search-no-instruments">
                  {NO_STOCKS_TEXT}{" "}
                  <Link
                    href="/imports"
                    onClick={close}
                    data-testid="search-import-link"
                    className="underline"
                  >
                    Open Import center
                  </Link>
                </p>
              ) : null}
              {!searching && !showRecents && !noStocksAtAll ? (
                <p data-testid="search-hint">
                  {indexState === "loading"
                    ? "Loading the stock list..."
                    : "Type a symbol, company or fund name. Arrow keys to move, Enter to open."}
                </p>
              ) : null}
              {searching && fundsState === "loading" && stockRows.length === 0 ? (
                <p data-testid="search-loading">Searching...</p>
              ) : null}
              {nothing && settled ? <p data-testid="search-empty">{EMPTY_MATCH_TEXT}</p> : null}
              {indexState === "failed" ? (
                <p data-testid="search-index-error">
                  The stock list could not be loaded; showing server search results.
                </p>
              ) : null}
              {fundsState === "error" ? (
                <p data-testid="search-funds-error">Fund search is unavailable right now.</p>
              ) : null}
            </div>
            <div aria-live="polite" role="status" className="sr-only" data-testid="search-status">
              {announce}
            </div>
          </div>
        ) : null}
      </dialog>
    </>
  );
}
