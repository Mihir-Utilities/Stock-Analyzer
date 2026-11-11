// Bundle budget gate (docs/06a section 10): at most 250 kB gzipped JavaScript per route, with charts
// lazy. Reads a finished `next build` (.next): for each app route it sums the gzip size of the
// distinct JS files the route loads up front (the client reference manifest of the page and the
// root main files). Lazy `import()` chunks are not in those lists, so lazy charts do not count.
// Usage: node scripts/check-bundle-budget.mjs [--next-dir .next] [--budget-kb 250]
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { gzipSync } from "node:zlib";

export const DEFAULT_BUDGET_KB = 250;

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
      sizeCache.set(file, existsSync(p) ? gzipSync(readFileSync(p)).length : 0);
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
