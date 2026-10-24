import { z } from "zod";
import type { IndexItem } from "./rank";

// Browser-side persistence for the search palette: the stock index in IndexedDB and the last 8
// picks in localStorage. No third-party calls; everything stays on this device.

export const INDEX_MAX_AGE_MS = 24 * 3_600_000; // docs/06 section 4.1: refresh if > 24 h
export const INDEX_REVALIDATE_AFTER_MS = 3_600_000; // stock index staleTime (docs/06 section 1)
export const RECENT_MAX = 8;

export interface CachedIndex {
  /** `generated_at` from the API; the cache key. */
  generatedAt: string;
  /** Epoch ms when it was fetched. */
  fetchedAt: number;
  items: IndexItem[];
}

export interface IndexStore {
  get(): Promise<CachedIndex | null>;
  put(value: CachedIndex): Promise<void>;
}

export function memoryIndexStore(initial: CachedIndex | null = null): IndexStore {
  let value = initial;
  return {
    get: () => Promise.resolve(value),
    put: (v) => {
      value = v;
      return Promise.resolve();
    },
  };
}

const DB_NAME = "analyzer-search";
const STORE = "kv";
const KEY = "stocks-index";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
  });
}

const cachedSchema = z.object({
  generatedAt: z.string(),
  fetchedAt: z.number(),
  items: z.array(z.tuple([z.number(), z.string(), z.string(), z.number()])),
});

/** IndexedDB-backed store; falls back to memory when IndexedDB is unavailable (private mode). */
export function indexedDbStore(): IndexStore {
  const fallback = memoryIndexStore();
  const usable = typeof indexedDB !== "undefined";
  return {
    async get() {
      if (!usable) return fallback.get();
      try {
        const db = await openDb();
        const raw = await new Promise<unknown>((resolve, reject) => {
          const r = db.transaction(STORE).objectStore(STORE).get(KEY);
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error ?? new Error("read failed"));
        });
        db.close();
        const parsed = cachedSchema.safeParse(raw);
        return parsed.success ? (parsed.data as CachedIndex) : null;
      } catch {
        return fallback.get();
      }
    },
    async put(value) {
      await fallback.put(value);
      if (!usable) return;
      try {
        const db = await openDb();
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE, "readwrite");
          tx.objectStore(STORE).put(value, KEY);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error ?? new Error("write failed"));
        });
        db.close();
      } catch {
        /* cache is best effort */
      }
    },
  };
}

export interface IndexSnapshot {
  generatedAt: string;
  items: IndexItem[];
  /** True when the network failed and an expired cache is being shown. */
  stale: boolean;
}

export interface LoadDeps {
  store: IndexStore;
  /** Returns the fresh index or throws. */
  fetchIndex: () => Promise<{ generatedAt: string; items: IndexItem[] }>;
  now?: () => number;
}

export interface LoadResult {
  snapshot: IndexSnapshot;
  /** Set when the cache was older than the revalidate age: resolves with a newer snapshot, or null. */
  refresh: Promise<IndexSnapshot | null> | null;
}

/**
 * Cache first. No cache or older than 24 h: fetch (an expired cache is still shown if the network
 * fails). Older than 1 h: show the cache now and revalidate in the background; the browser sends
 * If-None-Match, so an unchanged index costs a 304.
 */
export async function loadStockIndex(deps: LoadDeps): Promise<LoadResult> {
  const now = deps.now ?? Date.now;
  const cached = await deps.store.get().catch(() => null);
  const age = cached ? now() - cached.fetchedAt : Infinity;

  const fetchAndStore = async (): Promise<IndexSnapshot> => {
    const fresh = await deps.fetchIndex();
    await deps.store.put({ generatedAt: fresh.generatedAt, fetchedAt: now(), items: fresh.items });
    return { generatedAt: fresh.generatedAt, items: fresh.items, stale: false };
  };

  if (cached && age <= INDEX_MAX_AGE_MS) {
    const snapshot = { generatedAt: cached.generatedAt, items: cached.items, stale: false };
    // "Cache < 1 h used with no call" (UI-22): exactly 1 h revalidates. A negative age (fetchedAt in
    // the future after a clock change) is never fresh; it revalidates and the new stamp replaces it.
    if (age >= 0 && age < INDEX_REVALIDATE_AFTER_MS) return { snapshot, refresh: null };
    const refresh = fetchAndStore().then(
      (s) => (s.generatedAt === cached.generatedAt ? null : s),
      () => null,
    );
    return { snapshot, refresh };
  }
  try {
    return { snapshot: await fetchAndStore(), refresh: null };
  } catch (err) {
    if (cached) {
      return {
        snapshot: { generatedAt: cached.generatedAt, items: cached.items, stale: true },
        refresh: null,
      };
    }
    throw err;
  }
}

// ---- recent searches -----------------------------------------------------------------------

export const RECENT_KEY = "analyzer-recent-searches";

/** Stock symbols as the API accepts them (`^[A-Z0-9][A-Z0-9&-]{0,29}$`); fund keys are scheme codes. */
const STOCK_KEY = /^[A-Z0-9][A-Z0-9&-]{0,29}$/;
const FUND_KEY = /^\d+$/;

/** True when `key` is safe to put into a route for this kind of result (UI-21 review). */
export function isValidRecentKey(kind: "stock" | "fund", key: string): boolean {
  return (kind === "stock" ? STOCK_KEY : FUND_KEY).test(key);
}

export const recentSchema = z
  .object({
    kind: z.enum(["stock", "fund"]),
    /** Symbol for stocks, scheme code (as text) for funds. */
    key: z.string(),
    label: z.string(),
    sub: z.string(),
  })
  .refine((r) => isValidRecentKey(r.kind, r.key), { message: "invalid key" });
export type RecentItem = z.infer<typeof recentSchema>;

export function readRecents(
  storage: Pick<Storage, "getItem"> | null = safeStorage(),
): RecentItem[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(RECENT_KEY);
    if (!raw) return [];
    const list: unknown = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    // Tampered entries are dropped one by one; the valid ones survive.
    const out: RecentItem[] = [];
    for (const entry of list) {
      const p = recentSchema.safeParse(entry);
      if (p.success) out.push(p.data);
    }
    return out.slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

/** Most recent first, de-duplicated by kind and key, capped at 8. Returns the new list. */
export function pushRecent(
  item: RecentItem,
  storage: Pick<Storage, "getItem" | "setItem"> | null = safeStorage(),
): RecentItem[] {
  const next = [
    item,
    ...readRecents(storage).filter((r) => !(r.kind === item.kind && r.key === item.key)),
  ].slice(0, RECENT_MAX);
  try {
    storage?.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* storage full or blocked */
  }
  return next;
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
