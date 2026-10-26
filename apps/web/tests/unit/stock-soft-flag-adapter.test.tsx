// F05R-2: the soft flag source is isolated behind lib/stock/soft-flag-adapter.ts (D-W decision 3).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StockBanners } from "@/components/stock/StockBanners";
import { profileDataSchema } from "@/lib/stock/schemas";
import * as fx from "../mocks/stock-fixtures";
import "./dom-matchers";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/stock/soft-flag-adapter", async (orig) => ({
  ...(await orig<typeof import("@/lib/stock/soft-flag-adapter")>()),
  getSoftFlags: () => [{ date: "2026-09-01", dropPct: -33.3 }],
}));

afterEach(cleanup);

describe("soft flag adapter", () => {
  it("the banner renders from the adapter's list, not from the bars", () => {
    const profile = profileDataSchema.parse(fx.profileData);
    // Steadily rising bars: derive.ts would raise nothing, so the notice can only come from the stub.
    render(
      <StockBanners
        profile={profile}
        warnings={[]}
        bars={fx.bars(70)}
        confirmedMarkers={[]}
        eventActions={null}
      />,
    );
    const flag = screen.getByTestId("soft-flag-banner");
    expect(flag).toHaveTextContent("1 Sep 2026");
    expect(flag).toHaveTextContent("33.3%");
  });

  it("StockBanners and StockPage do not import the browser derivation directly", () => {
    for (const f of ["StockBanners.tsx", "StockPage.tsx"]) {
      const src = readFileSync(join(process.cwd(), "src/components/stock", f), "utf8");
      expect(src, f).not.toMatch(/\b(softFlags|coveredDates)\b/);
    }
  });
});
