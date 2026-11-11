import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { csvModel } from "@/components/charts/chart-data";
import { Gauge } from "@/components/ui/Gauge";
import { StockPage, TAB_IDS } from "@/components/stock/StockPage";
import { RISK_BANDS, TREND_BANDS } from "@/lib/stock/gauge-bands";
import {
  bucketText,
  fanDataset,
  HIDDEN_REASON_TEXT,
  hiddenReasonText,
  noCardText,
  predictionDataSchema,
  STATE_FALLBACK,
  STATE_TEXT,
  stateText,
  trackDataset,
  UNREADABLE,
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
const find = (id: string) => screen.findByTestId(id, undefined, { timeout: 15000 });

/** The real Go API source: the state enum and the hidden-reason enum are read from it. */
const GO = readFileSync(join(__dirname, "../../../api/internal/predict/predict.go"), "utf8");
const goStates = (() => {
  const fn = GO.slice(GO.indexOf("func (s *Service) state("));
  const body = fn.slice(0, fn.indexOf("\nfunc ", 5));
  return [...new Set([...body.matchAll(/(?:return|case)\s+"([a-z_]+)"/g)].map((m) => m[1]!))]
    .filter((s) => s !== "ok")
    .sort();
})();
const goReasons = [...GO.matchAll(/Reason\w+\s*=\s*"([a-z_]+)"/g)].map((m) => m[1]!).sort();

beforeEach(() => {
  search = "tab=prediction";
  vi.unstubAllGlobals();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PRED-01 banner and disclaimer are always visible", () => {
  const cases: [string, () => MockReply | Handler][] = [
    ["no_model", () => pf.noModel],
    ["insufficient_universe", () => pf.insufficientUniverse],
    ["guardrail_failed", () => pf.guardrailFailed],
    ["ok", () => pf.okState],
    ["odd values", () => pf.odd],
    ["blank disclaimer", () => pf.unreadableSections],
    ["error", () => fail(500, "INTERNAL", "boom")],
  ];
  for (const [name, reply] of cases) {
    it(`${name}: experimental banner (no dismiss control) and disclaimer`, async () => {
      renderTab(reply() as Handler);
      await ready();
      await find(name === "error" ? "pred-error" : "pred-meta");
      const banner = screen.getByTestId("experimental-banner");
      expect(within(banner).queryByRole("button")).toBeNull();
      expect(text("pred-disclaimer")).toBe(pf.DISCLAIMER);
    });
  }
  it("shows the banner and the default disclaimer while the data loads", async () => {
    renderTab(pf.okState as Handler, true);
    await ready();
    expect(screen.getByTestId("experimental-banner")).toBeInTheDocument();
    expect(text("pred-disclaimer")).toBe(pf.DISCLAIMER);
    expect(screen.getByTestId("pred-loading")).toBeInTheDocument();
  });
  it("uses the API disclaimer when it sends one", async () => {
    renderTab(ok({ ...pf.okData, disclaimer: "  Custom wording.  " }) as Handler);
    await find("pred-meta");
    expect(text("pred-disclaimer")).toBe("Custom wording.");
  });
});

describe("ML-04 / PRED-02 the honest live state (no model, too few stocks)", () => {
  it("insufficient_universe: plain-language reason, every horizon hidden, no numbers", async () => {
    renderTab(pf.insufficientUniverse as Handler);
    await find("pred-state");
    expect(text("pred-state")).toMatch(/Not enough tracked stocks to train a model/);
    expect(text("pred-state")).toMatch(/Fewer than 20 stocks have enough price history/);
    for (const d of [5, 21]) {
      const h = screen.getByTestId(`pred-hidden-${d}`);
      expect(h.textContent).toMatch(/Forecast hidden/);
      expect(h.textContent).toMatch(/No model is active/);
      expect(screen.queryByTestId(`pred-bucket-${d}`)).toBeNull();
      expect(screen.queryByTestId(`pred-numbers-${d}`)).toBeNull();
    }
    expect(screen.getByTestId("pred-no-fan")).toBeInTheDocument();
    expect(text("pred-no-model")).toMatch(/no model has been trained/);
    // Unknown values carry a reason, never 0, NaN or Infinity.
    expect(text("pred-ref-close")).toMatch(/—/);
    expect(text("pred-ref-close")).toMatch(/no range is shown/);
    expect(screen.getByTestId("pred-card").textContent).not.toMatch(/NaN|Infinity/);
    expect(screen.getByTestId("pred-trend").textContent).toMatch(/—/);
    expect(screen.getByTestId("pred-risk").textContent).toMatch(/—/);
    expect(screen.getByTestId("pred-trend").querySelector("[data-testid=gauge-value]")).toBeNull();
  });

  it("no_model state with a rule-based trend and risk gauge still renders them", async () => {
    renderTab(pf.noModel as Handler);
    await find("pred-state");
    expect(text("pred-state")).toMatch(/No forecasting model has been trained/);
    expect(text("pred-no-model")).toMatch(/no model has been trained/);
    expect(text("pred-trend")).toMatch(/72/);
    expect(text("pred-risk")).toMatch(/41/);
  });
});

describe("ML-05 / PREDX-01 guardrail_failed as the real API sends it (model null on every horizon)", () => {
  it("says the latest model failed its checks and never claims no model was trained", async () => {
    renderTab(pf.guardrailFailed as Handler);
    await find("pred-state");
    expect(text("pred-state")).toMatch(/did not pass its accuracy checks/);
    expect(text("pred-hidden-5")).toMatch(/did not pass its accuracy checks/);
    expect(text("pred-hidden-21")).toMatch(/Not enough price history/);
    expect(text("pred-hidden-5")).not.toMatch(/[%₹]/);
    expect(text("pred-no-model")).toMatch(
      /latest model did not pass its checks and no model card is served for it/,
    );
    expect(screen.getByTestId("pred-card").textContent).not.toMatch(
      /no model has been trained|Not passed/i,
    );
    expect(screen.queryByTestId("model-card")).toBeNull();
    expect(screen.queryByTestId("pred-fan")).toBeNull();
  });

  it("the empty-card copy depends on the state", () => {
    expect(noCardText("no_model")).toMatch(/no model has been trained/);
    expect(noCardText("insufficient_universe")).toMatch(/no model has been trained/);
    expect(noCardText("guardrail_failed")).not.toMatch(/no model has been trained/);
    for (const s of ["training_aborted", "mystery", null]) {
      expect(noCardText(s)).not.toMatch(/no model has been trained/);
    }
  });
});

describe("PREDX-02 the state table is complete and extensible", () => {
  it("reads the state enum from predict.go (and finds the known states)", () => {
    expect(goStates).toEqual(
      expect.arrayContaining(["guardrail_failed", "insufficient_history", "no_model"]),
    );
  });
  it("has copy for every state the Go API can send, and for the B14 states", () => {
    const wanted = new Set([
      ...goStates,
      "training_aborted",
      "guardrail_failed",
      "no_model",
      "insufficient_universe",
      "insufficient_history",
    ]);
    for (const s of wanted) {
      expect(STATE_TEXT[s], `state ${s}`).toBeTruthy();
      expect(stateText(s)).toBe(STATE_TEXT[s]);
    }
    expect(Object.keys(STATE_TEXT)).not.toContain("ok");
  });
  it("an unknown or unreadable state gets generic honest copy", () => {
    expect(stateText("from_the_future")).toBe(STATE_FALLBACK);
    expect(stateText(null)).toMatch(/could not be read/);
  });
  for (const s of [...new Set([...goStates, "training_aborted"])]) {
    it(`${s}: the banner shows its copy and the served reason`, async () => {
      renderTab(pf.noActiveModel(s) as Handler);
      await find("pred-state");
      expect(screen.getByTestId("pred-state").getAttribute("data-state")).toBe(s);
      expect(text("pred-state")).toContain(stateText(s));
      expect(text("pred-state")).toContain(`served reason for ${s}`);
    });
  }
  it("an unknown state still renders the generic copy", async () => {
    renderTab(pf.noActiveModel("state_from_the_future") as Handler);
    await find("pred-state");
    expect(text("pred-state")).toContain(STATE_FALLBACK);
  });
});

describe("ML-06 each hidden reason has plain-language copy", () => {
  const EIGHT = [
    "awaiting_predictions",
    "insufficient_history",
    "low_liquidity",
    "model_not_better_than_baseline",
    "near_corporate_action",
    "no_model",
    "not_tracked",
    "stale_data",
  ];
  it("covers the whole docs/03 enum (worker six plus the API-only awaiting_predictions and not_tracked), tied to the Go enum", () => {
    expect(Object.keys(HIDDEN_REASON_TEXT).sort()).toEqual([...EIGHT].sort());
    for (const r of goReasons) expect(EIGHT, r).toContain(r);
    expect(goReasons.length).toBeGreaterThanOrEqual(6);
  });
  for (const r of EIGHT) {
    it(`${r}: copy is shown, with no numbers for that horizon`, async () => {
      renderTab(pf.withHorizon21(r) as Handler);
      await find("pred-hidden-21");
      expect(text("pred-hidden-21")).toContain(hiddenReasonText(r));
      expect(text("pred-hidden-21")).not.toMatch(/[%₹]/);
      expect(screen.getByTestId("pred-horizon-21").getAttribute("data-shown")).toBe("false");
    });
  }
  it("the accuracy-check reason does not claim a baseline verdict", () => {
    expect(hiddenReasonText("model_not_better_than_baseline")).toMatch(
      /did not pass its accuracy checks/,
    );
  });
  it("insufficient_history is true for a stock-level and a model-level cause", () => {
    const t = hiddenReasonText("insufficient_history");
    expect(t).toMatch(/this stock has too few imported daily prices/);
    expect(t).toMatch(/walk-forward testing did not have enough history/);
  });
  it("an unknown reason gets generic copy, not a blank", () => {
    expect(hiddenReasonText("from_the_future")).toMatch(/does not recognise/);
    expect(hiddenReasonText(null)).toMatch(/no reason was served/);
  });
});

describe("PREDX-03 Events link next to the near_corporate_action message", () => {
  it("places a link inside the hidden message and keeps the bottom link; both go to the Events tab", async () => {
    renderTab(pf.nearActionWithModel as Handler);
    await find("pred-hidden-21");
    const inline = within(screen.getByTestId("pred-hidden-21")).getByTestId("pred-events-link-21");
    expect(text("pred-hidden-21")).toMatch(/Confirm the possible split first/);
    const bottom = screen.getByTestId("pred-events-link");
    for (const a of [inline, bottom]) {
      expect(a.getAttribute("href")).toBe("/stocks/TCS?tab=events");
      const tab = new URLSearchParams(a.getAttribute("href")!.split("?")[1]).get("tab");
      expect(TAB_IDS as readonly string[]).toContain(tab);
    }
  });
  it("other reasons have no inline link", async () => {
    renderTab(pf.withHorizon21("stale_data") as Handler);
    await find("pred-hidden-21");
    expect(screen.queryByTestId("pred-events-link-21")).toBeNull();
    expect(screen.getByTestId("pred-events-link")).toBeInTheDocument();
  });
});

describe("PRED-03 ok state: bucket text, fan chart, gauges, model card, track record", () => {
  it("renders a shown horizon as words and a hidden one as its reason", async () => {
    renderTab(pf.okState as Handler);
    await find("pred-bucket-5");
    expect(text("pred-bucket-5")).toBe("Leans slightly up");
    expect(text("pred-hidden-21")).toMatch(/did not pass its accuracy checks/);
    expect(screen.queryByTestId("pred-state")).toBeNull();
    expect(screen.getByTestId("pred-fan")).toBeInTheDocument();
    expect(text("pred-meta")).toMatch(/As of/);
    expect(text("pred-meta")).toMatch(/Source: /);
    expect(text("pred-ref-close")).toMatch(/where the ranges start/);
    const nums = text("pred-numbers-5");
    expect(nums).toMatch(/54\.0%/);
    expect(nums).toMatch(/-4\.1% to \+4\.6%/);
    expect(nums).toMatch(/₹3,356\.00 to ₹3,661\.00/);
  });

  it("model card shows version, date, AUC, Brier vs baseline, folds and the guardrail", async () => {
    renderTab(pf.okState as Handler);
    await find("model-card");
    expect(text("model-version")).toBe("dir_5d@2026-10-04");
    expect(text("model-auc")).toBe("0.536");
    expect(text("model-brier")).toMatch(/0\.2491.*better than the baseline/);
    expect(text("model-baseline")).toBe("0.2503");
    expect(text("model-folds")).toBe("8");
    expect(text("model-guardrail")).toMatch(/Passed/);
    expect(text("model-limits")).toMatch(/survivorship bias/);
  });

  it("PREDX-04 the model note is owner-facing and does not blame the API", async () => {
    renderTab(pf.okState as Handler);
    await find("model-limits");
    expect(text("model-limits")).toMatch(/open decision for the owner/);
    expect(text("model-limits")).toMatch(/F09-1/);
    expect(text("model-limits")).not.toMatch(/served by the API|last 8/);
  });

  it("track record shows count with the rates, and a chart", async () => {
    renderTab(pf.okState as Handler);
    await find("track-record");
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
    await find("track-none");
    expect(text("track-none")).toMatch(/No resolved predictions yet/);
    expect(screen.queryByTestId("track-hit")).toBeNull();
  });
});

describe("PREDX-05 every block names its source and as-of", () => {
  it("gauges, model card and track record each carry a source chip and an as-of", async () => {
    renderTab(pf.okState as Handler);
    await find("model-card");
    const blocks = screen.getAllByTestId("pred-provenance");
    expect(blocks).toHaveLength(3);
    for (const b of blocks) {
      expect(within(b).getByTestId("source-chip")).toBeInTheDocument();
      expect(within(b).getByTestId("asof-chip").textContent).toMatch(/^As of \S/);
    }
    const gauges = blocks[0]!.textContent ?? "";
    expect(gauges).toMatch(/rule-based scores/);
    expect(gauges).toMatch(/As of not served/);
    expect(within(screen.getByTestId("model-card")).getByTestId("asof-chip").textContent).toMatch(
      /As of 4 Oct 2026|As of 2026-10-04|As of .*2026/,
    );
    expect(blocks[2]!.textContent).toMatch(/As of not served/);
  });
});

describe("PREDX-06 meta.stale, meta.as_of and warnings[] (the shape B14 serves)", () => {
  const withMeta = (data: object, meta: object, warnings: object[] = []): MockReply => ({
    status: 200,
    body: { data, meta, warnings },
  });
  it("flags stale from meta.stale and renders the warning text", async () => {
    renderTab(
      withMeta(pf.okData, { as_of: "2026-10-09T10:00:00Z", stale: true }, [
        { code: "STALE_DATA", message: "Prices are more than 3 trading days old." },
      ]) as Handler,
    );
    await find("pred-bucket-5");
    expect(text("pred-meta")).toMatch(/\(stale\)/);
    expect(text("pred-warning-0")).toBe("Prices are more than 3 trading days old.");
  });
  it("falls back to meta.as_of when the data has no as_of but a forecast is shown", async () => {
    renderTab(
      withMeta(
        { ...pf.okData, as_of: null },
        { as_of: "2026-10-09T10:00:00Z", stale: false },
      ) as Handler,
    );
    await find("pred-bucket-5");
    expect(text("pred-meta")).toMatch(/As of .*2026/);
    expect(text("pred-meta")).not.toMatch(/unknown/);
  });
  it("a stale_data horizon also marks the tab stale", async () => {
    renderTab(pf.withHorizon21("stale_data") as Handler);
    await find("pred-bucket-5");
    expect(text("pred-meta")).toMatch(/\(stale\)/);
  });
  it("a null meta.as_of with as_of_reason no_data is handled and its reason shown", async () => {
    renderTab(
      withMeta((pf.noModel.body as { data: object }).data, {
        as_of: null,
        as_of_reason: "no_data",
        stale: false,
      }) as Handler,
    );
    await find("pred-asof-reason");
    expect(text("pred-asof-reason")).toMatch(/No as-of date: no data/);
    expect(text("pred-meta")).toMatch(/As of: unknown/);
  });
  it("no warnings means no warning banners", async () => {
    renderTab(pf.okState as Handler);
    await find("pred-bucket-5");
    expect(screen.queryByTestId("pred-warning-0")).toBeNull();
  });
});

describe("ML-12 no single target price anywhere in the UI", () => {
  it("shows only a reference close and a price RANGE; the median price is never rendered", async () => {
    renderTab(pf.okState as Handler);
    await find("pred-bucket-5");
    const all = screen.getByTestId("pred-card").textContent ?? "";
    const prices = [...all.matchAll(/₹[\d,]+(?:\.\d+)?/g)].map((m) => m[0]);
    expect(new Set(prices)).toEqual(new Set(["₹3,500.00", "₹3,356.00", "₹3,661.00"]));
    expect(all).not.toMatch(/3,507/);
    expect(all.toLowerCase()).not.toMatch(/you should (buy|sell)|will reach|price target/);
    for (const m of all.matchAll(/target price/gi)) {
      expect(all.slice(Math.max(0, m.index - 12), m.index)).toMatch(/not a $/);
    }
  });

  it("the Show data table, and the CSV and tooltip text, hold only returns, never a price", async () => {
    renderTab(pf.okState as Handler);
    await find("pred-fan");
    await userEvent.click(within(screen.getByTestId("pred-fan")).getByTestId("chart-show-data"));
    const table = within(screen.getByTestId("pred-fan")).getByTestId("chart-data-table");
    const cells = table.textContent ?? "";
    expect(cells).not.toMatch(/₹|3,507|3507|3,500|3,356|3,661/);
    expect(cells).toMatch(/\+4\.6%/);
    expect(cells).toMatch(/-4\.1%/);
    expect(cells).toMatch(/\+0\.2%/);
    const ds = fanDataset(predictionDataSchema.parse(pf.okData))!;
    const csv = JSON.stringify(csvModel(ds));
    expect(csv).not.toMatch(/3507|3500|3356|3661/);
    for (const s of ds.series) {
      expect(s.unit).toBe("%");
      for (const v of s.values) expect(Math.abs(v ?? 0)).toBeLessThan(100);
      expect(s.format!(s.values[1]!)).toMatch(/%$/);
    }
  });

  it("the fan chart has three range lines, never one point series; only shown horizons are drawn", () => {
    const d = predictionDataSchema.parse(pf.okData);
    const ds = fanDataset(d)!;
    expect(ds.series.map((s) => s.id)).toEqual(["q90", "q50", "q10"]);
    expect(ds.series.every((s) => s.forecast === true)).toBe(true);
    expect(ds.x).toEqual(["Now", "5 days"]);
    // Rounded to 6 places: 0.046 * 100 is 4.6000000000000005 in floating point.
    expect(ds.series[0]!.values).toEqual([0, 4.6]);
    expect(ds.series[1]!.values).toEqual([0, 0.2]);
    expect(ds.series[2]!.values).toEqual([0, -4.1]);
    expect(csvModel(ds).rows).toEqual([
      ["Now", 0, 0, 0],
      ["5 days", 4.6, 0.2, -4.1],
    ]);
    expect(ds.series[0]!.format!(4.6)).toBe("+4.6%");
  });

  it("no 'Now' point is orphaned: with a hidden first horizon the shown one still connects", () => {
    const d = predictionDataSchema.parse({
      ...pf.okData,
      horizons: [pf.okData.horizons[1], { ...pf.okData.horizons[0], days: 21 }],
    });
    const ds = fanDataset(d)!;
    expect(ds.x).toEqual(["Now", "21 days"]);
    expect(ds.series.every((s) => s.values.every((v) => v !== null))).toBe(true);
  });

  it("the fan info text names the categorical axis", async () => {
    renderTab(pf.okState as Handler);
    await find("pred-fan");
    expect(text("pred-fan")).toMatch(/equal steps, not to scale/);
    expect(text("pred-fan")).toMatch(/hidden horizons are left off/);
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

describe("PREDX-07 unreadable sections never become false domain statements", () => {
  it("wrong types render 'could not be read', never no model / no resolved / not passed", async () => {
    renderTab(pf.unreadableSections as Handler);
    await find("pred-cards-5");
    expect(text("model-card-unreadable")).toMatch(/could not be read/);
    expect(text("track-unreadable")).toMatch(/could not be read/);
    expect(text("pred-trend-unreadable")).toMatch(/could not be read/);
    expect(text("pred-risk-unreadable")).toMatch(/could not be read/);
    const card = screen.getByTestId("pred-card").textContent ?? "";
    expect(card).not.toMatch(/Not passed|No resolved predictions yet|no model has been trained/);
    expect(card).not.toMatch(/does not recognise/);
    expect(screen.queryByTestId("model-guardrail")).toBeNull();
    expect(screen.queryByTestId("track-resolved")).toBeNull();
    expect(console.warn).toHaveBeenCalled();
  });

  it("a shown horizon with an unusable band or an out-of-range p_up says the data could not be read", async () => {
    renderTab(pf.unreadableSections as Handler);
    await find("pred-unreadable-21");
    expect(text("pred-unreadable-21")).toMatch(/could not be read/);
    expect(text("pred-unreadable-21")).not.toMatch(/does not recognise|5,400|%/);
    expect(screen.getByTestId("pred-horizon-21").getAttribute("data-shown")).toBe("false");
  });

  it("fractions outside 0..1 are unreadable, so 54 never renders as 5,400%", () => {
    const d = predictionDataSchema.parse({
      ...pf.okData,
      horizons: [
        { ...pf.okData.horizons[0], p_up: 54 },
        {
          ...pf.okData.horizons[0],
          days: 21,
          track_record: { ...pf.track5, band_coverage_80: 80 },
        },
        { ...pf.okData.horizons[0], days: 63, model: { ...pf.model5, guardrail_pass: null } },
      ],
      track_record: { ...pf.track5, direction_hit_rate: -0.1 },
    });
    const hs = d.horizons as Exclude<typeof d.horizons, typeof UNREADABLE>;
    expect(hs[0]!.p_up).toBe(UNREADABLE);
    expect(hs[1]!.track_record).toBe(UNREADABLE);
    expect(hs[2]!.model).toBe(UNREADABLE);
    expect(d.track_record).toBe(UNREADABLE);
  });

  it("a top-level model and track record that cannot be read show the marker when no horizon has a card", async () => {
    renderTab(
      ok({
        ...pf.okData,
        horizons: [pf.okData.horizons[1]],
        model: [],
        track_record: { resolved: "x" },
      }) as Handler,
    );
    await find("pred-cards");
    expect(text("model-card-unreadable")).toMatch(/could not be read/);
    expect(text("track-unreadable")).toMatch(/could not be read/);
  });

  it("a non-array horizons list and a non-string state are marked, not guessed", async () => {
    renderTab(ok({ ...pf.okData, horizons: "nope", state: 7 }) as Handler);
    await find("pred-horizons-unreadable");
    expect(text("pred-state")).toMatch(/state of the forecast could not be read/);
    expect(screen.queryByTestId("pred-no-horizons")).toBeNull();
  });

  it("horizon entries without usable days are counted, not hidden silently", async () => {
    renderTab(pf.odd as Handler);
    await find("pred-horizons-skipped");
    expect(text("pred-horizons-skipped")).toMatch(/2 horizon entries could not be read/);
  });
});

describe("PRED-04 degrade per field", () => {
  it("odd values never blank the tab; unknown enums fall back to generic copy", async () => {
    renderTab(pf.odd as Handler);
    await find("pred-horizons");
    expect(text("pred-disclaimer")).toBe(pf.DISCLAIMER);
    expect(text("pred-state")).toContain(STATE_FALLBACK);
    expect(text("pred-hidden-21")).toMatch(/does not recognise/);
    // The shown-but-unusable horizon says its data could not be read (not an unknown reason).
    expect(text("pred-unreadable-5")).toMatch(/could not be read/);
    expect(text("pred-unreadable-5")).not.toMatch(/does not recognise/);
    expect(text("pred-trend-unreadable")).toMatch(/could not be read/);
    expect(text("pred-risk-unreadable")).toMatch(/could not be read/);
    expect(text("model-card-unreadable")).toMatch(/could not be read/);
    expect(text("track-unreadable")).toMatch(/could not be read/);
    expect(screen.getByTestId("pred-card").textContent).not.toMatch(/NaN|Infinity|undefined/);
    expect(bucketText("mystery")).toBe("Direction not classified");
  });

  it("track dataset needs resolved predictions and known rates", () => {
    const t = {
      resolved: 0,
      direction_hit_rate: 0.5,
      band_coverage_80: 0.8,
      since: null,
      reason: null,
    };
    expect(trackDataset(t)).toBeNull();
    expect(trackDataset({ ...t, resolved: 9, direction_hit_rate: null })).toBeNull();
  });

  it("PREDX-08 the track chart does not use the tracking start as its as-of", () => {
    const ds = trackDataset({
      resolved: 9,
      direction_hit_rate: 0.514,
      band_coverage_80: 0.77,
      since: "2026-04-01",
      reason: null,
    })!;
    expect(ds.asOf).toBeNull();
    expect(ds.source).toMatch(
      /tracking since 1 Apr 2026|tracking since 2026-04-01|tracking since .*2026/,
    );
    expect(ds.source).toMatch(/as of not served/);
    expect(ds.series[0]!.values).toEqual([51.4, 77]);
  });
});

describe("PREDX-09 repeated days do not collide", () => {
  it("two horizons with the same days render two cards without duplicate-key warnings", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    renderTab(
      ok({
        ...pf.okData,
        horizons: [pf.okData.horizons[0], { ...pf.okData.horizons[0], p_up: 0.6 }],
      }) as Handler,
    );
    await find("pred-horizons");
    expect(screen.getAllByTestId("pred-horizon-5")).toHaveLength(2);
    const ids = [...document.querySelectorAll("[id^=pred-h-]")].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(err.mock.calls.flat().join(" ")).not.toMatch(/same key/);
  });
});

describe("PREDX-10 gauge bands have no gaps (shared with the Overview)", () => {
  const label = (bands: typeof TREND_BANDS, v: number) => {
    const { unmount } = render(<Gauge label="G" value={v} valueText={String(v)} bands={bands} />);
    const name = screen.getByRole("img").getAttribute("aria-label") ?? "";
    unmount();
    return name;
  };
  it("every value from 0 to 100 lands in a trend band, including 20.5", () => {
    const cases: [number, string][] = [
      [0, "Strong down"],
      [20, "Strong down"],
      [20.5, "Down"],
      [40, "Down"],
      [40.5, "Sideways"],
      [60.5, "Up"],
      [80.5, "Strong up"],
      [100, "Strong up"],
    ];
    for (const [v, band] of cases) expect(label(TREND_BANDS, v), String(v)).toMatch(band);
  });
  it("risk bands too", () => {
    for (const [v, band] of [
      [0, "Low"],
      [33.5, "Medium"],
      [66.5, "High"],
    ] as [number, string][]) {
      expect(label(RISK_BANDS, v), String(v)).toMatch(band);
    }
  });
  it("the bands touch end to end", () => {
    for (const bands of [TREND_BANDS, RISK_BANDS]) {
      expect(bands[0]!.from).toBe(0);
      expect(bands.at(-1)!.to).toBe(100);
      bands.slice(1).forEach((b, i) => expect(b.from).toBe(bands[i]!.to));
    }
  });
  it("the Overview imports the shared bands (no private copy)", () => {
    const src = readFileSync(join(__dirname, "../../src/components/stock/OverviewTab.tsx"), "utf8");
    expect(src).toMatch(/from "@\/lib\/stock\/gauge-bands"/);
    expect(src).not.toMatch(/const TREND_BANDS/);
  });
});

describe("PRED-05 states: error with retry, stale", () => {
  it("error shows the message and a retry that refetches", async () => {
    const mock = renderTab(fail(500, "INTERNAL", "prediction exploded"));
    const err = await find("pred-error");
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
    await find("pred-bucket-5");
    expect(text("pred-meta")).toMatch(/\(stale\)/);
  });
});
