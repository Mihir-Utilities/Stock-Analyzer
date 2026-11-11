import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StockPage } from "@/components/stock/StockPage";
import { createMockFetch } from "../mocks/mock-fetch";
import * as f8 from "../mocks/f08-fixtures";
import * as pf from "../mocks/pred-fixtures";
import * as fx from "../mocks/stock-fixtures";
import "./dom-matchers";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams("tab=prediction"),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
// The lazy chunk never arrives: the module factory does not resolve.
vi.mock("@/components/stock/prediction/PredictionTab", () => new Promise(() => undefined));
vi.setConfig({ testTimeout: 30000 });

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe("PREDX-11 the lazy chunk's loading state is never without the banner and disclaimer", () => {
  it("renders the experimental banner and the default disclaimer while the chunk is held back", async () => {
    const mock = createMockFetch({
      "GET /watchlist": fx.emptyWatchlist,
      "GET /stocks/TCS": fx.profile(),
      "GET /stocks/TCS/events": fx.events,
      "GET /stocks/TCS/links": fx.links,
      "GET /stocks/TCS/fundamentals": fx.fundamentalsNotComputed,
      "GET /stocks/TCS/prices": fx.prices(),
      "GET /stocks/TCS/indicators": fx.indicators(),
      "GET /settings/prices-adjustment": f8.adjustment(false),
      "GET /stocks/TCS/prediction": pf.okState,
    });
    vi.stubGlobal("fetch", mock.impl);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <StockPage symbol="TCS" />
      </QueryClientProvider>,
    );
    const chunk = await screen.findByTestId("pred-chunk-loading", undefined, { timeout: 15000 });
    expect(chunk.querySelector("[data-testid=experimental-banner]")).not.toBeNull();
    expect(chunk.querySelector("[data-testid=pred-disclaimer]")?.textContent).toBe(pf.DISCLAIMER);
    expect(screen.queryByTestId("pred-card")).toBeNull();
  });
});
