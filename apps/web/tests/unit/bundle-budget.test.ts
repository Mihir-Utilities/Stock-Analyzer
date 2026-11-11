import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

interface Budget {
  DEFAULT_BUDGET_KB: number;
  measureRoutes(dir: string): Array<{ route: string; kb: number; files: number }>;
  countPages(dir: string): number;
  assertComplete(r: Array<{ route: string }>, expectedPages?: number): void;
  overBudget(
    r: Array<{ route: string; kb: number; files: number }>,
    kb?: number,
  ): Array<{ route: string }>;
}

async function loadBudget(): Promise<Budget> {
  // A variable specifier keeps TypeScript from resolving the .mjs file (it has no declarations).
  const spec = pathToFileURL(join(process.cwd(), "scripts/check-bundle-budget.mjs")).href;
  return (await import(/* @vite-ignore */ spec)) as Budget;
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A tiny fake `.next`: one root chunk, one route chunk, one lazy chunk that must not count. */
function fakeBuild(routeBytes: number): string {
  const dir = mkdtempSync(join(tmpdir(), "bundle-"));
  dirs.push(dir);
  mkdirSync(join(dir, "static/chunks"), { recursive: true });
  mkdirSync(join(dir, "server/app/(app)/demo"), { recursive: true });
  // Random bytes do not compress, so the gzip size is close to the byte count.
  const noise = (n: number) => randomBytes(n);
  writeFileSync(join(dir, "static/chunks/root.js"), noise(10_000));
  writeFileSync(join(dir, "static/chunks/page.js"), noise(routeBytes));
  writeFileSync(join(dir, "static/chunks/lazy-echarts.js"), noise(500_000));
  writeFileSync(
    join(dir, "build-manifest.json"),
    JSON.stringify({ rootMainFiles: ["static/chunks/root.js"] }),
  );
  const manifest = {
    clientModules: { m: { chunks: ["/_next/static/chunks/lazy-echarts.js"] } },
    entryJSFiles: {
      "[project]/src/app/(app)/demo/page": ["static/chunks/page.js"],
      "[project]/src/app/not-found": ["static/chunks/lazy-echarts.js"],
    },
  };
  writeFileSync(
    join(dir, "server/app/(app)/demo/page_client-reference-manifest.js"),
    `globalThis.__RSC_MANIFEST = globalThis.__RSC_MANIFEST || {};\nglobalThis.__RSC_MANIFEST["/(app)/demo/page"] = ${JSON.stringify(manifest)};`,
  );
  return dir;
}

describe("PERF-01 bundle budget gate (250 kB gzip per route, docs/06a section 10)", () => {
  it("sums root and route chunks by gzip size and ignores lazy and unrelated chunks", async () => {
    const b = await loadBudget();
    const dir = fakeBuild(20_000);
    const [r] = b.measureRoutes(dir);
    const expected =
      (gzipSync(readFileSync(join(dir, "static/chunks/root.js"))).length +
        gzipSync(readFileSync(join(dir, "static/chunks/page.js"))).length) /
      1024;
    expect(r?.route).toBe("/(app)/demo");
    expect(r?.files).toBe(2);
    expect(r?.kb).toBeCloseTo(expected, 5);
    expect(b.overBudget([r!])).toEqual([]);
  });

  it("flags a route over the budget and defaults to 250 kB", async () => {
    const b = await loadBudget();
    expect(b.DEFAULT_BUDGET_KB).toBe(250);
    const dir = fakeBuild(300_000);
    const results = b.measureRoutes(dir);
    expect(b.overBudget(results).map((r) => r.route)).toEqual(["/(app)/demo"]);
    expect(b.overBudget(results, 400)).toEqual([]);
  });

  it("fails clearly when there is no build", async () => {
    const b = await loadBudget();
    const dir = mkdtempSync(join(tmpdir(), "bundle-"));
    dirs.push(dir);
    writeFileSync(join(dir, "build-manifest.json"), "{}");
    expect(() => b.measureRoutes(dir)).toThrow(/run next build/);
  });
});

describe("PERF-01b the gate cannot pass on an empty or partial measurement (F15R-S5)", () => {
  it("zero measured routes is an error, not a pass", async () => {
    const b = await loadBudget();
    const dir = mkdtempSync(join(tmpdir(), "bundle-"));
    dirs.push(dir);
    mkdirSync(join(dir, "server/app"), { recursive: true });
    writeFileSync(join(dir, "build-manifest.json"), "{}");
    expect(b.measureRoutes(dir)).toEqual([]);
    expect(() => b.assertComplete([])).toThrow(/no routes were measured/);
  });

  it("fewer measured routes than app/**/page.tsx files is an error", async () => {
    const b = await loadBudget();
    const dir = fakeBuild(20_000);
    const src = mkdtempSync(join(tmpdir(), "src-app-"));
    dirs.push(src);
    for (const p of ["page.tsx", "a/page.tsx", "a/b/page.tsx", "a/layout.tsx"]) {
      mkdirSync(join(src, p, ".."), { recursive: true });
      writeFileSync(join(src, p), "export default null;");
    }
    expect(b.countPages(src)).toBe(3);
    const results = b.measureRoutes(dir);
    expect(() => b.assertComplete(results, 3)).toThrow(/measured 1 routes but the source has 3/);
    expect(() => b.assertComplete(results, 1)).not.toThrow();
  });

  it("a chunk listed in the manifest but missing on disk is an error, not 0 bytes", async () => {
    const b = await loadBudget();
    const dir = fakeBuild(20_000);
    rmSync(join(dir, "static/chunks/page.js"));
    expect(() => b.measureRoutes(dir)).toThrow(/missing on disk/);
  });
});

describe("PERF-02 Lighthouse thresholds (mobile performance >= 90, accessibility >= 95)", () => {
  const load = async () => {
    const spec = pathToFileURL(join(process.cwd(), "scripts/lighthouse-gate.mjs")).href;
    return (await import(/* @vite-ignore */ spec)) as {
      MIN_PERFORMANCE: number;
      MIN_ACCESSIBILITY: number;
      checkReport(report: unknown, label?: string): string[];
      median(v: Array<number | null | undefined>): number | null;
      medianReport(r: unknown[]): unknown;
    };
  };
  const report = (performance: number | null, accessibility: number | null) => ({
    categories: { performance: { score: performance }, accessibility: { score: accessibility } },
  });

  it("passes at exactly the thresholds and fails just below them", async () => {
    const lh = await load();
    expect([lh.MIN_PERFORMANCE, lh.MIN_ACCESSIBILITY]).toEqual([0.9, 0.95]);
    expect(lh.checkReport(report(0.9, 0.95), "/login")).toEqual([]);
    expect(lh.checkReport(report(0.89, 1), "/login")).toEqual(["/login: performance 0.89 < 0.9"]);
    expect(lh.checkReport(report(1, 0.94), "/login")).toEqual([
      "/login: accessibility 0.94 < 0.95",
    ]);
  });

  it("a missing score is a failure, never a pass", async () => {
    const lh = await load();
    expect(lh.checkReport(report(null, null), "/x")).toHaveLength(2);
    expect(lh.checkReport({}, "/x")).toHaveLength(2);
  });

  it("uses the median of three runs: one noisy run neither fails nor rescues the gate", async () => {
    const lh = await load();
    expect(lh.median([0.95, 0.5, 0.92])).toBe(0.92);
    expect(lh.median([0.5, 0.6, 0.95])).toBe(0.6);
    expect(lh.median([0.9, null, 0.95])).toBeNull();
    expect(lh.median([])).toBeNull();
    const noisy = [report(0.97, 1), report(0.6, 1), report(0.95, 1)];
    expect(lh.checkReport(lh.medianReport(noisy), "/login")).toEqual([]);
    const bad = [report(0.6, 1), report(0.7, 1), report(0.95, 1)];
    expect(lh.checkReport(lh.medianReport(bad), "/login")).toEqual([
      "/login: performance 0.7 < 0.9",
    ]);
    const missing = [report(null, 1), report(1, 1), report(1, 1)];
    expect(lh.checkReport(lh.medianReport(missing), "/x")).toHaveLength(1);
  });
});
