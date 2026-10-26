// F05 review fixes (F05R-1 .. F05R-9): ACT-01 sentence with the day missing, accessible reasons,
// refresh abort, watchlist toggle, SAF-06, request fan-out and the symbol guard.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StockHeader, ALERT_UNAVAILABLE, TXN_UNAVAILABLE } from "@/components/stock/StockHeader";
import { StockPage } from "@/components/stock/StockPage";
import { ToastProvider } from "@/components/ui/overlays";
import { profileDataSchema } from "@/lib/stock/schemas";
import { fail, ok, type MockReply } from "../mocks/imports-fixtures";
import { createMockFetch, type Handler } from "../mocks/mock-fetch";
import * as fx from "../mocks/stock-fixtures";
import "./dom-matchers";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

function mount(routes: Record<string, Handler>, symbol = "TCS") {
  const mock = createMockFetch({
    "GET /watchlist": fx.emptyWatchlist,
    "GET /stocks/TCS/events": fx.events,
    "GET /stocks/TCS/links": fx.links,
    "GET /stocks/TCS/fundamentals": fx.fundamentalsNotComputed,
    ...routes,
  });
  vi.stubGlobal("fetch", mock.impl);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <StockPage symbol={symbol} />
    </QueryClientProvider>,
  );
  return { mock, ...view };
}
const base = (): Record<string, Handler> => ({
  "GET /stocks/TCS": fx.profile(),
  "GET /stocks/TCS/prices": fx.prices(),
  "GET /stocks/TCS/indicators": fx.indicators(),
});

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

type Warn = Array<{ code: string; message: string }>;

/** Bars where the day with the 80% fall (the suspect row, BRK-08) is not served. */
function gapPrices(warnings: Warn, drops: Record<number, number> = { 40: 0.2 }) {
  const all = fx.bars(70, drops);
  const day = all[40]![0];
  const r = fx.prices({}, warnings) as { body: { data: { bars: unknown } } };
  r.body.data.bars = all.filter((_, i) => i !== 40);
  return { reply: r as unknown as MockReply, day };
}
const unconfirmed = (day: string): Warn => [
  { code: "UNCONFIRMED_ACTION", message: `Possible split on ${day} not yet confirmed` },
];
const detected = (day: string, extra: Record<string, unknown>) =>
  ok({
    ...(fx.events.body as { data: object }).data,
    actions: [
      { id: 9, ex_date: day, type: "split_or_bonus", status: "detected", source: "auto", ...extra },
    ],
  });

describe("F05R-1: ACT-01 sentence when the suspect day is not served", () => {
  it("takes the change from the detected action's ratio (1:5 gives -80.0%) and no soft flag doubles up", async () => {
    const day = fx.bars(70)[40]![0];
    const { reply } = gapPrices(unconfirmed(day));
    mount({
      ...base(),
      "GET /stocks/TCS/prices": reply,
      "GET /stocks/TCS/events": detected(day, { ratio_num: 1, ratio_den: 5 }),
    });
    await waitFor(() =>
      expect(screen.getByTestId("unconfirmed-banner").textContent).toMatch(
        /^Possible split or bonus on \d+ \w{3} 2026: price changed -80\.0%\. Confirm to adjust history\.$/,
      ),
    );
    expect(screen.queryByTestId("soft-flag")).toBeNull();
  });

  it("a detected action without a ratio falls back to the sentence without the clause", async () => {
    const day = fx.bars(70)[40]![0];
    const { reply } = gapPrices(unconfirmed(day));
    const { mock } = mount({
      ...base(),
      "GET /stocks/TCS/prices": reply,
      "GET /stocks/TCS/events": detected(day, { ratio_num: null, ratio_den: null }),
    });
    await waitFor(() => expect(mock.calls.some((c) => c.path.endsWith("/events"))).toBe(true));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(screen.getByTestId("unconfirmed-banner").textContent).toMatch(
      /^Possible split or bonus on \d+ \w{3} 2026\. Confirm to adjust history\.$/,
    );
  });
});

describe("F05R-5: every disabled action shows its reason as visible text linked by aria-describedby", () => {
  it("Alert, Add transaction, Confirm, Reject and Dismiss", async () => {
    const day = fx.bars(70)[40]![0];
    // Day 40 is the detected, unserved suspect row; the 30% drop on day 60 is covered by nothing.
    const { reply } = gapPrices(unconfirmed(day), { 40: 0.2, 60: 0.7 });
    mount({ ...base(), "GET /stocks/TCS/prices": reply });
    await screen.findByTestId("soft-flag-dismiss");
    const cases: Array<[string, string | RegExp]> = [
      ["header-alert", ALERT_UNAVAILABLE],
      ["header-add-txn", TXN_UNAVAILABLE],
      ["action-confirm", /Confirm and Reject are not available yet/],
      ["action-reject", /Confirm and Reject are not available yet/],
      ["soft-flag-dismiss", /Dismiss is not available yet/],
    ];
    for (const [id, text] of cases) {
      const el = screen.getByTestId(id);
      expect(el, id).toBeDisabled();
      expect(el.hasAttribute("title"), `${id} must not rely on title`).toBe(false);
      const target = document.getElementById(el.getAttribute("aria-describedby") ?? "");
      expect(target, `${id} aria-describedby target`).not.toBeNull();
      expect(target?.textContent).toMatch(text);
    }
  });
});

describe("F05R-6: watchlist toggle (docs/03 section 11)", () => {
  it("click POSTs with the CSRF header, then DELETEs the id from GET /watchlist", async () => {
    const user = userEvent.setup();
    let members: Array<{ id: number; symbol: string }> = [];
    const { mock } = mount({
      ...base(),
      "GET /watchlist": () => ok({ stocks: members, funds: [] }),
      "POST /watchlist": () => {
        members = [{ id: 7, symbol: "TCS" }];
        return { status: 201, body: { data: {} } };
      },
      "DELETE /watchlist/7": () => {
        members = [];
        return { status: 200, body: { data: {} } };
      },
    });
    const star = await screen.findByTestId("header-watchlist");
    await waitFor(() => expect(star).not.toBeDisabled());
    expect(star).toHaveAttribute("aria-pressed", "false");
    await user.click(star);
    await waitFor(() => expect(star).toHaveAttribute("aria-pressed", "true"));
    const post = mock.calls.find((c) => c.method === "POST" && c.path === "/watchlist");
    expect(post?.headers.get("X-Requested-With")).toBe("fetch");
    expect(post?.body).toEqual({ type: "stock", symbol: "TCS", note: "" });
    await waitFor(() => expect(star).not.toBeDisabled());
    await user.click(star);
    await waitFor(() => expect(star).toHaveAttribute("aria-pressed", "false"));
    const del = mock.calls.find((c) => c.method === "DELETE");
    expect(del?.path).toBe("/watchlist/7");
    expect(del?.headers.get("X-Requested-With")).toBe("fetch");
  });

  it("a failed POST shows an error toast and leaves the star off", async () => {
    const user = userEvent.setup();
    mount({
      ...base(),
      "POST /watchlist": fail(409, "CONFLICT", "TCS is already on the watchlist."),
    });
    const star = await screen.findByTestId("header-watchlist");
    await waitFor(() => expect(star).not.toBeDisabled());
    await user.click(star);
    await waitFor(() =>
      expect(screen.getByTestId("toast-region")).toHaveTextContent(
        "TCS is already on the watchlist.",
      ),
    );
    expect(star).toHaveAttribute("aria-pressed", "false");
  });
});

describe("F05R-3: refresh polling stops on unmount", () => {
  it("no further job polls after the header unmounts", async () => {
    vi.useFakeTimers();
    const mock = createMockFetch({
      "GET /watchlist": fx.emptyWatchlist,
      "POST /stocks/TCS/refresh": { status: 202, body: { data: { job_id: 5 } } },
      "GET /jobs/5": ok({ id: 5, status: "running", error: null }),
    });
    vi.stubGlobal("fetch", mock.impl);
    const profile = profileDataSchema.parse({ ...fx.profileData, price_mode: "broker" });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={client}>
        <ToastProvider>
          <StockHeader profile={profile} bars={null} indicators={null} onRefreshed={vi.fn()} />
        </ToastProvider>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByTestId("header-refresh"));
    await vi.advanceTimersByTimeAsync(3_000);
    const polls = () => mock.calls.filter((c) => c.path === "/jobs/5").length;
    expect(polls()).toBe(1);
    view.unmount();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(polls()).toBe(1);
  });
});

describe("F05R-8: SAF-06 research links are never fetched, prefetched or framed", () => {
  it("only same-origin /api/v1 requests, no iframe, no prefetch link, javascript: URL dropped", async () => {
    const urls: string[] = [];
    const mock = createMockFetch({
      "GET /watchlist": fx.emptyWatchlist,
      ...base(),
      "GET /stocks/TCS/events": fx.events,
      "GET /stocks/TCS/fundamentals": fx.fundamentalsNotComputed,
      "GET /stocks/TCS/links": ok({
        links: [
          { label: "Fine page", url: "https://example.com/quote/TCS" },
          { label: "Bad script", url: "javascript:alert(1)" },
          { label: "Data URL", url: "data:text/html,x" },
        ],
      }),
    });
    vi.stubGlobal("fetch", (...a: Parameters<typeof fetch>) => {
      urls.push(String(a[0]));
      return mock.impl(...a);
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <StockPage symbol="TCS" />
      </QueryClientProvider>,
    );
    const links = await screen.findAllByTestId("research-link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["https://example.com/quote/TCS"]);
    expect(links[0]).toHaveAttribute("rel", "noopener noreferrer");
    expect(links[0]).toHaveAttribute("target", "_blank");
    expect(document.body.innerHTML).not.toMatch(/javascript:|data:text/);
    expect(document.querySelectorAll("iframe, embed, object").length).toBe(0);
    expect(document.querySelectorAll("link[rel=prefetch], link[rel=preload]").length).toBe(0);
    await waitFor(() => expect(urls.length).toBeGreaterThanOrEqual(6));
    for (const u of urls) {
      expect(u, `unexpected request ${u}`).toMatch(/^\/api\/v1\//);
      expect(u).not.toContain("example.com");
    }
  });
});

describe("F05R-7: UI-09 conditional field broker_ok -> header-refresh", () => {
  const header = (mode: string) => {
    const profile = profileDataSchema.parse({ ...fx.profileData, price_mode: mode });
    const client = new QueryClient();
    vi.stubGlobal("fetch", createMockFetch({ "GET /watchlist": fx.emptyWatchlist }).impl);
    return render(
      <QueryClientProvider client={client}>
        <ToastProvider>
          <StockHeader profile={profile} bars={null} indicators={null} onRefreshed={vi.fn()} />
        </ToastProvider>
      </QueryClientProvider>,
    );
  };
  it("is rendered in broker mode and absent in manual mode, as docs/field-map.json states", () => {
    const map = JSON.parse(
      readFileSync(join(process.cwd(), "../../docs/field-map.json"), "utf8"),
    ) as Record<string, Record<string, string>>;
    expect(map["GET /stocks/{symbol}"]?.["broker_ok"]).toMatch(
      /^conditional:header-refresh\|.*broker/,
    );
    header("broker");
    expect(screen.queryByTestId("header-refresh")).not.toBeNull();
    cleanup();
    header("manual");
    expect(screen.queryByTestId("header-refresh")).toBeNull();
  });
});

describe("F05R-9: requests start together; bad symbols never reach the API", () => {
  it("fundamentals and links are requested as soon as the profile is in, before prices resolve", async () => {
    const never = new Promise<never>(() => {});
    const mock = createMockFetch({
      "GET /watchlist": fx.emptyWatchlist,
      "GET /stocks/TCS": fx.profile(),
      "GET /stocks/TCS/events": fx.events,
      "GET /stocks/TCS/links": fx.links,
      "GET /stocks/TCS/fundamentals": fx.fundamentalsNotComputed,
      "GET /stocks/TCS/prices": fx.prices(),
      "GET /stocks/TCS/indicators": fx.indicators(),
    });
    vi.stubGlobal("fetch", (...a: Parameters<typeof fetch>) =>
      String(a[0]).includes("/prices") ? never : mock.impl(...a),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <StockPage symbol="TCS" />
      </QueryClientProvider>,
    );
    await screen.findByTestId("stock-symbol");
    await waitFor(() => {
      const paths = mock.calls.map((c) => c.path);
      for (const p of ["events", "indicators", "fundamentals", "links"])
        expect(paths).toContain(`/stocks/TCS/${p}`);
    });
  });

  it.each(["../admin", "TC S", "-X", "A".repeat(31), "<img>"])(
    "symbol %j shows not-found without any API call",
    (sym) => {
      const { mock } = mount({}, sym);
      const nf = screen.getByTestId("stock-not-found");
      expect(within(nf).getByText(/No stock with the symbol/)).toBeInTheDocument();
      expect(mock.calls).toHaveLength(0);
    },
  );
});
