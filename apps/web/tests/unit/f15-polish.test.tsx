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
const NOT_BUILT = new Map<string, string>();

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

/**
 * Every test id the source really declares: a string literal (static id) or a template literal
 * (`row-${x}` becomes the pattern `^row-.+$`) after `data-testid`, `testId` or a `...TestId` key.
 */
const TESTID_RE =
  /(?:data-testid|[A-Za-z]*[tT]estId)\s*[=:]\s*\{?\s*(?:"([^"\n]+)"|'([^'\n]+)'|`([^`]*)`)/g;
const realStatic = new Set<string>();
/** A declared template id. `leading` ones start with a hole (`${testId}-title`): the hole is a prop. */
const realPatterns: Array<{ re: RegExp; leading: boolean }> = [];
const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
for (const m of allSrc.matchAll(TESTID_RE)) {
  const tpl = m[3];
  if (tpl !== undefined && tpl.includes("${")) {
    const parts = tpl.split(/\$\{[^}]*\}/).map(escapeRe);
    // `${testId}-title`: the first hole is a prop; it only counts with a real static tail (>= 3 letters).
    const leading = parts[0] === "" && /[A-Za-z]{3}/.test(parts[1] ?? "");
    if (parts[0] === "" && !leading) continue; // `${a}-${b}`: could be any id, so it proves nothing
    const body = parts.reduce(
      (acc, part, i) => (i === 0 ? part : `${acc}${i === 1 && leading ? "(.+)" : ".+"}${part}`),
      "",
    );
    realPatterns.push({ re: new RegExp(`^${body}$`), leading });
  } else {
    realStatic.add(m[1] ?? m[2] ?? tpl ?? "");
  }
}

/** `testPrefix="fnd-period"` props: components that append `-${key}` to a declared prefix. */
const realPrefixes = [...allSrc.matchAll(/testPrefix="([^"]+)"/g)].map((m) => m[1]!);

/** True when a declared template produces exactly `id`. A leading hole must be a declared static id. */
function templateMakes(id: string): boolean {
  if (realPrefixes.some((p) => id.startsWith(`${p}-`) && id.length > p.length + 1)) return true;
  return realPatterns.some(({ re, leading }) => {
    const hit = re.exec(id);
    return hit !== null && (!leading || realStatic.has(hit[1] ?? ""));
  });
}

/**
 * A mapped id (`admin-jobs`, or `badge-*` for a family) is real only on a FULL match: the id itself
 * is a declared static id or is produced by a declared template; a `*` family matches a static id
 * of that shape or a template that produces ids of that shape. No prefix or suffix guessing
 * (F15R-B1).
 */
function idExists(id: string): boolean {
  if (!id.includes("*")) return realStatic.has(id) || templateMakes(id);
  const family = new RegExp(`^${id.split("*").map(escapeRe).join(".+")}$`);
  return (
    [...realStatic].some((r) => family.test(r)) ||
    templateMakes(id.replace(/\*/g, "X")) ||
    templateMakes(id.replace(/\*/g, "X-X"))
  );
}

describe("UI-09 field coverage matrix", () => {
  it("matches whole ids only: a prefix, a suffix or a typo is not enough (F15R-B1)", () => {
    expect(idExists("admin-jobs-table")).toBe(true);
    expect(idExists("admin-job")).toBe(false); // prefix of a real id
    expect(idExists("jobs-table")).toBe(false); // suffix of a real id
    expect(idExists("admin-jobs-tabel")).toBe(false);
    expect(idExists("admin-source-mfapi")).toBe(true); // produced by a template
    expect(idExists("admin-source-*")).toBe(true);
    expect(idExists("admin-nothing-*")).toBe(false);
  });

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
      if (!paths.map(norm).includes(norm(path))) unknown.push(key);
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
    for (const f of ["manifest\\\\.json", "sw\\\\.js", "offline\\\\.html", "icons"]) {
      expect(matcher).toContain(f);
    }
    expect(matcher).not.toContain("webmanifest");
    expect(isPwaShellPath("/manifest.webmanifest")).toBe(false);
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

function loadWorker(search = "") {
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
    location: { origin: "https://app.test", search },
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
    URLSearchParams,
    Response,
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
  it("precaches the offline page and the icons (not the manifest) on install", async () => {
    const w = loadWorker("?v=abc123");
    let done: Promise<unknown> = Promise.resolve();
    w.handlers["install"]!({ waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;
    expect([...(w.store.get("shell-abc123")?.keys() ?? [])].sort()).toEqual([
      "/icons/icon-192.png",
      "/icons/icon-512.png",
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
    const cache = w.store.get("shell-dev");
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

  it("activate keeps only the cache of the current build (old builds are pruned)", async () => {
    const w = loadWorker("?v=new2");
    w.store.set("shell-old1", new Map([["/_next/static/old.js", "x"]]));
    w.store.set("shell-new2", new Map());
    let done: Promise<unknown> = Promise.resolve();
    w.handlers["activate"]!({ waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;
    expect([...w.store.keys()]).toEqual(["shell-new2"]);
  });

  it("a build id with odd characters cannot break the cache name", () => {
    const w = loadWorker("?v=../x y");
    let done: Promise<unknown> = Promise.resolve();
    w.handlers["install"]!({ waitUntil: (p: Promise<unknown>) => (done = p) });
    return done.then(() => expect([...w.store.keys()]).toEqual(["shell-..x" + "y"]));
  });

  it("an offline navigation with no cached offline page still answers with a plain Response", async () => {
    const w = loadWorker();
    w.fetchMock.mockRejectedValueOnce(new Error("offline"));
    const r = (await w.fire("GET", "https://app.test/portfolio", "navigate").responded) as Response;
    expect(r.status).toBe(503);
    expect(await r.text()).toContain("offline");
  });

  it("the page registers the worker with the build id", () => {
    expect(read(join(web, "src/components/shell/PwaRegister.tsx"))).toContain("/sw.js?v=");
    expect(read(join(web, "next.config.ts"))).toContain("NEXT_PUBLIC_BUILD_ID");
  });

  it("/sw.js is served with a strict CSP (F15R-S10)", () => {
    const cfg = read(join(web, "next.config.ts"));
    expect(cfg).toContain("default-src 'none'; connect-src 'self'");
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
