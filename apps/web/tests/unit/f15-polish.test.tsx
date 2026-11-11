import { act, render, screen } from "@testing-library/react";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import "./dom-matchers";

import { OFFLINE_MESSAGE, OfflineBanner } from "@/components/shell/OfflineBanner";
import { isPublicPath, isPwaShellPath } from "@/lib/security";

const web = process.cwd();
const repo = join(web, "../..");
const read = (p: string) => readFileSync(p, "utf8");
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const srcFiles = walk(join(web, "src")).filter((f) => /\.tsx$/.test(f));

// ---- UI-09: every API field has a home (docs/06 section 8, docs/field-map.json) -----------------

type FieldMap = Record<string, Record<string, string>>;
const fieldMap = JSON.parse(read(join(repo, "docs/field-map.json"))) as FieldMap;
const allSrc = walk(join(web, "src"))
  .filter((f) => /\.tsx?$/.test(f))
  .map(read)
  .join("\n");

/** Matrix endpoints of docs/06 section 8 (first column) that the app does not render yet. */
const NOT_BUILT = new Map<string, string>([
  ["/prediction", "Prediction tab waits for D07/B14 (F15-5); no response fields are mapped yet"],
]);

function matrixPaths(): string[] {
  const section = read(join(repo, "docs/06-frontend-spec.md"))
    .split("## 8.")[1]!
    .split("## 9.")[0]!;
  const out: string[] = [];
  for (const line of section.split("\n")) {
    if (!line.startsWith("| `")) continue;
    for (const m of (line.split("|")[1] ?? "").matchAll(/`([^`]+)`/g)) out.push(m[1]!);
  }
  return out;
}

/** A mapped id is real when it (or its static part) appears in the source; dynamic ids are matched by prefix or suffix. */
function idExists(id: string): boolean {
  const base = id.replace(/\*/g, "");
  if (allSrc.includes(base)) return true;
  const parts = base.split("-");
  const prefix = parts.slice(0, -1).join("-");
  const suffix = parts.slice(1).join("-");
  return (
    (prefix.length > 3 && allSrc.includes(prefix)) || (suffix.length > 3 && allSrc.includes(suffix))
  );
}

describe("UI-09 field coverage matrix", () => {
  it("every mapped field names an existing test id, or says why it is not rendered", () => {
    const bad: string[] = [];
    for (const [endpoint, fields] of Object.entries(fieldMap)) {
      for (const [field, target] of Object.entries(fields)) {
        const first = target.split("|")[0] ?? "";
        if (first.startsWith("not-rendered") || first.startsWith("conditional:")) {
          const why = target.split("|")[1] ?? "";
          if (why.trim().length < 10) bad.push(`${endpoint} ${field}: no reason given`);
          continue;
        }
        if (!idExists(first)) bad.push(`${endpoint} ${field} -> ${first}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("every endpoint of the docs/06 section 8 matrix has a mapping, or is listed as not built", () => {
    const keys = Object.keys(fieldMap).map((k) => k.split(" (")[0]!.replace(/^\w+ /, ""));
    const missing: string[] = [];
    for (const path of matrixPaths()) {
      if (NOT_BUILT.has(path)) continue;
      const stem = path.replace(/\*$/, "").replace(/\/$/, "");
      if (!keys.some((k) => k === stem || k.startsWith(`${stem}/`) || k.endsWith(stem))) {
        missing.push(path);
      }
    }
    expect(missing).toEqual([]);
  });

  it("every OpenAPI path the matrix covers exists in openapi.yaml (map and contract agree)", () => {
    const paths = [...read(join(repo, "openapi.yaml")).matchAll(/^ {2}"(\/[^"]*)":/gm)].map(
      (m) => m[1]!,
    );
    const unknown: string[] = [];
    for (const key of Object.keys(fieldMap)) {
      const path = key.split(" (")[0]!.replace(/^\w+ /, "");
      // The OpenAPI paths use {kind}/{code}; the field map names concrete or templated paths.
      const norm = (p: string) => p.replace(/\{[^}]+\}/g, "{}");
      if (!paths.map(norm).includes(norm(path))) {
        const generic = path.replace(/\/results$|\/shareholding$|\/actions$/, (m) => m);
        if (!paths.map(norm).includes(norm(generic))) unknown.push(key);
      }
    }
    expect(unknown).toEqual([]);
  });

  it("the admin status fields from docs/03 section 15 are all mapped", () => {
    const m = fieldMap["GET /admin/status"] ?? {};
    for (const f of [
      "sources",
      "jobs",
      "coverage",
      "db.size_mb",
      "db.tables",
      "db.warn_level",
      "holiday_list_missing_years",
      "version",
      "storage_policy",
    ]) {
      expect(m[f], f).toBeTruthy();
    }
  });
});

// ---- UI-08: long names truncate with a tooltip -----------------------------------------------

/** Tags whose short, fixed text cannot be long (navigation labels, brand). */
const TRUNCATE_EXEMPT = ["AppShell.tsx"];

describe("UI-08 truncated text keeps its full text as a tooltip", () => {
  it("every element with the truncate class also has a title (or sits in an exempt fixed label)", () => {
    const offenders: string[] = [];
    for (const f of srcFiles) {
      const text = read(f);
      for (const m of text.matchAll(/\btruncate\b/g)) {
        const start = text.lastIndexOf("<", m.index);
        let depth = 0;
        let end = start;
        for (let i = start; i < text.length; i++) {
          const ch = text[i];
          if (ch === "{") depth++;
          else if (ch === "}") depth--;
          else if (ch === ">" && depth === 0 && text[i - 1] !== "=") {
            end = i;
            break;
          }
        }
        const tag = text.slice(start, end);
        if (!/\btitle=/.test(tag) && !TRUNCATE_EXEMPT.some((e) => f.endsWith(e))) {
          offenders.push(`${f.replace(web, "")}: ${tag.slice(0, 60).replace(/\s+/g, " ")}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ---- SEC-11: no raw HTML injection in the UI -------------------------------------------------

describe("SEC-11 dynamic text is escaped", () => {
  it("dangerouslySetInnerHTML is used only for the generated theme stylesheet", () => {
    const users = srcFiles.filter((f) => /dangerouslySetInnerHTML|innerHTML\s*=/.test(read(f)));
    expect(users.map((f) => f.replace(/\\/g, "/").split("/src/")[1])).toEqual(["app/layout.tsx"]);
  });
});

// ---- PWA: manifest, icons, shell-only service worker ----------------------------------------

describe("PWA-01 manifest and icons", () => {
  const manifest = JSON.parse(read(join(web, "public/manifest.json"))) as {
    name: string;
    short_name: string;
    start_url: string;
    display: string;
    icons: Array<{ src: string; sizes: string; type: string; purpose: string }>;
  };
  it("is installable: name, standalone display, 192 and 512 icons plus a maskable one", () => {
    expect(manifest.name).toBeTruthy();
    expect(manifest.start_url).toBe("/");
    expect(manifest.display).toBe("standalone");
    const sizes = manifest.icons.map((i) => `${i.sizes}:${i.purpose}`);
    expect(sizes).toEqual(
      expect.arrayContaining(["192x192:any", "512x512:any", "512x512:maskable"]),
    );
  });
  it("every icon is a real PNG of the declared size", () => {
    for (const icon of manifest.icons) {
      const buf = readFileSync(join(web, "public", icon.src));
      expect(buf.subarray(1, 4).toString("ascii")).toBe("PNG");
      const [w] = icon.sizes.split("x").map(Number);
      expect(buf.readUInt32BE(16)).toBe(w);
      expect(buf.readUInt32BE(20)).toBe(w);
    }
  });
  it("the layout links the manifest and the PWA files are reachable before sign-in", () => {
    expect(read(join(web, "src/app/layout.tsx"))).toContain('manifest: "/manifest.json"');
    for (const p of ["/manifest.json", "/sw.js", "/offline.html", "/icons/icon-192.png"]) {
      expect(isPwaShellPath(p)).toBe(true);
      expect(isPublicPath(p)).toBe(true);
    }
    expect(isPwaShellPath("/portfolio")).toBe(false);
    expect(isPublicPath("/icons")).toBe(false);
    const matcher = read(join(web, "src/middleware.ts"));
    for (const f of ["manifest.json", "sw.js", "offline.html", "icons/"]) {
      expect(matcher).toContain(f);
    }
  });
  it("the offline fallback exists and carries the disclaimer", () => {
    expect(read(join(web, "public/offline.html"))).toContain("Not investment advice");
  });
});

interface FakeEvent {
  request: { method: string; url: string; mode: string };
  responded: Promise<unknown> | null;
  respondWith(p: Promise<unknown>): void;
  waitUntil(p: Promise<unknown>): void;
}

function loadWorker() {
  const handlers: Record<string, (e: unknown) => void> = {};
  const store = new Map<string, Map<string, unknown>>();
  const caches = {
    open: async (name: string) => {
      const c = store.get(name) ?? new Map<string, unknown>();
      store.set(name, c);
      return {
        addAll: async (urls: string[]) => urls.forEach((u) => c.set(u, `precached:${u}`)),
        put: async (req: { url: string }, res: unknown) =>
          void c.set(new URL(req.url).pathname, res),
      };
    },
    match: async (req: string | { url: string }) => {
      const key = typeof req === "string" ? req : new URL(req.url).pathname;
      for (const c of store.values()) if (c.has(key)) return c.get(key);
      return undefined;
    },
    keys: async () => [...store.keys()],
    delete: async (k: string) => store.delete(k),
  };
  const self = {
    location: { origin: "https://app.test" },
    addEventListener: (t: string, h: (e: unknown) => void) => void (handlers[t] = h),
    skipWaiting: () => undefined,
    clients: { claim: async () => undefined },
  };
  const fetchMock = vi.fn(async (req: { url: string }) => ({
    ok: true,
    url: req.url,
    clone() {
      return this;
    },
  }));
  runInNewContext(read(join(web, "public/sw.js")), {
    self,
    caches,
    fetch: fetchMock,
    URL,
    Promise,
    console,
  });
  const fire = (method: string, url: string, mode = "cors") => {
    const e: FakeEvent = {
      request: { method, url, mode },
      responded: null,
      respondWith(p) {
        this.responded = p;
      },
      waitUntil: () => undefined,
    };
    handlers["fetch"]!(e);
    return e;
  };
  return { handlers, store, fetchMock, fire };
}

describe("PWA-02 service worker caches the shell only", () => {
  it("precaches the offline page, manifest and icons on install", async () => {
    const w = loadWorker();
    let done: Promise<unknown> = Promise.resolve();
    w.handlers["install"]!({ waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;
    expect([...(w.store.get("shell-v1")?.keys() ?? [])].sort()).toEqual([
      "/icons/icon-192.png",
      "/icons/icon-512.png",
      "/manifest.json",
      "/offline.html",
    ]);
  });

  it("never intercepts API calls, non-GET requests or other origins", () => {
    const w = loadWorker();
    expect(w.fire("GET", "https://app.test/api/v1/portfolio/summary").responded).toBeNull();
    expect(w.fire("POST", "https://app.test/_next/static/a.js").responded).toBeNull();
    expect(w.fire("GET", "https://other.test/_next/static/a.js").responded).toBeNull();
    expect(w.fire("GET", "https://app.test/stocks/TCS.json").responded).toBeNull();
  });

  it("does not store HTML pages or API data, but caches hashed static files", async () => {
    const w = loadWorker();
    await w.fire("GET", "https://app.test/_next/static/chunk-1.js").responded;
    await w.fire("GET", "https://app.test/portfolio", "navigate").responded;
    const cache = w.store.get("shell-v1");
    expect([...(cache?.keys() ?? [])]).toEqual(["/_next/static/chunk-1.js"]);
  });

  it("a failed page navigation answers with the offline page", async () => {
    const w = loadWorker();
    let done: Promise<unknown> = Promise.resolve();
    w.handlers["install"]!({ waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;
    w.fetchMock.mockRejectedValueOnce(new Error("offline"));
    const r = await w.fire("GET", "https://app.test/portfolio", "navigate").responded;
    expect(r).toBe("precached:/offline.html");
  });

  it("the worker source has no API path in its cache rules and no external host", () => {
    const sw = read(join(web, "public/sw.js"));
    expect(sw).toContain('startsWith("/api/")');
    expect(sw).not.toMatch(/https?:\/\//);
  });
});

// ---- UI-06: offline ----------------------------------------------------------------------------

describe("UI-06 offline banner", () => {
  afterEach(() => vi.restoreAllMocks());

  it("is silent online, appears on the offline event and clears on the online event", () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    render(<OfflineBanner />);
    expect(screen.queryByTestId("offline-banner")).toBeNull();
    expect(screen.getByTestId("offline-region")).toHaveAttribute("aria-live", "polite");
    act(() => {
      vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
      window.dispatchEvent(new Event("offline"));
    });
    expect(screen.getByTestId("offline-banner")).toHaveTextContent(OFFLINE_MESSAGE);
    expect(OFFLINE_MESSAGE).toContain("out of date");
    act(() => {
      vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
      window.dispatchEvent(new Event("online"));
    });
    expect(screen.queryByTestId("offline-banner")).toBeNull();
  });

  it("is mounted in the app shell so every screen has it", () => {
    expect(read(join(web, "src/components/shell/AppShell.tsx"))).toContain("<OfflineBanner />");
  });
});
