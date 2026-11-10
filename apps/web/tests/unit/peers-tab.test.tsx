import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { profileSchema } from "@/lib/stock/schemas";
import * as fx from "../mocks/f10-fixtures";
import { createMockFetch, type Handler } from "../mocks/mock-fetch";
import { profileData } from "../mocks/stock-fixtures";
import "./dom-matchers";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: { href: string; children: ReactNode } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { PeersTab } from "@/components/stock/peers/PeersTab";

const profile = (() => {
  const p = profileSchema.parse(profileData);
  if ("redirect_symbol" in p) throw new Error("fixture");
  return p;
})();

function renderTab(routes: Record<string, Handler>) {
  const mock = createMockFetch(routes);
  vi.stubGlobal("fetch", mock.impl);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <PeersTab profile={profile} />
    </QueryClientProvider>,
  );
  return mock;
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe("Peers tab (PEER-01..03 on the web side, docs/06 6.4)", () => {
  it("shows sector, industry, basis, market cap band, the self row and percentile ranks", async () => {
    const mock = renderTab({ "GET /stocks/TCS/peers": fx.peers() });
    await screen.findByTestId("peers-table");
    expect(mock.calls[0]?.path).toBe("/stocks/TCS/peers");
    expect(screen.getByTestId("peers-sector")).toHaveTextContent(
      "Sector: Information Technology; industry: IT Services.",
    );
    expect(screen.getByTestId("peers-basis")).toHaveTextContent("same industry (IT Services)");
    expect(screen.getByTestId("peers-band")).toHaveTextContent("between 0.25 and 4 times");
    expect(screen.getByTestId("peers-origin-TCS")).toHaveTextContent("This stock");
    expect(screen.getByTestId("peers-origin-INFY")).toHaveTextContent("Chosen automatically");
    expect(screen.getByTestId("peers-cell-TCS-roe")).toHaveTextContent("18.50%");
    // percentile_rank is a percent number 0-100 (D05b-4)
    expect(screen.getByTestId("peers-rank-TCS-pe")).toHaveTextContent("Rank 30%");
    expect(screen.getByTestId("peers-rank-TCS-roe")).toHaveTextContent("Rank 80%");
    expect(screen.queryByTestId("peers-note")).toBeNull();
    expect(screen.getByTestId("peers-link-INFY")).toHaveAttribute("href", "/stocks/INFY?tab=peers");
  });

  it("a missing metric is a dash with its reason, never 0", async () => {
    renderTab({ "GET /stocks/TCS/peers": fx.peers() });
    const cell = await screen.findByTestId("peers-cell-WIPRO-pe");
    expect(cell.textContent).toMatch(/^—/);
    expect(cell.textContent).toMatch(/not available for this stock/);
    expect(screen.getByTestId("peers-cell-TCS-debt_equity").textContent).toMatch(/^—/);
    expect(screen.queryByTestId("peers-rank-TCS-debt_equity")).toBeNull();
  });

  it("explains a sector-wide pool, the few-peers note and stale peers", async () => {
    renderTab({
      "GET /stocks/TCS/peers": fx.peers({
        basis: "sector",
        note: "few comparable peers",
        stalePeer: true,
      }),
    });
    await screen.findByTestId("peers-table");
    expect(screen.getByTestId("peers-basis")).toHaveTextContent("widened");
    expect(screen.getByTestId("peers-note")).toHaveTextContent("Few comparable peers");
    expect(screen.getByTestId("peers-stale")).toBeTruthy();
    expect(screen.getByTestId("peers-row-INFY").getAttribute("data-stale")).toBe("true");
    expect(screen.getByTestId("peers-stamp-INFY")).toHaveTextContent("No owner data");
  });

  it("no_sector_data asks for the sector import; no_market_cap says so honestly", async () => {
    renderTab({
      "GET /stocks/TCS/peers": fx.err(404, "DATA_UNAVAILABLE", "No sector", {
        reason: "no_sector_data",
      }),
    });
    const box = await screen.findByTestId("peers-unavailable");
    expect(box.getAttribute("data-reason")).toBe("no_sector_data");
    expect(box).toHaveTextContent("Import sector data to see peers");
    expect(screen.getByTestId("peers-import-link")).toHaveAttribute("href", "/imports");
  });

  it("no_market_cap is shown with its reason and no peers", async () => {
    renderTab({
      "GET /stocks/TCS/peers": fx.err(404, "DATA_UNAVAILABLE", "No cap", {
        reason: "no_market_cap",
      }),
    });
    const box = await screen.findByTestId("peers-unavailable");
    expect(box.getAttribute("data-reason")).toBe("no_market_cap");
    expect(box).toHaveTextContent("no market cap is on file");
    expect(screen.queryByTestId("peers-table")).toBeNull();
  });

  it("a server error shows a message and Retry", async () => {
    renderTab({ "GET /stocks/TCS/peers": fx.err(500, "INTERNAL", "boom") });
    await waitFor(() =>
      expect(screen.getByTestId("peers-card")).toHaveTextContent("Peers could not be loaded"),
    );
    expect(screen.getByTestId("peers-card")).toHaveTextContent("Retry");
  });

  it("an added peer is sent as a temporary override and can be removed again", async () => {
    const user = userEvent.setup();
    const mock = renderTab({
      "GET /stocks/TCS/peers": (call) =>
        fx.peers({ added: call.query.get("add") ? ["HCLTECH"] : [] }),
    });
    await screen.findByTestId("peers-table");
    await user.type(screen.getByTestId("peers-add-symbol"), "hcltech");
    await user.click(screen.getByTestId("peers-add"));
    await screen.findByTestId("peers-row-HCLTECH");
    expect(mock.calls.at(-1)?.query.get("add")).toBe("HCLTECH");
    expect(screen.getByTestId("peers-origin-HCLTECH")).toHaveTextContent("Added by you");
    await user.click(screen.getByTestId("peers-remove-INFY"));
    await screen.findByTestId("peers-table");
    expect(mock.calls.at(-1)?.query.get("remove")).toBe("INFY");
    await user.click(screen.getByTestId("peers-reset"));
    await screen.findByTestId("peers-row-INFY");
    expect(screen.queryByTestId("peers-row-HCLTECH")).toBeNull();
  });

  it("refuses a bad symbol before any request", async () => {
    const user = userEvent.setup();
    const mock = renderTab({ "GET /stocks/TCS/peers": fx.peers() });
    await screen.findByTestId("peers-table");
    await user.type(screen.getByTestId("peers-add-symbol"), "a b");
    await user.click(screen.getByTestId("peers-add"));
    expect(screen.getByTestId("peers-add-error")).toHaveTextContent("Enter one symbol");
    expect(mock.calls).toHaveLength(1);
  });

  it("answers an old symbol with a link to the new one", async () => {
    renderTab({
      "GET /stocks/TCS/peers": {
        status: 200,
        body: { data: { redirect_symbol: "TCS2" }, meta: {}, warnings: [] },
      },
    });
    expect(await screen.findByTestId("peers-redirect")).toHaveTextContent("TCS2");
  });

  it("is accessible (axe)", async () => {
    renderTab({
      "GET /stocks/TCS/peers": fx.peers({ stalePeer: true, note: "few comparable peers" }),
    });
    await screen.findByTestId("peers-table");
    const res = await axe.run(document.body, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
      rules: { "color-contrast": { enabled: false } },
    });
    expect(res.violations.map((v) => v.id)).toEqual([]);
  });
});
