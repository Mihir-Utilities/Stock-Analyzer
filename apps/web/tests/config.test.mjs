import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// CLAUDE.md section 3: TypeScript strict. Guards the config until F01 adds the real test stack.
test("tsconfig keeps strict mode on", () => {
  const tsconfig = JSON.parse(readFileSync(new URL("../tsconfig.json", import.meta.url), "utf8"));
  assert.equal(tsconfig.compilerOptions.strict, true);
  assert.equal(tsconfig.compilerOptions.noUncheckedIndexedAccess, true);
});
