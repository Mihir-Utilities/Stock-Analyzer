import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { profileSchema } from "@/lib/stock/schemas";
import * as fx from "../mocks/f10-fixtures";
import { createMockFetch, type Handler } from "../mocks/mock-fetch";
import { profileData } from "../mocks/stock-fixtures";
import "./dom-matchers";

// F10 review fixes (F10R-1..F10R-9). Fixed fixtures only: no wall clock, no randomness.

let search = "";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(search),
}));
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
const download = vi.fn();
vi.mock("@/components/ui/csv", async (orig) => ({
  ...(await orig<typeof import("@/components/ui/csv")>()),
  downloadCsv: (csv: string, name: string) => download(csv, name),
}));

import { ComparePage } from "@/components/compare/ComparePage";
import { ScreenerPage } from "@/components/screener/ScreenerPage";
import { PeersTab } from "@/components/stock/peers/PeersTab";

const wrap = (client: QueryClient, ui: ReactNode) => (
  <QueryClientProvider client={client}>{ui}</QueryClientProvider>
);
const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

function renderScreener(routes: Record<string, Handler> = {}) {
  const mock = createMockFetch({ "GET /screener/saved": fx.saved(), ...routes });
  vi.stubGlobal("fetch", mock.impl);
  render(wrap(newClient(), <ScreenerPage />));
  return mock;
}

const queries = (m: ReturnType<typeof createMockFetch>) =>
  m.calls.filter((c) => c.method === "POST" && c.path === "/screener/query");

async function addFilter(user: ReturnType<typeof userEvent.setup>, value: string, n = 1) {
  await user.click(screen.getByTestId("screener-add-filter"));
  const input = await screen.findAllByLabelText(/^Filter \d+ value/);
  await user.type(input[n - 1] as HTMLElement, value);
}

beforeEach(() => {
  search = "";
  download.mockReset();
  vi.unstubAllGlobals();
});
afterEach(() => vi.unstubAllGlobals());

describe("screener review fixes", () => {
  it("F10R-1: a server 422 on a filter value is shown at that filter and clears on edit", async () => {
    const user = userEvent.setup();
    renderScreener({
      "POST /screener/query": fx.err(422, "UNPROCESSABLE", "Validation failed", {
        fields: [{ field: "filters[1].value", message: "must be a finite number within +/-1e15" }],
      }),
    });
    await addFilter(user, "5");
    await addFilter(user, "6", 2);
    await user.click(screen.getByTestId("screener-run"));
    const inline = await screen.findAllByTestId(/^screener-filter-error-/);
    expect(inline).toHaveLength(1);
    expect(inline[0]).toHaveTextContent("value must be a finite number");
    expect(screen.getByLabelText(/^Filter 2 value/)).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText(/^Filter 1 value/)).toHaveAttribute("aria-invalid", "false");
    await user.type(screen.getByLabelText(/^Filter 2 value/), "7");
    expect(screen.queryByTestId(/^screener-filter-error-/)).toBeNull();
  });

  it("F10R-2: a 4xx on a later page says to run again; a new screen never reuses the old cursor", async () => {
    const user = userEvent.setup();
    const mock = renderScreener({
      "POST /screener/query": (call) => {
        const b = call.body as { cursor: string | null; filters: unknown[] };
        if (b.cursor === "c1") return fx.err(422, "UNPROCESSABLE", "cursor does not match");
        return b.filters.length === 0
          ? fx.screener([fx.item("AAA")], { next: "c1", total: 2 })
          : fx.screener([fx.item("ZZZ")], { total: 1 });
      },
    });
    await user.click(screen.getByTestId("screener-run"));
    await screen.findByTestId("screener-row-AAA");
    await user.click(screen.getByTestId("screener-more"));
    expect(await screen.findByTestId("screener-more-error")).toHaveTextContent(
      "press Run screen to start the screen again",
    );
    await addFilter(user, "10");
    await user.click(screen.getByTestId("screener-run"));
    await screen.findByTestId("screener-row-ZZZ");
    expect(screen.queryByTestId("screener-row-AAA")).toBeNull();
    const cursors = queries(mock).map((c) => (c.body as { cursor: string | null }).cursor);
    expect(cursors).toEqual([null, "c1", null]);
  });

  it("F10R-3: loading a saved screen names a dropped sort and column, not only filters", async () => {
    const user = userEvent.setup();
    renderScreener({
      "GET /screener/saved": {
        status: 200,
        body: {
          data: {
            items: [
              {
                name: "Old",
                spec: {
                  filters: [{ metric: "roe", op: ">", value: 10 }],
                  sort: { metric: "gone_metric", dir: "desc" },
                  columns: ["pe", "gone_column"],
                  universe: { kind: "equity" },
                },
                saved_at: "2026-11-01T05:00:00Z",
              },
            ],
            max_saved: 30,
            presets: [],
          },
          meta: {},
          warnings: [],
        },
      },
    });
    await user.click(await screen.findByTestId("screener-load-Old"));
    const note = screen.getByTestId("screener-load-note");
    expect(note).toHaveTextContent("sort on gone metric");
    expect(note).toHaveTextContent("column gone column");
    expect((screen.getByLabelText(/^Filter 1 value/) as HTMLInputElement).value).toBe("10");
  });

  it("F10R-4: after a delete the keyboard focus moves into the saved screens card", async () => {
    const user = userEvent.setup();
    let names = ["Keep me"];
    renderScreener({
      "GET /screener/saved": () => fx.saved(names),
      "DELETE /screener/saved/Keep%20me": () => {
        names = [];
        return { status: 200, body: { data: { ok: true }, meta: {}, warnings: [] } };
      },
    });
    await user.click(await screen.findByTestId("screener-delete-Keep me"));
    await user.click(within(screen.getByTestId("confirm-dialog")).getByTestId("confirm-ok"));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId("screener-saved-heading")),
    );
  });

  it("F10R-5: the CSV guard covers TAB, CR, + - @ in names; a comma or quote is quoted", async () => {
    const user = userEvent.setup();
    renderScreener({
      "POST /screener/query": fx.screener([
        fx.item("T1", { name: "\tTab" }),
        fx.item("T2", { name: "\rCR" }),
        fx.item("T3", { name: "+plus" }),
        fx.item("T4", { name: "-minus" }),
        fx.item("T5", { name: "@at" }),
        fx.item("T6", { name: 'Ltd, "Q"' }),
      ]),
    });
    await user.click(screen.getByTestId("screener-run"));
    await screen.findByTestId("screener-row-T1");
    await user.click(screen.getByTestId("screener-export"));
    const csv = download.mock.calls[0]?.[0] as string;
    expect(csv).toContain("T1,'\tTab,");
    expect(csv).toContain('T2,"\'\rCR",');
    expect(csv).toContain("T3,'+plus,");
    expect(csv).toContain("T4,'-minus,");
    expect(csv).toContain("T5,'@at,");
    expect(csv).toContain('T6,"Ltd, ""Q""",');
  });
});

describe("compare review fixes", () => {
  it("F10R-6: an alias plus its current symbol (422 on symbols) shows the server's message", async () => {
    search = "symbols=OLD,NEW&range=1Y";
    vi.stubGlobal(
      "fetch",
      createMockFetch({
        "GET /compare": fx.err(422, "UNPROCESSABLE", "Validation failed", {
          fields: [{ field: "symbols", message: "name fewer than 2 different stocks" }],
        }),
      }).impl,
    );
    render(wrap(newClient(), <ComparePage />));
    expect(await screen.findByTestId("compare-error")).toHaveTextContent(
      "symbols name fewer than 2 different stocks",
    );
    expect(screen.getByTestId("compare-retry")).toBeTruthy();
  });

  it("F10R-7: the symbol box follows the URL when it changes (back and forward)", () => {
    search = "symbols=TCS,INFY&range=1Y";
    vi.stubGlobal("fetch", createMockFetch({ "GET /compare": fx.compare() }).impl);
    const client = newClient();
    const { rerender } = render(wrap(client, <ComparePage />));
    expect((screen.getByTestId("compare-symbols") as HTMLInputElement).value).toBe("TCS,INFY");
    search = "symbols=WIPRO,HCLTECH&range=3Y";
    rerender(wrap(client, <ComparePage />));
    expect((screen.getByTestId("compare-symbols") as HTMLInputElement).value).toBe("WIPRO,HCLTECH");
  });
});

describe("peers review fixes", () => {
  const profile = (() => {
    const p = profileSchema.parse(profileData);
    if ("redirect_symbol" in p) throw new Error("fixture");
    return p;
  })();

  it("F10R-8: an add keeps the table and the same add box mounted (focus is not lost)", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      createMockFetch({
        "GET /stocks/TCS/peers": (call) =>
          fx.peers({ added: call.query.get("add") ? ["HCLTECH"] : [] }),
      }).impl,
    );
    render(wrap(newClient(), <PeersTab profile={profile} />));
    await screen.findByTestId("peers-table");
    const input = screen.getByTestId("peers-add-symbol");
    await user.type(input, "hcltech");
    await user.click(screen.getByTestId("peers-add"));
    await screen.findByTestId("peers-row-HCLTECH");
    expect(screen.getByTestId("peers-add-symbol")).toBe(input);
  });

  it("F10R-9: a stale self row is highlighted like a stale peer", async () => {
    const reply = fx.peers() as unknown as {
      body: { data: { self: Record<string, unknown> } };
    };
    reply.body.data.self.stale = true;
    reply.body.data.self.stale_reason = "no_owner_data";
    vi.stubGlobal("fetch", createMockFetch({ "GET /stocks/TCS/peers": reply as never }).impl);
    render(wrap(newClient(), <PeersTab profile={profile} />));
    const row = await screen.findByTestId("peers-row-TCS");
    expect(row.className).toContain("border-l-warn");
    expect(row.getAttribute("data-stale")).toBe("true");
  });
});
