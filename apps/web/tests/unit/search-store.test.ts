import { describe, expect, it, vi } from "vitest";
import {
  INDEX_MAX_AGE_MS,
  INDEX_REVALIDATE_AFTER_MS,
  RECENT_KEY,
  RECENT_MAX,
  isValidRecentKey,
  loadStockIndex,
  memoryIndexStore,
  pushRecent,
  readRecents,
  type CachedIndex,
} from "@/lib/search/store";
import type { IndexItem } from "@/lib/search/rank";

const items: IndexItem[] = [[1, "TCS", "Tata Consultancy Services Ltd", 2]];
const NOW = 1_800_000_000_000;

function cached(ageMs: number, generatedAt = "g1"): CachedIndex {
  return { generatedAt, fetchedAt: NOW - ageMs, items };
}

describe("UI-22: loadStockIndex (IndexedDB cache by generated_at)", () => {
  it("uses a fresh cache without any network call", async () => {
    const fetchIndex = vi.fn();
    const r = await loadStockIndex({
      store: memoryIndexStore(cached(60_000)),
      fetchIndex,
      now: () => NOW,
    });
    expect(fetchIndex).not.toHaveBeenCalled();
    expect(r.snapshot.items).toEqual(items);
    expect(r.refresh).toBeNull();
  });

  it("fetches and stores when there is no cache", async () => {
    const store = memoryIndexStore();
    const fetchIndex = vi.fn().mockResolvedValue({ generatedAt: "g2", items });
    const r = await loadStockIndex({ store, fetchIndex, now: () => NOW });
    expect(r.snapshot.generatedAt).toBe("g2");
    expect(await store.get()).toEqual({ generatedAt: "g2", fetchedAt: NOW, items });
  });

  it("refreshes when the cache is older than 24 h", async () => {
    const fetchIndex = vi.fn().mockResolvedValue({ generatedAt: "g2", items });
    const r = await loadStockIndex({
      store: memoryIndexStore(cached(INDEX_MAX_AGE_MS + 1)),
      fetchIndex,
      now: () => NOW,
    });
    expect(fetchIndex).toHaveBeenCalledOnce();
    expect(r.snapshot.generatedAt).toBe("g2");
  });

  it("keeps an expired cache (marked stale) when the network fails", async () => {
    const r = await loadStockIndex({
      store: memoryIndexStore(cached(INDEX_MAX_AGE_MS + 1)),
      fetchIndex: () => Promise.reject(new Error("offline")),
      now: () => NOW,
    });
    expect(r.snapshot.stale).toBe(true);
    expect(r.snapshot.items).toEqual(items);
  });

  it("throws when there is neither cache nor network", async () => {
    await expect(
      loadStockIndex({
        store: memoryIndexStore(),
        fetchIndex: () => Promise.reject(new Error("offline")),
        now: () => NOW,
      }),
    ).rejects.toThrow("offline");
  });

  it("serves a cache older than 1 h immediately and revalidates in the background", async () => {
    const changed = [
      [1, "TCS", "Tata Consultancy Services Ltd", 2],
      [2, "INFY", "Infosys", 2],
    ];
    const fetchIndex = vi.fn().mockResolvedValue({ generatedAt: "g2", items: changed });
    const r = await loadStockIndex({
      store: memoryIndexStore(cached(INDEX_REVALIDATE_AFTER_MS + 1)),
      fetchIndex,
      now: () => NOW,
    });
    expect(r.snapshot.generatedAt).toBe("g1");
    expect((await r.refresh)?.generatedAt).toBe("g2");
  });

  it("background revalidation with the same generated_at reports no change; failures are silent", async () => {
    const same = await loadStockIndex({
      store: memoryIndexStore(cached(INDEX_REVALIDATE_AFTER_MS + 1)),
      fetchIndex: () => Promise.resolve({ generatedAt: "g1", items }),
      now: () => NOW,
    });
    expect(await same.refresh).toBeNull();
    const failing = await loadStockIndex({
      store: memoryIndexStore(cached(INDEX_REVALIDATE_AFTER_MS + 1)),
      fetchIndex: () => Promise.reject(new Error("x")),
      now: () => NOW,
    });
    expect(await failing.refresh).toBeNull();
  });
});

function fakeStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  };
}

describe("UI-22: exact cache boundaries and clock skew", () => {
  const fetchOnce = () => vi.fn().mockResolvedValue({ generatedAt: "g1", items });
  it("just under 1 h is fresh (no call); exactly 1 h revalidates in the background", async () => {
    const under = fetchOnce();
    const a = await loadStockIndex({
      store: memoryIndexStore(cached(INDEX_REVALIDATE_AFTER_MS - 1)),
      fetchIndex: under,
      now: () => NOW,
    });
    expect(under).not.toHaveBeenCalled();
    expect(a.refresh).toBeNull();
    const exact = fetchOnce();
    const b = await loadStockIndex({
      store: memoryIndexStore(cached(INDEX_REVALIDATE_AFTER_MS)),
      fetchIndex: exact,
      now: () => NOW,
    });
    expect(b.snapshot.stale).toBe(false);
    expect(b.refresh).not.toBeNull();
    await b.refresh;
    expect(exact).toHaveBeenCalledTimes(1);
  });
  it("exactly 24 h is still served (and revalidated); 24 h + 1 ms is fetched first", async () => {
    const at = fetchOnce();
    const a = await loadStockIndex({
      store: memoryIndexStore(cached(INDEX_MAX_AGE_MS)),
      fetchIndex: at,
      now: () => NOW,
    });
    expect(a.refresh).not.toBeNull(); // served from cache, revalidating
    const over = vi.fn().mockResolvedValue({ generatedAt: "g2", items });
    const b = await loadStockIndex({
      store: memoryIndexStore(cached(INDEX_MAX_AGE_MS + 1)),
      fetchIndex: over,
      now: () => NOW,
    });
    expect(over).toHaveBeenCalledTimes(1);
    expect(b.snapshot.generatedAt).toBe("g2");
    expect(b.refresh).toBeNull();
  });
  it("a future fetchedAt (clock skew) is never fresh: it revalidates and is replaced", async () => {
    const f = vi.fn().mockResolvedValue({ generatedAt: "g2", items });
    const store = memoryIndexStore(cached(-5 * 3_600_000));
    const r = await loadStockIndex({ store, fetchIndex: f, now: () => NOW });
    expect(r.refresh).not.toBeNull();
    expect((await r.refresh)?.generatedAt).toBe("g2");
    expect(f).toHaveBeenCalledTimes(1);
    expect((await store.get())?.fetchedAt).toBe(NOW); // the future stamp is gone
  });
});

describe("UI-21: recent searches", () => {
  it("keeps the latest 8, most recent first, without duplicates", () => {
    const s = fakeStorage();
    for (let i = 0; i < 12; i++) {
      pushRecent({ kind: "stock", key: `S${i}`, label: `S${i}`, sub: "n" }, s);
    }
    pushRecent({ kind: "stock", key: "S9", label: "S9", sub: "n" }, s);
    const r = readRecents(s);
    expect(r).toHaveLength(RECENT_MAX);
    expect(r[0]?.key).toBe("S9");
    expect(r.filter((x) => x.key === "S9")).toHaveLength(1);
  });
  it("a stock and a fund with the same key are different entries", () => {
    const s = fakeStorage();
    pushRecent({ kind: "stock", key: "1", label: "A", sub: "" }, s);
    pushRecent({ kind: "fund", key: "1", label: "B", sub: "" }, s);
    expect(readRecents(s)).toHaveLength(2);
  });
  it("ignores corrupt or tampered storage", () => {
    const s = fakeStorage();
    s.setItem(RECENT_KEY, "{not json");
    expect(readRecents(s)).toEqual([]);
    s.setItem(RECENT_KEY, JSON.stringify([{ kind: "evil", key: 1 }]));
    expect(readRecents(s)).toEqual([]);
    expect(readRecents(null)).toEqual([]);
  });
});

describe("UI-21: tampered recents are dropped on read", () => {
  it("keeps valid entries and drops keys that are not a symbol or a numeric scheme code", () => {
    const s = fakeStorage();
    s.setItem(
      RECENT_KEY,
      JSON.stringify([
        { kind: "fund", key: "../x?", label: "evil", sub: "" },
        { kind: "fund", key: "120503", label: "Axis", sub: "" },
        { kind: "fund", key: "12 3", label: "space", sub: "" },
        { kind: "stock", key: "../../admin", label: "x", sub: "" },
        { kind: "stock", key: "tcs", label: "lower", sub: "" },
        { kind: "stock", key: "M&M", label: "M&M", sub: "Mahindra" },
      ]),
    );
    expect(readRecents(s).map((r) => `${r.kind}:${r.key}`)).toEqual(["fund:120503", "stock:M&M"]);
  });
  it("isValidRecentKey mirrors the API symbol charset", () => {
    expect(isValidRecentKey("stock", "BAJAJ-AUTO")).toBe(true);
    expect(isValidRecentKey("stock", "A".repeat(31))).toBe(false);
    expect(isValidRecentKey("fund", "0")).toBe(true);
    expect(isValidRecentKey("fund", "1e3")).toBe(false);
  });
});
