import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { AlertShortcuts } from "@/components/stock/chart/AlertShortcuts";
import { AnalysisTab } from "@/components/stock/chart/AnalysisTab";
import { ToastProvider } from "@/components/ui/overlays";
import { levelBelow, shortcutRows } from "@/lib/alerts/levels";
import { parseInvBlocks, positionSchema, type Position } from "@/lib/stock/inv-schemas";
import type { Load } from "@/lib/stock/load";
import type { IndicatorsData } from "@/lib/stock/schemas";
import { fail, ok } from "../mocks/imports-fixtures";
import { indicatorsWithInv } from "../mocks/inv-fixtures";
import { swingDips } from "../mocks/swing-fixtures";
import { parseSwingDips } from "@/lib/stock/swing-schemas";
import { createMockFetch, type Handler } from "../mocks/mock-fetch";
import "./dom-matchers";

vi.setConfig({ testTimeout: 30_000 });
vi.mock("@/components/charts/EChart", () => ({
  EChart: ({ label }: { label: string }) => (
    <div role="img" aria-label={label} data-testid="chart-canvas" data-ready="true" />
  ),
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

afterEach(() => vi.unstubAllGlobals());
beforeAll(async () => {
  await import("@/components/stock/chart/InvCards");
}, 60_000);

const analysisOf = () =>
  (indicatorsWithInv().body as { data: IndicatorsData & { analysis: Record<string, unknown> } })
    .data;

function position(over: Record<string, unknown> = {}): Position {
  const base = (analysisOf().analysis as { position: Record<string, unknown> }).position;
  return positionSchema.parse({ ...base, ...over });
}

const ready = (data: IndicatorsData = analysisOf()): Load<IndicatorsData> => ({
  state: "ready",
  data,
  asOf: "2024-02-15",
  stale: false,
});

const alertRow = {
  id: 1,
  target: { type: "stock", symbol: "ACME", name: "Acme Ltd" },
  kind: "price_below",
  params: { price: 1035 },
  status: "active",
  one_shot: true,
  cooldown_minutes: 1440,
  expires_on: null,
  last_fired_at: null,
  created_at: "2026-11-12T04:00:00Z",
};

function renderCard(pos: Position, routes: Record<string, Handler> = {}) {
  const mock = createMockFetch({ "POST /alerts": ok(alertRow, 201), ...routes });
  vi.stubGlobal("fetch", mock.impl);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <AlertShortcuts
          symbol="ACME"
          load={ready()}
          blocks={{ position: { kind: "ok", value: pos } }}
        />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { mock, view };
}

describe("ALS-01 levels use decimal arithmetic, rounded half up to 2 decimals", () => {
  it("10% and 20% below the 52-week highest close", () => {
    expect(levelBelow(1150, 10)).toBe("1035.00");
    expect(levelBelow(1150, 20)).toBe("920.00");
    expect(levelBelow(1150.05, 10)).toBe("1035.05"); // 1035.045 exactly, half up
    expect(levelBelow(1.005, 0)).toBe("1.01"); // toFixed(2) would give 1.00
    expect(levelBelow(0, 10)).toBeNull();
  });

  it("the 200-day average is used as given, rounded the same way", () => {
    const rows = shortcutRows(position({ close: 14, sma200: 13.335 }));
    const sma = rows.find((r) => r.key === "sma200");
    expect(sma?.action?.level).toBe("13.34");
  });
});

describe("ALS-02 / ALS-03 / ALS-04 rows", () => {
  it("the 200-day row follows the last close and says which way", () => {
    const above = shortcutRows(position({ close: 14, sma200: 13.3333 })).find(
      (r) => r.key === "sma200",
    );
    expect(above?.action).toMatchObject({ kind: "price_below", level: "13.33" });
    expect(above?.action?.button).toContain("falls to");
    const below = shortcutRows(position({ close: 12, sma200: 13.3333 })).find(
      (r) => r.key === "sma200",
    );
    expect(below?.action).toMatchObject({ kind: "price_above", level: "13.33" });
    expect(below?.action?.button).toContain("rises to");
    const equal = shortcutRows(position({ close: 13.33, sma200: 13.33 })).find(
      (r) => r.key === "sma200",
    );
    expect(equal?.action).toBeNull();
    expect(equal?.reason).toContain("equals");
  });

  it("missing facts give a reason and no button", () => {
    const rows = shortcutRows(position({ high_52w_close: null, sma200: null }));
    for (const r of rows) {
      expect(r.action).toBeNull();
      expect(r.reason).toBeTruthy();
    }
    expect(rows.find((r) => r.key === "sma200")?.reason).toContain("needs 200 days of prices");
  });

  it("each button carries the exact level, each row its source and as-of, and no advice words", () => {
    const rows = shortcutRows(position({ high_52w_close: 1150, close: 1100, sma200: 1000 }));
    expect(rows).toHaveLength(4);
    const b10 = rows.find((r) => r.key === "below-10")!;
    expect(b10.action?.button).toBe("Alert when the price falls to ₹1,035.00 or lower");
    expect(b10.source).toContain("52-week highest close ₹1,150.00");
    expect(b10.source).toContain("as of ");
    for (const r of rows) {
      expect(
        `${r.label} ${r.action?.button ?? ""} ${r.source ?? ""} ${r.reason ?? ""}`,
      ).not.toMatch(/\b(buy|sell|target|recommend)/i);
    }
  });
});

describe("the card in the Analysis tab", () => {
  it("is shown for a symbol, without one it is absent", async () => {
    const mk = (symbol?: string) => (
      <QueryClientProvider client={new QueryClient()}>
        <AnalysisTab indicatorsLoad={ready()} {...(symbol ? { symbol } : {})} />
      </QueryClientProvider>
    );
    const first = render(mk());
    await screen.findByTestId("inv-position");
    expect(screen.queryByTestId("als-card")).toBeNull();
    first.unmount();
    render(mk("ACME"));
    expect(await screen.findByTestId("als-card")).toBeInTheDocument();
    expect(await screen.findByTestId("als-btn-below-10")).toBeInTheDocument();
  });

  it("shows loading, not-computed and error states", () => {
    const blocks = parseInvBlocks({});
    const client = new QueryClient();
    const wrap = (load: Load<IndicatorsData>) => (
      <QueryClientProvider client={client}>
        <AlertShortcuts symbol="ACME" load={load} blocks={blocks} />
      </QueryClientProvider>
    );
    const r = render(wrap({ state: "loading" }));
    expect(screen.getByTestId("als-card")).toHaveAttribute("data-state", "loading");
    r.rerender(wrap(ready()));
    expect(screen.getByText(/Not computed yet/)).toBeInTheDocument();
    expect(screen.queryByTestId("als-btn-below-10")).toBeNull();
  });
});

describe("ALS-05 / ALS-06 / ALS-07 the alert form from a shortcut", () => {
  it("opens the existing form with symbol, kind and price filled, and creates the alert", async () => {
    const user = userEvent.setup();
    const { mock } = renderCard(position({ high_52w_close: 1150, close: 1100, sma200: 1000 }));
    const btn = screen.getByTestId("als-btn-below-10");
    expect(btn).toHaveTextContent("₹1,035.00");
    await user.click(btn);
    const form = await screen.findByTestId("alert-form");
    expect((within(form).getByTestId("alert-symbol") as HTMLInputElement).value).toBe("ACME");
    expect((within(form).getByTestId("alert-kind") as HTMLInputElement).value).toBe("price_below");
    expect((within(form).getByTestId("alert-param-price") as HTMLInputElement).value).toBe(
      "1035.00",
    );
    await user.click(within(form).getByTestId("alert-submit"));
    await waitFor(() =>
      expect(mock.calls.some((c) => c.method === "POST" && c.path === "/alerts")).toBe(true),
    );
    const call = mock.calls.find((c) => c.method === "POST")!;
    expect(call.body).toEqual({
      target: { type: "stock", symbol: "ACME" },
      kind: "price_below",
      params: { price: 1035 },
      one_shot: true,
    });
    expect(await screen.findByText("Alert created.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId("alert-form")).toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId("als-btn-below-10")),
    );
  });

  it("the server rule stays the backstop: a 422 THRESHOLD_ALREADY_MET still shows the plain message", async () => {
    const user = userEvent.setup();
    const { mock } = renderCard(position({ high_52w_close: 1150, close: 1100, sma200: 1000 }), {
      "POST /alerts": fail(422, "THRESHOLD_ALREADY_MET", "already met", {
        kind: "price_below",
        threshold: 1035,
        value: 900,
        as_of: "2026-11-10",
      }),
    });
    await user.click(screen.getByTestId("als-btn-below-10"));
    const form = await screen.findByTestId("alert-form");
    await user.click(within(form).getByTestId("alert-submit"));
    expect(
      await within(form).findByText(/Already true at the last imported bar of 10 Nov 2026/),
    ).toBeInTheDocument();
    expect(mock.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("the Alerts page form is unchanged and starts empty (no prefill)", async () => {
    vi.stubGlobal("fetch", createMockFetch({}).impl);
    const { AlertForm } = await import("@/components/alerts/AlertForm");
    render(
      <QueryClientProvider client={new QueryClient()}>
        <AlertForm onDone={() => undefined} />
      </QueryClientProvider>,
    );
    expect((screen.getByTestId("alert-symbol") as HTMLInputElement).value).toBe("");
    expect((screen.getByTestId("alert-kind") as HTMLInputElement).value).toBe("price_above");
    expect((screen.getByTestId("alert-param-price") as HTMLInputElement).value).toBe("");
  });

  it("Escape closes the drawer without creating anything", async () => {
    const user = userEvent.setup();
    const { mock } = renderCard(position({ high_52w_close: 1150, close: 1100, sma200: 1000 }));
    await user.click(screen.getByTestId("als-btn-below-20"));
    await screen.findByTestId("alert-form");
    await act(async () => {
      document
        .querySelector("dialog[open]")
        ?.dispatchEvent(new Event("cancel", { cancelable: true }));
    });
    await waitFor(() => expect(screen.queryByTestId("alert-form")).toBeNull());
    expect(mock.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });
});

describe("S2 levels the last close already satisfies get no button", () => {
  it("drops the price_below button when close is at or below the level and says why", () => {
    const rows = shortcutRows(
      position({ high_52w_close: 1150, close: 1000, sma200: 900, as_of: "2026-11-10" }),
    );
    const b10 = rows.find((r) => r.key === "below-10")!; // level 1035.00
    expect(b10.action).toBeNull();
    expect(b10.reason).toBe(
      "The last close (\u20b91,000.00, as of 10 Nov 2026) is already at or below this level.",
    );
    expect(rows.find((r) => r.key === "below-20")!.action).not.toBeNull(); // level 920.00
    const equal = shortcutRows(position({ high_52w_close: 1150, close: 1035, sma200: 900 })).find(
      (r) => r.key === "below-10",
    )!;
    expect(equal.action).toBeNull();
  });
});

describe("S3 source label", () => {
  it("says the prices are adjusted for splits and bonuses", () => {
    const rows = shortcutRows(position({ high_52w_close: 1150, close: 1100, sma200: 1000 }));
    for (const r of rows.filter((x) => x.source && x.key !== "dip-low")) {
      expect(r.source).toContain("adjusted for splits and bonuses");
    }
  });
});

describe("ALS-1 dip-low row (item A swing dips)", () => {
  const swingOf = (patch?: (d: Record<string, unknown>) => void) => {
    const d = swingDips();
    patch?.(d);
    return parseSwingDips({ swing_dips: d }).block;
  };
  const pos = (close: number) => position({ close, high_52w_close: 120, sma200: 50 });
  const dip = (rows: ReturnType<typeof shortcutRows>) => rows.find((r) => r.key === "dip-low")!;
  const rec0 = (d: Record<string, unknown>) =>
    (d["thresholds"] as Array<{ records: Array<Record<string, unknown>> }>)[0]!.records[0]!;

  it("an open dip with the close above its low offers price_below at the low", () => {
    const row = dip(shortcutRows(pos(100), swingOf())); // low_close 94 on 2024-01-14
    expect(row.action).toEqual({
      kind: "price_below",
      level: "94.00",
      button: "Alert when the price falls to \u20b994.00 or lower",
    });
    expect(row.label).toMatch(/^Deepest close of the current dip, ₹94\.00 \(on \d+ Jan 2024\)$/);
    expect(row.source).toMatch(/^Low close ₹94\.00 on \d+ Jan 2024, as of /);
    expect(row.source).toContain("adjusted for splits and bonuses");
  });

  it("no open dip: no button, a reason", () => {
    const row = dip(
      shortcutRows(
        pos(100),
        swingOf((d) => {
          rec0(d)["status"] = "recovered";
        }),
      ),
    );
    expect(row.action).toBeNull();
    expect(row.reason).toContain("no open dip");
  });

  it("close equal to the low: no button, a reason", () => {
    const row = dip(shortcutRows(pos(94), swingOf()));
    expect(row.action).toBeNull();
    expect(row.reason).toContain("equals the dip low");
  });

  it("missing or malformed swing block degrades to a reason", () => {
    expect(dip(shortcutRows(pos(100))).reason).toContain("not computed yet");
    expect(dip(shortcutRows(pos(100), parseSwingDips({}).block)).action).toBeNull();
    expect(dip(shortcutRows(pos(100), parseSwingDips({ swing_dips: "x" }).block)).reason).toContain(
      "unexpected shape",
    );
  });

  it("an unknown status (for example superseded) offers no button", () => {
    const row = dip(
      shortcutRows(
        pos(100),
        swingOf((d) => {
          rec0(d)["status"] = "superseded";
        }),
      ),
    );
    expect(row.action).toBeNull();
    expect(row.reason).toContain("not known");
  });

  it("no 10% threshold row or no records: a reason", () => {
    const row = dip(
      shortcutRows(
        pos(100),
        swingOf((d) => {
          (d["thresholds"] as unknown[]).length = 0;
        }),
      ),
    );
    expect(row.action).toBeNull();
  });
});
