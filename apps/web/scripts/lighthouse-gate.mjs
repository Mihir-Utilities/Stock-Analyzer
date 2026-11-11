// Lighthouse gate (docs/06a section 10): mobile performance >= 90 and accessibility >= 95.
// Usage: node scripts/lighthouse-gate.mjs <base-url> [path ...]   (default path: /login)
//
// Only pages that render without the API can be audited here: the e2e server has no API behind it
// and every route except /login redirects to it without a session (F15-7). The other main routes
// are covered by axe in Playwright (tests/e2e/shell.spec.ts, tests/e2e/f15.spec.ts) and the
// bundle budget (scripts/check-bundle-budget.mjs). Needs Chrome: set CHROME_PATH or use the runner's.
// Lighthouse is a pinned devDependency (package.json and lockfile). Each page is audited RUNS times
// and the median of every score is checked, so one noisy run on a shared CI runner does not fail it.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MIN_PERFORMANCE = 0.9;
export const MIN_ACCESSIBILITY = 0.95;
export const RUNS = 3;

/** Median of the numbers; null when any value is missing (a missing score is never a pass). */
export function median(values) {
  if (values.length === 0 || values.some((v) => typeof v !== "number")) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** One report shaped like Lighthouse's, carrying the median score of each category. */
export function medianReport(reports) {
  const score = (cat) => median(reports.map((r) => r.categories?.[cat]?.score));
  return {
    categories: {
      performance: { score: score("performance") },
      accessibility: { score: score("accessibility") },
    },
  };
}

/** Pure check of one Lighthouse JSON report; returns the failures as sentences. */
export function checkReport(report, label = report.finalDisplayedUrl ?? "page") {
  const failures = [];
  const perf = report.categories?.performance?.score;
  const a11y = report.categories?.accessibility?.score;
  if (typeof perf !== "number") failures.push(`${label}: no performance score`);
  else if (perf < MIN_PERFORMANCE)
    failures.push(`${label}: performance ${perf} < ${MIN_PERFORMANCE}`);
  if (typeof a11y !== "number") failures.push(`${label}: no accessibility score`);
  else if (a11y < MIN_ACCESSIBILITY)
    failures.push(`${label}: accessibility ${a11y} < ${MIN_ACCESSIBILITY}`);
  return failures;
}

function audit(url) {
  const dir = mkdtempSync(join(tmpdir(), "lh-"));
  const out = join(dir, "report.json");
  const r = spawnSync(
    "npx",
    [
      "--no-install",
      "lighthouse",
      url,
      "--only-categories=performance,accessibility",
      "--form-factor=mobile",
      "--output=json",
      `--output-path=${out}`,
      '--chrome-flags="--headless=new --no-sandbox"',
      "--quiet",
    ],
    { stdio: "inherit", shell: true },
  );
  if (r.status !== 0) throw new Error(`lighthouse exited with ${r.status} for ${url}`);
  return JSON.parse(readFileSync(out, "utf8"));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [base, ...paths] = process.argv.slice(2);
  if (!base) {
    console.error("usage: node scripts/lighthouse-gate.mjs <base-url> [path ...]");
    process.exit(2);
  }
  const failures = [];
  for (const p of paths.length ? paths : ["/login"]) {
    const url = new URL(p, base).href;
    const report = medianReport(Array.from({ length: RUNS }, () => audit(url)));
    const perf = report.categories.performance.score;
    const a11y = report.categories.accessibility.score;
    console.log(`${p}: median of ${RUNS} runs: performance ${perf}, accessibility ${a11y}`);
    failures.push(...checkReport(report, p));
  }
  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exit(1);
  }
}
