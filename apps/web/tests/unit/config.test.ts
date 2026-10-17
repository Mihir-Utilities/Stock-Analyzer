import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { resolve } from "node:path";
const root = process.cwd();
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

// CLAUDE.md section 3: TypeScript strict, no `any`.
describe("project configuration", () => {
  it("keeps tsconfig strict", () => {
    const tsconfig = JSON.parse(read("tsconfig.json")) as {
      compilerOptions: Record<string, unknown>;
    };
    expect(tsconfig.compilerOptions.strict).toBe(true);
    expect(tsconfig.compilerOptions.noUncheckedIndexedAccess).toBe(true);
  });

  it("disables image optimisation so sharp never runs (D-OQ8)", () => {
    expect(read("next.config.ts")).toMatch(/images:\s*\{\s*unoptimized:\s*true\s*\}/);
  });

  it("rewrites /api/:path* to API_BASE_URL (docs/06 section 1)", () => {
    const cfg = read("next.config.ts");
    expect(cfg).toContain("process.env.API_BASE_URL");
    expect(cfg).toContain('source: "/api/:path*"');
  });
});
