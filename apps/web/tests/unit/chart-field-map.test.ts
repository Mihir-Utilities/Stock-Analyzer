import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("UI-09 field map for the chart endpoints", () => {
  it("every /prices field and the indicators series/analysis map to a test id that exists", () => {
    const map = JSON.parse(
      readFileSync(join(process.cwd(), "../../docs/field-map.json"), "utf8"),
    ) as Record<string, Record<string, string>>;
    const src = [
      "src/components/stock/chart/ChartTab.tsx",
      "src/components/stock/chart/AnalysisTab.tsx",
      "src/components/charts/ChartFrame.tsx",
    ]
      .map((f) => readFileSync(join(process.cwd(), f), "utf8"))
      .join("\n");
    const prices = map["GET /stocks/{symbol}/prices"] ?? {};
    for (const f of ["bars", "adjusted", "actions", "range", "limited_history", "depth"]) {
      const id = prices[f];
      expect(id, `prices field ${f} is not in docs/field-map.json`).toBeTruthy();
      expect(src.includes((id as string).replace(/-\*$/, "")), `${f} -> ${id}`).toBe(true);
    }
    const ind = map["GET /stocks/{symbol}/indicators"] ?? {};
    for (const f of ["series", "analysis"]) {
      expect(src.includes(ind[f] as string), `${f} -> ${ind[f]}`).toBe(true);
    }
  });
});
