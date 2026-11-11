import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StockPage } from "@/components/stock/StockPage";
import {
  bucketText,
  fanDataset,
  HIDDEN_REASON_TEXT,
  hiddenReasonText,
  predictionDataSchema,
  trackDataset,
} from "@/lib/stock/prediction";
import { fail, ok, type MockReply } from "../mocks/imports-fixtures";
import { createMockFetch, type Handler } from "../mocks/mock-fetch";
import * as f8 from "../mocks/f08-fixtures";
import * as pf from "../mocks/pred-fixtures";
import * as fx from "../mocks/stock-fixtures";
import "./dom-matchers";

let search = "tab=prediction";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
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

function renderTab(prediction: Handler, hang = false) {
  const mock = createMockFetch({
    "GET /watchlist": fx.emptyWatchlist,
    "GET /stocks/TCS": fx.profile(),
    "GET /stocks/TCS/events": fx.events,
    "GET /stocks/TCS/links": fx.links,
    "GET /stocks/TCS/fundamentals": fx.fundamentalsNotComputed,
    "GET /stocks/TCS/prices": fx.prices(),
    "GET /stocks/TCS/indicators": fx.indicators(),
    "GET /settings/prices-adjustment": f8.adjustment(false),
    "GET /stocks/TCS/prediction": prediction,
  });
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    hang && String(input).includes("/prediction")
      ? new Promise<Response>(() => undefined)
      : mock.impl(input, init),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <StockPage symbol="TCS" />
    </QueryClientProvider>,
  );
  return mock;
}

const ready = () => screen.findByTestId("pred-card", undefined, { timeout: 15000 });
const text = (id: string) => screen.getByTestId(id).textContent ?? "";

beforeEach(() => {
  search = "tab=prediction";
  vi.unstubAllGlobals();
});
afterEach(() => vi.unstubAllGlobals());

describe("PRED-01 banner and disclaimer are always visible", () => {
  const cases: [string, () => MockReply | Handler][] = [
    ["no_model", () => pf.noModel],
    ["insufficient_universe", () => pf.insufficientUniverse],
    ["ok", () => pf.okState],
    ["odd values", () => pf.odd],
    ["error", () => fail(500, "INTERNAL", "boom")],
  ];
  for (const [name, reply] of cases) {
    it(`${name}: experimental banner (no dismiss control) and disclaimer`, async () => {
      renderTab(reply() as Handler);
      await ready();
      await screen.findByTestId(name === "error" ? "pred-error" : "pred-meta", undefined, {
        timeout: 15000,
      });
      const banner = screen.getByTestId("experimental-banner");
      expect(within(banner).queryByRole("button")).toBeNull();
      expect(text("pred-disclaimer")).toMatch(/Not investment advice/);
    });
  }
  it("shows the banner while loading", async () => {
    renderTab(pf.okState as Handler, true);
    await ready();
    expect(screen.getByTestId("experimental-banner")).toBeInTheDocument();
    expect(screen.getByTestId("pred-loading")).toBeInTheDocument();
  });
});

describe("ML-04 / PRED-02 the honest live state (no model, too few stocks)", () => {
  it("insufficient_universe: plain-language reason, every horizon hidden, no numbers", async () => {
    renderTab(pf.insufficientUniverse as Handler);
    await screen.findByTestId("pred-state", undefined, { timeout: 15000 });
    expect(text("pred-state")).toMatch(/Not enough tracked stocks to train a model/);
    expect(text("pred-state")).toMatch(/3 of the 20 stocks needed/);
    for (const d of [5, 21]) {
      const h = screen.getByTestId(`pred-hidden-${d}`);
      expect(h.textContent).toMatch(/Forecast hidden/);
      expect(h.textContent).toMatch(/No model is active/);
      expect(screen.queryByTestId(`pred-bucket-${d}`)).toBeNull();
      expect(screen.queryByTestId(`pred-numbers-${d}`)).toBeNull();
    }
    expect(screen.getByTestId("pred-no-fan")).toBeInTheDocument();
    expect(screen.getByTestId("pred-no-model")).toBeInTheDocument();
    // Unknown values carry a reason, never 0, NaN or Infinity.
    expect(text("pred-ref-close")).toMatch(/—/);
    expect(screen.getByTestId("pred-card").textContent).not.toMatch(/NaN|Infinity/);
    expect(screen.getByTestId("pred-trend").textContent).toMatch(/—/);
    expect(screen.getByTestId("pred-risk").textContent).toMatch(/—/);
    expect(screen.getByTestId("pred-trend").querySelector("[data-testid=gauge-value]")).toBeNull();
  });

  it("no_model state with a rule-based trend and risk gauge still renders them", async () => {
    renderTab(pf.noModel as Handler);
    await screen.findByTestId("pred-state", undefined, { timeout: 15000 });
    expect(text("pred-state")).toMatch(/No forecasting model has been trained/);
    expect(text("pred-trend")).toMatch(/72/);
    expect(text("pred-risk")).toMatch(/41/);
  });
});

describe("ML-05 guardrail fails: explanation, no numbers", () => {
  it("shows the reason per horizon and the model card marked as not passed", async () => {
    renderTab(pf.guardrailFailed as Handler);
    await screen.findByTestId("pred-state", undefined, { timeout: 15000 });
    expect(text("pred-state")).toMatch(/did not pass its accuracy checks/);
    expect(text("pred-hidden-5")).toMatch(/did not beat a simple baseline/);
    expect(text("pred-hidden-21")).toMatch(/Not enough price history/);
    expect(text("pred-hidden-5")).not.toMatch(/[%₹]/);
    expect(text("model-guardrail")).toMatch(/Not passed/);
    expect(screen.queryByTestId("pred-fan")).toBeNull();
  });
});

describe("ML-06 each hidden reason has plain-language copy", () => {
  const reasons = Object.keys(HIDDEN_REASON_TEXT);
  it("covers the whole docs/03 enum", () => {
    expect(reasons.sort()).toEqual(
      [
        "insufficient_history",
        "low_liquidity",
        "model_not_better_than_baseline",
        "near_corporate_action",
        "no_model",
        "stale_data",
      ].sort(),
    );
  });
  for (const r of reasons) {
    it(`${r}: copy is shown, with no numbers for that horizon`, async () => {
      renderTab(pf.withHorizon21(r) as Handler);
      await screen.findByTestId("pred-hidden-21", undefined, { timeout: 15000 });
      expect(text("pred-hidden-21")).toContain(hiddenReasonText(r));
      expect(text("pred-hidden-21")).not.toMatch(/[%₹]/);
      expect(screen.getByTestId("pred-horizon-21").getAttribute("data-shown")).toBe("false");
    });
  }
  it("an unconfirmed action points at the Events tab", async () => {
    renderTab(pf.withHorizon21("near_corporate_action") as Handler);
    await screen.findByTestId("pred-hidden-21", undefined, { timeout: 15000 });
    expect(text("pred-hidden-21")).toMatch(/Confirm the possible split first/);
    expect(screen.getByTestId("pred-events-link").getAttribute("href")).toBe(
      "/stocks/TCS?tab=events",
    );
  });
  it("an unknown reason gets generic copy, not a blank", () => {
    expect(hiddenReasonText("from_the_future")).toMatch(/does not recognise/);
    expect(hiddenReasonText(null)).toMatch(/does not recognise/);
  });
});

describe("PRED-03 ok state: bucket text, fan chart, gauges, model card, track record", () => {
  it("renders a shown horizon as words and a hidden one as its reason", async () => {
    renderTab(pf.okState as Handler);
    await screen.findByTestId("pred-bucket-5", undefined, { timeout: 15000 });
    expect(text("pred-bucket-5")).toBe("Leans slightly up");
    expect(text("pred-hidden-21")).toMatch(/did not beat a simple baseline/);
    expect(screen.queryByTestId("pred-state")).toBeNull();
    // Dashed forecast chart through ChartFrame, with source and as-of.
    const fan = screen.getByTestId("pred-fan");
    expect(fan).toBeInTheDocument();
    expect(text("pred-meta")).toMatch(/As of/);
    expect(text("pred-meta")).toMatch(/Source: /);
    // The numbers are behind "Show the numbers" with units; fractions become percent.
    const nums = text("pred-numbers-5");
    expect(nums).toMatch(/54\.0%/);
    expect(nums).toMatch(/-4\.1% to \+4\.6%/);
    expect(nums).toMatch(/₹3,356\.00 to ₹3,661\.00/);
  });

  it("model card shows version, date, AUC, Brier vs baseline, folds and the guardrail", async () => {
    renderTab(pf.okState as Handler);
    await screen.findByTestId("model-card", undefined, { timeout: 15000 });
    expect(text("model-version")).toBe("dir_5d@2026-10-04");
    expect(text("model-auc")).toBe("0.536");
    expect(text("model-brier")).toMatch(/0\.2491.*better than the baseline/);
    expect(text("model-baseline")).toBe("0.2503");
    expect(text("model-folds")).toBe("8");
    expect(text("model-guardrail")).toMatch(/Passed/);
    expect(text("model-limits")).toMatch(/survivorship bias/);
  });

  it("track record shows count with the rates, and a chart", async () => {
    renderTab(pf.okState as Handler);
    await screen.findByTestId("track-record", undefined, { timeout: 15000 });
    expect(text("track-resolved")).toBe("140");
    expect(text("track-hit")).toBe("51.4%");
    expect(text("track-coverage")).toBe("77.0%");
    expect(screen.getByTestId("pred-track-chart-5")).toBeInTheDocument();
    expect(screen.getByTestId("pred-how")).toBeInTheDocument();
  });

  it("zero resolved predictions: says so instead of showing a rate", async () => {
    const data = {
      ...pf.okData,
      horizons: [
        {
          ...pf.okData.horizons[0]!,
          track_record: {
            resolved: 0,
            direction_hit_rate: null,
            band_coverage_80: null,
            since: "2026-10-01",
            reason: "no_resolved_predictions",
          },
        },
      ],
    };
    renderTab(ok(data));
    await screen.findByTestId("track-none", undefined, { timeout: 15000 });
    expect(text("track-none")).toMatch(/No resolved predictions yet/);
    expect(screen.queryByTestId("track-hit")).toBeNull();
  });
});

describe("ML-12 no single target price anywhere in the UI", () => {
  it("shows only a reference close and a price RANGE; the median price is never rendered", async () => {
    renderTab(pf.okState as Handler);
    await screen.findByTestId("pred-bucket-5", undefined, { timeout: 15000 });
    const all = screen.getByTestId("pred-card").textContent ?? "";
    const prices = [...all.matchAll(/₹[\d,]+(?:\.\d+)?/g)].map((m) => m[0]);
    expect(new Set(prices)).toEqual(new Set(["₹3,500.00", "₹3,356.00", "₹3,661.00"]));
    expect(all).not.toMatch(/3,507/);
    expect(all.toLowerCase()).not.toMatch(/you should (buy|sell)|will reach|price target/);
    // Every occurrence of "target price" is the banner's negation.
    for (const m of all.matchAll(/target price/gi)) {
      expect(all.slice(Math.max(0, m.index - 12), m.index)).toMatch(/not a $/);
    }
  });

  it("the fan chart has three range lines, never one point series; hidden horizons are gaps", () => {
    const d = predictionDataSchema.parse(pf.okData);
    const ds = fanDataset(d)!;
    expect(ds.series.map((s) => s.id)).toEqual(["q90", "q50", "q10"]);
    expect(ds.series.every((s) => s.forecast === true)).toBe(true);
    expect(ds.x).toEqual(["Now", "5 days", "21 days"]);
    expect(ds.series[0]!.values[1]).toBeCloseTo(4.6, 6);
    expect(ds.series[0]!.values[2]).toBeNull();
    expect(ds.series[2]!.values[1]).toBeCloseTo(-4.1, 6);
    expect(ds.series[2]!.values[2]).toBeNull();
    expect(ds.series[0]!.format!(4.6)).toBe("+4.6%");
  });

  it("source files never name a target price", () => {
    const dir = join(__dirname, "../../src/components/stock/prediction");
    const files = [
      ...readdirSync(dir).map((f) => join(dir, f)),
      join(__dirname, "../../src/lib/stock/prediction.ts"),
    ];
    for (const f of files) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/target[ _-]?price|price[ _-]?target/i);
    }
  });
});

describe("PRED-04 degrade per field", () => {
  it("odd values never blank the tab; unknown enums fall back to generic copy", async () => {
    renderTab(pf.odd as Handler);
    await screen.findByTestId("pred-horizons", undefined, { timeout: 15000 });
    expect(text("pred-disclaimer")).toMatch(/Not investment advice/);
    expect(text("pred-state")).toMatch(/No forecast is available/);
    expect(text("pred-hidden-21")).toMatch(/does not recognise/);
    expect(screen.getByTestId("pred-hidden-5")).toBeInTheDocument();
    expect(screen.getByTestId("pred-card").textContent).not.toMatch(/NaN|Infinity|undefined/);
    expect(bucketText("mystery")).toBe("Direction not classified");
  });

  it("track dataset needs resolved predictions and known rates", () => {
    expect(
      trackDataset({
        resolved: 0,
        direction_hit_rate: 0.5,
        band_coverage_80: 0.8,
        since: null,
        reason: null,
      }),
    ).toBeNull();
    expect(
      trackDataset({
        resolved: 9,
        direction_hit_rate: null,
        band_coverage_80: 0.8,
        since: null,
        reason: null,
      }),
    ).toBeNull();
  });
});

describe("PRED-05 states: loading, error with retry, redirect", () => {
  it("error shows the message and a retry that refetches", async () => {
    const mock = renderTab(fail(500, "INTERNAL", "prediction exploded"));
    const err = await screen.findByTestId("pred-error", undefined, { timeout: 15000 });
    expect(err.textContent).toMatch(/prediction exploded/);
    expect(screen.getByTestId("experimental-banner")).toBeInTheDocument();
    const before = mock.calls.filter((c) => c.path === "/stocks/TCS/prediction").length;
    within(err).getByRole("button", { name: /retry/i }).click();
    await waitFor(() =>
      expect(mock.calls.filter((c) => c.path === "/stocks/TCS/prediction").length).toBe(before + 1),
    );
  });

  it("stale data is flagged on the as-of chip", async () => {
    const stale: MockReply = {
      ...pf.okState,
      body: { ...(pf.okState.body as object), meta: { as_of: "2026-10-09", stale: true } },
    };
    renderTab(stale as Handler);
    await screen.findByTestId("pred-bucket-5", undefined, { timeout: 15000 });
    expect(text("pred-meta")).toMatch(/\(stale\)/);
  });
});
