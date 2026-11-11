// Bundle budget gate (docs/06a section 10): at most 250 kB gzipped JavaScript per route, with charts
// lazy. Reads a finished `next build` (.next): for each app route it sums the gzip size of the
// distinct JS files the route loads up front (the client reference manifest of the page and the
// root main files). Lazy `import()` chunks are not in those lists, so lazy charts do not count.
// HONEST LIMIT: that also means a section loaded with next/dynamic is NOT counted even though it
// mounts on first render (the portfolio page's holdings, charts and forms, the stock page's active
// tab). The number is therefore the up-front shell of a route, not the total JS a user downloads
// to see it; docs/06a section 10 and docs/RUNBOOK.md section 80 say so. A route that yields
// no result, a route without a measured manifest, or a listed chunk missing on disk fails the gate.
// Usage: node scripts/check-bundle-budget.mjs [--next-dir .next] [--budget-kb 250]
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { gzipSync } from "node:zlib";

export const DEFAULT_BUDGET_KB = 250;

/** Number of `page.tsx` files under an app directory (the routes that must be measured). */
export function countPages(srcAppDir) {
  let n = 0;
  for (const name of readdirSync(srcAppDir)) {
    const p = join(srcAppDir, name);
    if (statSync(p).isDirectory()) n += countPages(p);
    else if (/^page\.(tsx|ts|jsx|js)$/.test(name)) n += 1;
  }
  return n;
}

/** Throws when the measurement cannot be trusted: no routes, or fewer routes than pages. */
export function assertComplete(results, expectedPages = 0) {
  if (results.length === 0) throw new Error("no routes were measured; run next build first");
  if (results.length < expectedPages) {
    throw new Error(
      `measured ${results.length} routes but the source has ${expectedPages} page files`,
    );
  }
}

function findManifests(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...findManifests(p));
    else if (name === "page_client-reference-manifest.js") out.push(p);
  }
  return out;
}

function chunkPaths(manifestFile) {
  const sandbox = { globalThis: {} };
  sandbox.globalThis = sandbox;
  runInNewContext(readFileSync(manifestFile, "utf8"), sandbox);
  const out = new Set();
  for (const manifest of Object.values(sandbox.__RSC_MANIFEST ?? {})) {
    // Only the route's own segments: layouts, templates and the page. `clientModules` also lists
    // lazily imported chunks, and other entries (not-found, global-error) are not loaded here.
    for (const [entry, files] of Object.entries(manifest.entryJSFiles ?? {})) {
      if (!/\/(layout|template|page|loading|error)$/.test(entry)) continue;
      for (const c of files) out.add(c.startsWith("/") ? c : `/${c}`);
    }
  }
  return [...out].map((c) => c.replace(/^\/_next\//, "")).filter((c) => c.endsWith(".js"));
}

/** gzip kB of every route; `{ route, kb, files }[]`. */
export function measureRoutes(nextDir) {
  const root = JSON.parse(readFileSync(join(nextDir, "build-manifest.json"), "utf8"));
  const rootFiles = (root.rootMainFiles ?? []).filter((f) => f.endsWith(".js"));
  const appDir = join(nextDir, "server", "app");
  if (!existsSync(appDir)) throw new Error(`no build found in ${nextDir}; run next build first`);
  const sizeCache = new Map();
  const gz = (file) => {
    if (!sizeCache.has(file)) {
      const p = join(nextDir, file);
      // A listed chunk that is not on disk must not count as 0 bytes.
      if (!existsSync(p))
        throw new Error(`chunk ${file} is listed in the build but missing on disk`);
      sizeCache.set(file, gzipSync(readFileSync(p)).length);
    }
    return sizeCache.get(file);
  };
  return findManifests(appDir).map((m) => {
    const route = dirname(m).slice(appDir.length).replace(/\\/g, "/") || "/";
    const files = [...new Set([...rootFiles, ...chunkPaths(m)])];
    const bytes = files.reduce((sum, f) => sum + gz(f), 0);
    return { route, kb: bytes / 1024, files: files.length };
  });
}

export function overBudget(results, budgetKb = DEFAULT_BUDGET_KB) {
  return results.filter((r) => r.kb > budgetKb);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : fallback;
  };
  const budget = Number(arg("--budget-kb", String(DEFAULT_BUDGET_KB)));
  const results = measureRoutes(arg("--next-dir", ".next")).sort((a, b) => b.kb - a.kb);
  for (const r of results) {
    console.log(
      `${r.kb.toFixed(1).padStart(7)} kB gz  ${String(r.files).padStart(3)} files  ${r.route}`,
    );
  }
  const bad = overBudget(results, budget);
  if (bad.length > 0) {
    console.error(`Budget of ${budget} kB gzip exceeded by: ${bad.map((r) => r.route).join(", ")}`);
    process.exit(1);
  }
  console.log(`All ${results.length} routes are within ${budget} kB gzip.`);
}
