import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOption } from "@/components/charts/chart-data";
import { StockPage } from "@/components/stock/StockPage";
import {
  detectedMultiplier,
  multiplierOf,
  previewConfirm,
  twinConfirmed,
} from "@/lib/stock/action-patch";
import { adjustmentConflictText, adjustmentSentence } from "@/lib/stock/data-tab";
import {
  pledgeDataset,
  qoqDataset,
  stackedDataset,
  sustainedTrend,
  shareholdingDataSchema,
} from "@/lib/stock/ownership";
import { actionSchema } from "@/lib/stock/schemas";
import { fail, ok, type MockReply } from "../mocks/imports-fixtures";
import { createMockFetch, type Handler } from "../mocks/mock-fetch";
import * as f10 from "../mocks/f10-fixtures";
import * as f8 from "../mocks/f08-fixtures";
import * as fx from "../mocks/stock-fixtures";
import "./dom-matchers";

const replace = vi.fn();
let search = "";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(search),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.setConfig({ testTimeout: 30000 });

function renderStock(routes: Record<string, Handler>) {
  const mock = createMockFetch({
    "GET /watchlist": fx.emptyWatchlist,
    "GET /stocks/TCS": fx.profile(),
    "GET /stocks/TCS/events": fx.events,
    "GET /stocks/TCS/links": fx.links,
    "GET /stocks/TCS/fundamentals": fx.fundamentalsNotComputed,
    "GET /stocks/TCS/prices": fx.prices(),
    "GET /stocks/TCS/indicators": fx.indicators(),
    "GET /settings/prices-adjustment": f8.adjustment(false),
    ...routes,
  });
  vi.stubGlobal("fetch", mock.impl);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <StockPage symbol="TCS" />
    </QueryClientProvider>,
  );
  return mock;
}

const openDialog = (): HTMLElement => {
  const d = document.querySelector("dialog[open]");
  if (!d) throw new Error("no open dialog");
  return d as HTMLElement;
};

beforeEach(() => {
  search = "";
  replace.mockReset();
  vi.unstubAllGlobals();
});
afterEach(() => vi.unstubAllGlobals());

const sh = (r: MockReply) => shareholdingDataSchema.parse((r.body as { data: unknown }).data);

describe("ownership model (SHP-01..04, SHP-06)", () => {
  it("SHP-01: no MF figure keeps DII whole in a named series and has no MF series", () => {
    const d = stackedDataset(sh(f8.shareholdingNoMf));
    const ids = d.series.map((s) => s.id);
    expect(ids).toContain("dii_incl_mf");
    expect(ids).not.toContain("mf");
    expect(ids).not.toContain("dii_ex_mf");
  });
  it("with MF, DII excluding MF is dii - mf rounded", () => {
    const d = stackedDataset(sh(f8.shareholding));
    expect(d.series.find((s) => s.id === "dii_ex_mf")?.values).toEqual([5, 5, 5.1, 5.1]);
    expect(d.series.every((s) => s.stack === "holders")).toBe(true);
  });
  it("SHP-02: an unknown pledge stays null, never 0", () => {
    expect(pledgeDataset(sh(f8.shareholding)).series[0]?.values).toEqual([null, null, null, null]);
  });
  it("SHP-04/06: no QoQ values gives no QoQ dataset", () => {
    expect(qoqDataset(sh(f8.shareholdingSingle))).toBeNull();
    const d = qoqDataset(sh(f8.shareholding));
    expect(d?.x).not.toContain("Pledged (of promoter holding)");
    expect(d?.series[0]?.unit).toBe("percentage points");
  });
  it("sustained trend: 3 same-direction steps; a gap, a null or an unchanged step ends the run", () => {
    const q = f8.QUARTERS;
    expect(sustainedTrend(q, [72.3, 72.1, 71.9, 71.7])).toEqual({ direction: "down", quarters: 3 });
    expect(sustainedTrend(q, [1, 2, 3, 4])).toEqual({ direction: "up", quarters: 3 });
    expect(sustainedTrend(q, [72.3, 72.1, 71.9, 72.0])).toBeNull();
    expect(sustainedTrend(q, [1, null, 3, 4])).toBeNull();
    expect(sustainedTrend(q, [1, 2, 3, 3])).toBeNull();
    expect(
      sustainedTrend(["2025-03-31", "2025-12-31", "2026-03-31", "2026-06-30"], [1, 2, 3, 4]),
    ).toBeNull();
  });
});

describe("confirm preview (ACT-05, ACT-06)", () => {
  const cand = actionSchema.parse(f8.detected);
  it("ACT-05: multipliers", () => {
    expect(multiplierOf("split", 10, 2)).toBe(5);
    expect(multiplierOf("bonus", 1, 1)).toBe(2);
    expect(multiplierOf("bonus", 1, 2)).toBe(1.5);
    expect(multiplierOf("split", 0, 2)).toBeNull();
    expect(detectedMultiplier(cand)).toBe(5);
  });
  it("ACT-06: 3% band against the detected 1/r", () => {
    const run = (n: string) =>
      previewConfirm({ type: "split", ratioNum: n, ratioDen: "1" }, cand).warnings.map(
        (w) => w.code,
      );
    expect(run("5")).toEqual([]);
    expect(run("5.145")).toEqual([]);
    expect(run("5.155")).toEqual(["RATIO_DISAGREES_WITH_DETECTED"]);
    expect(run("10")).toEqual(["RATIO_DISAGREES_WITH_DETECTED"]);
    expect(run("1000")).toContain("RATIO_EXTREME");
  });
  it("needs a type and both ratios; equal split ratios are refused; decimal comma is refused", () => {
    expect(previewConfirm({ type: "", ratioNum: "", ratioDen: "" }, cand).errors.type).toBeTruthy();
    expect(
      previewConfirm({ type: "split", ratioNum: "2", ratioDen: "2" }, cand).errors.ratio_num,
    ).toMatch(/changes nothing/);
    expect(
      previewConfirm({ type: "bonus", ratioNum: "1,5", ratioDen: "1" }, cand).errors.ratio_num,
    ).toMatch(/ambiguous/);
    expect(previewConfirm({ type: "split", ratioNum: "10", ratioDen: "2" }, cand).clean).toEqual({
      num: "10",
      den: "2",
    });
  });
  it("twinConfirmed finds a confirmed split/bonus on the same ex-date (ACT-27)", () => {
    const twin = actionSchema.parse({ ...f8.detected, id: 5, type: "split", status: "confirmed" });
    expect(twinConfirmed([cand, twin], cand)?.id).toBe(5);
    expect(twinConfirmed([cand], cand)).toBeNull();
  });
});

describe("data tab text (ACT-11, D-K)", () => {
  it("adjustment sentences are honest for unset, raw and adjusted", () => {
    expect(adjustmentSentence(null)).toMatch(/have not told the app/);
    expect(adjustmentSentence(true)).toMatch(/already adjusted.*never multiplies/);
    expect(adjustmentSentence(false)).toMatch(/raw.*price returns/);
  });
  it("ACT-11 text uses the spec sentence with a formatted date", () => {
    expect(adjustmentConflictText("Possible split on 2026-03-12")).toBe(
      "A possible split/bonus on 12 Mar 2026 was found inside prices imported as already adjusted. Check which file is raw. Nothing was adjusted automatically.",
    );
    expect(adjustmentConflictText("no date")).toMatch(/^A possible split\/bonus was found/);
  });
});

describe("Ownership tab", () => {
  beforeEach(() => {
    search = "tab=ownership";
  });
  it("SHP-01 UI: MF missing note, DII (includes mutual funds), source and dates", async () => {
    renderStock({ "GET /stocks/TCS/shareholding": f8.shareholdingNoMf });
    expect((await screen.findByTestId("mf-missing-note")).textContent).toMatch(
      /DII \(includes mutual funds\)/,
    );
    expect(screen.getByTestId("multiple-dii").textContent).toMatch(/DII \(includes mutual funds\)/);
    expect(screen.getByTestId("ownership-dates").textContent).toMatch(/18 Jul 2026/);
    expect(screen.getByTestId("ownership-meta").textContent).toMatch(/Source: manual/);
  });
  it("renders charts, QoQ, trend badge and shows an unknown pledge as a dash with a reason", async () => {
    renderStock({ "GET /stocks/TCS/shareholding": f8.shareholding });
    await screen.findByTestId("chart-ownership-stack");
    expect(screen.getByTestId("chart-ownership-pledge")).toBeInTheDocument();
    expect(screen.getByTestId("chart-ownership-qoq")).toBeInTheDocument();
    expect(screen.queryByTestId("mf-missing-note")).toBeNull();
    expect(screen.getByTestId("trend-promoter").textContent).toMatch(/Falling 3 quarters/);
    expect(screen.getByTestId("trend-fii").textContent).toMatch(/No sustained trend/);
    expect(screen.getByTestId("pledge-unknown")).toBeInTheDocument();
    expect(screen.getByTestId("multiple-pledged").textContent).toContain("—");
    expect(screen.getByTestId("ownership-table").textContent).not.toMatch(/NaN|Infinity/);
  });
  it("SHP-04: a single quarter has no QoQ chart and says why", async () => {
    renderStock({ "GET /stocks/TCS/shareholding": f8.shareholdingSingle });
    expect((await screen.findByTestId("qoq-reason")).textContent).toMatch(/only one quarter/);
    expect(screen.queryByTestId("chart-ownership-qoq")).toBeNull();
  });
  it("SHP-07: nothing entered gives the entry hint and a link to the import", async () => {
    renderStock({ "GET /stocks/TCS/shareholding": f8.shareholdingEmpty });
    const card = await screen.findByTestId("ownership-empty");
    expect(card.textContent).toMatch(/No shareholding has been entered/);
    expect(screen.getByTestId("ownership-add-quarter")).toHaveAttribute("href", "/imports");
  });
  it("an error shows Retry and the request id", async () => {
    renderStock({
      "GET /stocks/TCS/shareholding": {
        status: 500,
        body: { error: { code: "INTERNAL", message: "boom", request_id: "r-1" } },
      },
    });
    expect((await screen.findByTestId("ownership-error")).textContent).toMatch(/boom/);
  });
});

describe("Peers tab", () => {
  it("calls the peers route and shows the table with the self row (F10)", async () => {
    search = "tab=peers";
    const mock = renderStock({ "GET /stocks/TCS/peers": f10.peers() });
    expect(await screen.findByTestId("peers-table")).toBeTruthy();
    expect(screen.getByTestId("peers-row-TCS")).toBeTruthy();
    expect(mock.calls.filter((c) => c.path === "/stocks/TCS/peers")).toHaveLength(1);
  });
  it("a server without the peers feature says so honestly", async () => {
    search = "tab=peers";
    renderStock({});
    await waitFor(() =>
      expect(screen.getByTestId("peers-card").textContent).toMatch(/not available yet/),
    );
  });
  it("without a sector the server's no_sector_data asks for the sector import", async () => {
    search = "tab=peers";
    renderStock({
      "GET /stocks/TCS": fx.profile({ sector: null, industry: null }),
      "GET /stocks/TCS/peers": f10.err(404, "DATA_UNAVAILABLE", "No sector", {
        reason: "no_sector_data",
      }),
    });
    expect((await screen.findByTestId("peers-unavailable")).textContent).toMatch(
      /Import sector data to see peers/,
    );
    expect(screen.getByTestId("peers-import-link")).toHaveAttribute("href", "/imports");
  });
});

describe("Events tab: detected-action flow (ACT-03, ACT-04, ACT-26..28 UI)", () => {
  beforeEach(() => {
    search = "tab=events";
  });
  const routes = (patch: Handler): Record<string, Handler> => ({
    "GET /stocks/TCS/events": f8.eventsDetected,
    "PATCH /stocks/TCS/actions/9": patch,
  });

  it("lists confirmed, detected and rejected rows and a future-dated note", async () => {
    renderStock(routes(f8.patchRejected));
    await screen.findByTestId("detected-action");
    const items = screen.getAllByTestId("timeline-item").map((e) => e.textContent ?? "");
    expect(items.some((t) => /Rejected/.test(t))).toBe(true);
    expect(items.some((t) => /Dividend ₹10.00 per share/.test(t))).toBe(true);
    expect(items.some((t) => /Future ex-date/.test(t))).toBe(true);
    expect(screen.getByText(/Q2 results/)).toBeInTheDocument();
  });

  it("ACT-03: confirm needs type and both ratios, previews the multiplier, sends one PATCH", async () => {
    const user = userEvent.setup();
    const mock = renderStock(routes(f8.patchConfirmed()));
    await screen.findByTestId("detected-action");
    // Empty form: Confirm shows the field errors and sends nothing.
    await user.click(screen.getByTestId("action-confirm"));
    expect(mock.calls.some((c) => c.method === "PATCH")).toBe(false);
    expect(screen.getByTestId("confirm-reason")).toBeInTheDocument();
    await user.selectOptions(screen.getByTestId("confirm-type"), "split");
    await user.type(screen.getByTestId("confirm-ratio-num"), "10");
    await user.type(screen.getByTestId("confirm-ratio-den"), "2");
    expect(screen.getByTestId("confirm-preview").textContent).toMatch(
      /Implied multiplier: 5\.0000/,
    );
    await user.click(screen.getByTestId("action-confirm"));
    const ok2 = within(openDialog()).getByTestId("confirm-ok");
    fireEvent.click(ok2); // single-flight: two clicks in one tick, one request
    fireEvent.click(ok2);
    const done = await screen.findByTestId("decision-result");
    expect(done.textContent).toMatch(/Confirmed split on 12 Mar 2026 with multiplier 5\.0000/);
    expect(done.textContent).toMatch(/job 31/);
    const patches = mock.calls.filter((c) => c.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0]?.body).toEqual({
      status: "confirmed",
      action_type: "split",
      ratio_num: "10",
      ratio_den: "2",
    });
    expect(patches[0]?.headers.get("X-Requested-With")).toBe("fetch");
  });

  it("ACT-06 UI: a ratio far from the detected multiplier warns before confirming", async () => {
    const user = userEvent.setup();
    renderStock(routes(f8.patchConfirmed()));
    await screen.findByTestId("detected-action");
    await user.selectOptions(screen.getByTestId("confirm-type"), "split");
    await user.type(screen.getByTestId("confirm-ratio-num"), "10");
    await user.type(screen.getByTestId("confirm-ratio-den"), "1");
    expect(screen.getByTestId("preview-warning-RATIO_DISAGREES_WITH_DETECTED")).toBeInTheDocument();
  });

  it("shows the server warnings, the future ex-date note and the queue-retry sentence", async () => {
    const user = userEvent.setup();
    renderStock(
      routes(
        f8.patchConfirmed({
          future_ex_date: true,
          post_import_job_id: null,
          warnings: [
            {
              field: "ratio_num",
              code: "RATIO_DISAGREES_WITH_DETECTED",
              message: "differs by more than 3%",
            },
            { field: "post_import", code: "POST_IMPORT_NOT_QUEUED", message: "x" },
            { field: "", code: "ADJUSTMENT_SKIPPED_SRC_ADJUSTED", message: "y" },
          ],
        }),
      ),
    );
    await screen.findByTestId("detected-action");
    await user.selectOptions(screen.getByTestId("confirm-type"), "split");
    await user.type(screen.getByTestId("confirm-ratio-num"), "10");
    await user.type(screen.getByTestId("confirm-ratio-den"), "2");
    await user.click(screen.getByTestId("action-confirm"));
    await user.click(within(openDialog()).getByTestId("confirm-ok"));
    const t = (await screen.findByTestId("decision-result")).textContent ?? "";
    expect(t).toMatch(/ex-date is in the future/);
    expect(t).toMatch(/differs by more than 3%/);
    expect(t).toMatch(/could not be queued/);
    expect(t).toMatch(/never adjusted twice|Nothing is adjusted twice/);
  });

  it("ACT-04: reject sends {status: rejected} after a confirmation dialog", async () => {
    const user = userEvent.setup();
    const mock = renderStock(routes(f8.patchRejected));
    await screen.findByTestId("detected-action");
    await user.click(screen.getByTestId("action-reject"));
    await user.click(within(openDialog()).getByTestId("confirm-ok"));
    expect((await screen.findByTestId("decision-result")).textContent).toMatch(
      /Rejected the candidate on 12 Mar 2026/,
    );
    const p = mock.calls.find((c) => c.method === "PATCH");
    expect(p?.body).toEqual({ status: "rejected" });
  });

  it("409 shows the server message, reloads the list and sends nothing else", async () => {
    const user = userEvent.setup();
    const mock = renderStock(
      routes(
        fail(409, "CONFLICT", "A confirmed split or bonus already exists for TCS on 2026-03-12"),
      ),
    );
    await screen.findByTestId("detected-action");
    await user.selectOptions(screen.getByTestId("confirm-type"), "bonus");
    await user.type(screen.getByTestId("confirm-ratio-num"), "1");
    await user.type(screen.getByTestId("confirm-ratio-den"), "1");
    await user.click(screen.getByTestId("action-confirm"));
    await user.click(within(openDialog()).getByTestId("confirm-ok"));
    const err = await screen.findByTestId("action-error");
    expect(err.textContent).toMatch(/already exists/);
    await waitFor(() =>
      expect(
        mock.calls.filter((c) => c.method === "GET" && c.path === "/stocks/TCS/events").length,
      ).toBeGreaterThan(1),
    );
  });

  it("warns up front when a confirmed split or bonus already sits on the ex-date (ACT-27)", async () => {
    const twin = {
      ...f8.detected,
      id: 77,
      type: "split",
      status: "confirmed",
      ratio_num: 10,
      ratio_den: 2,
      source: "manual",
    };
    const body = {
      data: { actions: [f8.detected, twin], calendar: [], reason: null, entry_hint: null },
      meta: {},
      warnings: [],
    };
    renderStock({ "GET /stocks/TCS/events": { status: 200, body } });
    expect((await screen.findByTestId("twin-warning")).textContent).toMatch(
      /adjust the history twice/,
    );
  });

  it("research links open with noopener noreferrer and are never fetched", async () => {
    renderStock({ "GET /stocks/TCS/events": f8.eventsDetected });
    const links = await screen.findAllByTestId("research-link");
    for (const a of links) {
      expect(a).toHaveAttribute("rel", "noopener noreferrer");
      expect(a).toHaveAttribute("target", "_blank");
    }
  });

  it("an empty list says nothing was entered", async () => {
    renderStock({ "GET /stocks/TCS/events": fx.eventsEmpty });
    expect((await screen.findByTestId("events-no-data")).textContent).toMatch(/No events entered/);
  });
});

describe("Data tab", () => {
  beforeEach(() => {
    search = "tab=data";
  });
  it("ACT-11: shows the ADJUSTMENT_CONFLICT text; coverage, honest gaps and the delete action", async () => {
    const prof = ok(fx.profileData);
    (prof.body as { warnings: unknown[] }).warnings = [
      { code: "ADJUSTMENT_CONFLICT", message: "Possible split on 2026-03-12 inside adjusted bars" },
    ];
    renderStock({
      "GET /stocks/TCS": prof,
      "GET /stocks/TCS/prices": ok({
        bars: [["2026-10-09", 1, 1, 1, 1, 1]],
        adjusted: true,
        actions: [],
        depth: { first_bar: "2020-01-01", last_bar: "2026-10-09", bars: 1500 },
      }),
    });
    expect((await screen.findByTestId("adjustment-conflict")).textContent).toBe(
      "A possible split/bonus on 12 Mar 2026 was found inside prices imported as already adjusted. Check which file is raw. Nothing was adjusted automatically.",
    );
    await waitFor(() => expect(screen.getByTestId("data-bars").textContent).toBe("1,500"));
    expect(screen.getByTestId("data-first-bar").textContent).toBe("1 Jan 2020");
    expect(screen.getByTestId("data-sources").textContent).toMatch(/not reported by the API/);
    expect(screen.getByTestId("data-suspect").textContent).toMatch(/not reported by the API/);
    expect(screen.getByTestId("data-batches-link")).toHaveAttribute("href", "/imports");
    expect((await screen.findByTestId("adjustment-state")).textContent).toMatch(/treated as raw/);
    expect(screen.getByTestId("delete-prices")).toBeInTheDocument();
    expect(screen.queryByTestId("delete-symbol")).toBeNull(); // the symbol is fixed on this tab
  });
  it("unset adjustment setting and no prices: reasons, no zeros", async () => {
    renderStock({
      "GET /stocks/TCS": fx.profile({
        flags: { no_prices: true, limited_history: false, series_warning: null },
        freshness: { ...fx.profileData.freshness, prices_as_of: null },
      }),
      "GET /settings/prices-adjustment": f8.adjustment(null),
    });
    expect((await screen.findByTestId("adjustment-state")).textContent).toMatch(
      /have not told the app/,
    );
    expect(screen.getByTestId("data-bars").textContent).toMatch(/—/);
    expect(screen.queryByTestId("adjustment-conflict")).toBeNull();
  });
});

describe("F08R review fixes", () => {
  const cand = actionSchema.parse(f8.detected);
  const codes = (type: "split" | "bonus", n: string, d: string) =>
    previewConfirm({ type, ratioNum: n, ratioDen: d }, cand);

  it("ACT-31: reverse split 2:10 previews 0.2 and a bonus uses (num+den)/den like the API", () => {
    expect(codes("split", "2", "10").multiplier).toBeCloseTo(0.2, 12);
    expect(codes("bonus", "1", "4").multiplier).toBe(1.25);
  });

  it("ACT-31: exactly 3% from the detected multiplier is silent (5.15 against 5), as on the server", () => {
    expect(codes("split", "5.15", "1").warnings).toEqual([]);
  });

  it("ACT-32: 100 and 0.01 are silent, above or below warn", () => {
    const has = (n: string, d: string) =>
      codes("split", n, d).warnings.some((w) => w.code === "RATIO_EXTREME");
    expect(has("100", "1")).toBe(false);
    expect(has("1", "100")).toBe(false);
    expect(has("101", "1")).toBe(true);
    expect(has("1", "101")).toBe(true);
  });

  it("ACT-31: ratios follow ValidateAction limits (4 decimals, below 100,000,000)", () => {
    expect(codes("split", "10.00001", "2").errors.ratio_num).toMatch(/at most 4 decimal/);
    expect(codes("split", "10", "2.12345").errors.ratio_den).toMatch(/at most 4 decimal/);
    expect(codes("split", "10.1200", "2").errors.ratio_num).toBeUndefined();
    expect(codes("split", "100000000", "2").errors.ratio_num).toMatch(/too large/);
    expect(codes("split", "99999999.9999", "2").errors.ratio_num).toBeUndefined();
    expect(codes("split", "99999999.9999", "2").clean).not.toBeNull();
  });

  const submit = async (user: ReturnType<typeof userEvent.setup>) => {
    await screen.findByTestId("detected-action");
    await user.selectOptions(screen.getByTestId("confirm-type"), "split");
    await user.type(screen.getByTestId("confirm-ratio-num"), "10");
    await user.type(screen.getByTestId("confirm-ratio-den"), "2");
    await user.click(screen.getByTestId("action-confirm"));
    await user.click(within(openDialog()).getByTestId("confirm-ok"));
  };

  it("ACT-35: a saved decision whose recalculation was not queued has a working Retry", async () => {
    search = "tab=events";
    const user = userEvent.setup();
    let n = 0;
    const mock = renderStock({
      "GET /stocks/TCS/events": f8.eventsDetected,
      "PATCH /stocks/TCS/actions/9": () => {
        n++;
        return n === 1
          ? f8.patchConfirmed({
              post_import_job_id: null,
              warnings: [{ code: "POST_IMPORT_NOT_QUEUED", message: "x" }],
            })
          : f8.patchConfirmed({ changed: false, post_import_job_id: 40 });
      },
    });
    await submit(user);
    await user.click(await screen.findByTestId("decision-retry"));
    await waitFor(() =>
      expect(screen.getByTestId("decision-result").textContent).toMatch(/job 40/),
    );
    expect(screen.queryByTestId("decision-retry")).toBeNull();
    const patches = mock.calls.filter((c) => c.method === "PATCH");
    expect(patches).toHaveLength(2);
    expect(patches[1]?.body).toEqual({ status: "confirmed" });
  });

  it("a saved decision moves focus to the result message (keyboard users keep their place)", async () => {
    search = "tab=events";
    const user = userEvent.setup();
    renderStock({
      "GET /stocks/TCS/events": f8.eventsDetected,
      "PATCH /stocks/TCS/actions/9": f8.patchConfirmed(),
    });
    await submit(user);
    await screen.findByTestId("decision-result");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("decision-live")));
  });

  it("404 says the action no longer exists and reloads the list", async () => {
    search = "tab=events";
    const user = userEvent.setup();
    const mock = renderStock({
      "GET /stocks/TCS/events": f8.eventsDetected,
      "PATCH /stocks/TCS/actions/9": fail(404, "NOT_FOUND", "corporate action not found"),
    });
    await submit(user);
    expect((await screen.findByTestId("action-error")).textContent).toMatch(/no longer exists/);
    await waitFor(() =>
      expect(
        mock.calls.filter((c) => c.method === "GET" && c.path === "/stocks/TCS/events").length,
      ).toBeGreaterThan(1),
    );
  });

  it("422 from the server lands on the ratio field", async () => {
    search = "tab=events";
    const user = userEvent.setup();
    renderStock({
      "GET /stocks/TCS/events": f8.eventsDetected,
      "PATCH /stocks/TCS/actions/9": fail(422, "VALIDATION", "invalid", {
        fields: [{ field: "ratio_num", message: "server says ratio_num is odd" }],
      }),
    });
    await submit(user);
    expect((await screen.findAllByTestId("form-field-error"))[0]?.textContent).toContain(
      "server says ratio_num is odd",
    );
  });

  it("a failed confirm followed by a failed reject shows only the latest error", async () => {
    search = "tab=events";
    const user = userEvent.setup();
    let n = 0;
    renderStock({
      "GET /stocks/TCS/events": f8.eventsDetected,
      "PATCH /stocks/TCS/actions/9": () => {
        n++;
        return n === 1 ? fail(409, "CONFLICT", "first problem") : fail(409, "CONFLICT", "second");
      },
    });
    await submit(user);
    expect((await screen.findByTestId("action-error")).textContent).toMatch(/first problem/);
    await user.click(screen.getByTestId("action-reject"));
    await user.click(within(openDialog()).getByTestId("confirm-ok"));
    await waitFor(() => expect(screen.getByTestId("action-error").textContent).toMatch(/second/));
    expect(screen.getByTestId("action-error").textContent).not.toMatch(/first problem/);
  });

  it("stacked composition starts its axis at zero and keeps markers; unstacked stays fitted", () => {
    const base = { xName: "Q", x: ["a", "b"], source: "s", asOf: null } as const;
    const stacked = buildOption(
      {
        ...base,
        series: [
          { id: "a", name: "A", unit: "%", kind: "area", stack: "h", values: [40, 41] },
          { id: "b", name: "B", unit: "%", kind: "area", stack: "h", values: [20, 21] },
        ],
      },
      { theme: "light" },
    ) as { yAxis: { scale: boolean }; series: Array<{ stack?: string; symbol?: string }> };
    expect(stacked.yAxis.scale).toBe(false);
    expect(stacked.series.map((s) => s.stack)).toEqual(["h", "h"]);
    expect(new Set(stacked.series.map((s) => s.symbol)).size).toBe(2);
    const plain = buildOption(
      { ...base, series: [{ id: "a", name: "A", unit: "%", kind: "line", values: [40, 41] }] },
      { theme: "light" },
    ) as { yAxis: { scale: boolean } };
    expect(plain.yAxis.scale).toBe(true);
  });
});
