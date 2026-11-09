import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { moreNav, primaryNav } from "@/components/shell/nav";

// A nav entry must never 404 again (F10p-1): every href resolves to an app/(app) page.tsx.
const appDir = join(process.cwd(), "src/app/(app)");

function pageRoutes(dir: string, prefix: string[] = []): string[][] {
  const out: string[][] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      const seg = /^\(.*\)$/.test(name) ? [] : [name];
      out.push(...pageRoutes(full, [...prefix, ...seg]));
    } else if (name === "page.tsx") {
      out.push(prefix);
    }
  }
  return out;
}

function matches(route: string[], href: string[]): boolean {
  if (route.length !== href.length) return false;
  return route.every((seg, i) => /^\[.+\]$/.test(seg) || seg === href[i]);
}

describe("nav hrefs resolve to a route file (UI-94)", () => {
  const routes = pageRoutes(appDir);
  const hrefs = [...primaryNav, ...moreNav].map((n) => n.href);

  it("finds the home route and the nav entries", () => {
    expect(routes.some((r) => r.length === 0)).toBe(true);
    expect(hrefs.length).toBeGreaterThanOrEqual(11);
  });

  it.each(hrefs)("%s has a page.tsx", (href) => {
    const segs = href.split("/").filter(Boolean);
    expect(routes.some((r) => matches(r, segs))).toBe(true);
  });
});
