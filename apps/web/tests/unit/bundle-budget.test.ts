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

describe("PERF-02 Lighthouse thresholds (mobile performance >= 90, accessibility >= 95)", () => {
  const load = async () => {
    const spec = pathToFileURL(join(process.cwd(), "scripts/lighthouse-gate.mjs")).href;
    return (await import(/* @vite-ignore */ spec)) as {
      MIN_PERFORMANCE: number;
      MIN_ACCESSIBILITY: number;
      checkReport(report: unknown, label?: string): string[];
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
});
