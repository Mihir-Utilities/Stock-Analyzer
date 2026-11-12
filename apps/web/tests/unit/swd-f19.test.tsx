import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error plain .mjs generator without type declarations
import { buildDefinitions, SPEC_PATH } from "../../scripts/gen-definitions.mjs";
import { AnalysisTab } from "@/components/stock/chart/AnalysisTab";
import { definitions } from "@/lib/definitions";
import type { Load } from "@/lib/stock/load";
import type { IndicatorsData } from "@/lib/stock/schemas";
import { parseSwingDips } from "@/lib/stock/swing-schemas";
import { indicatorsWithInv } from "../mocks/inv-fixtures";
import { swingDips } from "../mocks/swing-fixtures";
import "./dom-matchers";

vi.setConfig({ testTimeout: 30_000 });
vi.mock("@/components/charts/EChart", () => ({
  EChart: ({ label }: { label: string }) => (
    <div role="img" aria-label={label} data-testid="chart-canvas" data-ready="true" />
  ),
}));

const web = process.cwd();

beforeAll(async () => {
  await Promise.all([
    import("@/components/stock/chart/InvCards"),
    import("@/components/stock/chart/SwingDipsCard"),
  ]);
}, 60_000);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2024-02-15T10:00:00+05:30"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

type Patch = (a: Record<string, unknown>) => Record<string, unknown>;

function dataOf(patch: Patch = (a) => ({ ...a, swing_dips: swingDips() })): IndicatorsData {
  return (indicatorsWithInv(patch).body as { data: IndicatorsData }).data;
}
const ready = (data: IndicatorsData): Load<IndicatorsData> => ({
  state: "ready",
  data,
  asOf: "2024-02-15",
  stale: false,
});

async function renderTab(patch?: Patch) {
  const r = render(<AnalysisTab indicatorsLoad={ready(dataOf(patch))} />);
  await screen.findByTestId("inv-position");
  await screen.findByTestId("inv-swing");
  return r;
}
const text = (el: HTMLElement) => el.textContent ?? "";

describe("Swing dips card (SWD-U)", () => {
  it("SWD-U01: renders beside the unchanged Drawdown profile with the summary per fall size", async () => {
    await renderTab();
    expect(screen.getByTestId("inv-drawdown")).toBeInTheDocument();
    const card = screen.getByTestId("inv-swing");
    expect(card).toHaveTextContent("Swing dips");
    const r10 = within(card).getByTestId("inv-swing-row-10");
    const cells = Array.from(r10.querySelectorAll("td")).map((c) => text(c));
    expect(cells[0]).toBe("3"); // dips
    expect(cells[1]).toBe("2"); // recovered
    expect(cells[2]).toBe("1"); // still open
    expect(cells[3]).toContain("66.7%"); // recovered share
    expect(cells[4]).toContain("-11.5%"); // median depth
    expect(cells[5]).toContain("-15.0%"); // worst depth
    expect(cells[6]).toContain("2.0 days"); // median days peak to low
    expect(cells[8]).toContain("2 days"); // longest open
    const r20 = within(card).getByTestId("inv-swing-row-20");
    expect(r20).toHaveTextContent("no dip of this size");
  });

  it("SWD-U02: the open dip is labelled in text and counted", async () => {
    await renderTab();
    const card = screen.getByTestId("inv-swing");
    expect(within(card).getByTestId("inv-swing-open-count-10")).toHaveTextContent("1");
    const open = within(card).getByTestId("inv-swing-open");
    expect(open).toHaveTextContent("Open");
    const row = open.closest("tr")!;
    expect(row).toHaveAttribute("data-status", "open");
    expect(row).toHaveTextContent("not recovered yet (open for 2 days since the peak)");
    const rows = within(card).getAllByTestId("inv-swing-record");
    expect(rows).toHaveLength(3); // newest first: open, recovered, recovered
    expect(rows[0]).toHaveAttribute("data-status", "open");
    expect(rows[1]).toHaveTextContent("13 Jan 2024");
    expect(within(card).getByTestId("inv-swing-records-count")).toHaveTextContent(
      "Showing the last 3 of 3 dips of at least 10%.",
    );
  });

  it("SWD-U03: hidden figures are an em dash with the reason as hidden text and as a list", async () => {
    await renderTab();
    const card = screen.getByTestId("inv-swing");
    const r10 = within(card).getByTestId("inv-swing-row-10");
    const recover = r10.querySelectorAll("td")[7]!;
    expect(text(recover)).toContain("—");
    expect(recover.querySelector(".sr-only")).toHaveTextContent(
      "only 2 recovered dips; at least 3 are needed",
    );
    expect(within(card).getByTestId("inv-swing-reasons")).toHaveTextContent(
      "10% fall: only 2 recovered dips; at least 3 are needed",
    );
    expect(text(card)).not.toMatch(/NaN|Infinity|undefined/);
    // The 20% row never shows a bare 0 for an unknown figure: counts are real zeros, figures are dashes.
    const r20 = within(card).getByTestId("inv-swing-row-20");
    expect(r20).toHaveTextContent("no dip of this size in the history");
  });

  it("SWD-U04: sample size, Small sample chip, How to read and the past-behaviour line", async () => {
    await renderTab();
    const card = screen.getByTestId("inv-swing");
    expect(within(card).getByTestId("inv-swing-sample")).toHaveTextContent(
      "Based on 3 dips of at least 10% and 0 dips of at least 20% in 15 daily closes.",
    );
    expect(within(card).getByTestId("inv-swing-small")).toBeInTheDocument();
    const howto = within(card).getByTestId("inv-swing-howto");
    expect(howto.tagName).toBe("DETAILS");
    expect(howto).toHaveTextContent("calendar days");
    expect(within(card).getByTestId("inv-swing-note")).toHaveTextContent(
      "Past behaviour is not a forecast.",
    );
    expect(within(card).getByTestId("source-chip")).toBeInTheDocument();
    expect(within(card).getByTestId("asof-chip")).toHaveTextContent("2024");
  });

  it("SWD-U05: says how it differs from the all-time-high view", async () => {
    await renderTab();
    const s = screen.getByTestId("inv-swing-differs");
    expect(s).toHaveTextContent("drawdown profile");
    expect(s).toHaveTextContent("highest close in your history");
    expect(s).toHaveTextContent("52-week high");
  });

  it("SWD-U06: missing block, compute_error, wrong shape and insufficient history", async () => {
    const { unmount } = await renderTab((a) => a);
    expect(screen.getByTestId("inv-swing")).toHaveTextContent(
      "Not computed yet. It will appear after the next price import.",
    );
    unmount();

    const err = await renderTab((a) => ({
      ...a,
      swing_dips: null,
      swing_dips_reason: "compute_error",
    }));
    expect(screen.getByTestId("inv-swing")).toHaveTextContent("could not be computed");
    expect(screen.getByTestId("inv-swing")).toHaveTextContent("compute_error");
    expect(screen.getByTestId("inv-position")).toBeInTheDocument(); // the others are unaffected
    err.unmount();

    const bad = await renderTab((a) => ({ ...a, swing_dips: "oops" }));
    expect(screen.getByTestId("inv-swing")).toHaveTextContent("unexpected shape");
    expect(screen.getByTestId("inv-drawdown")).not.toHaveTextContent("unexpected shape");
    bad.unmount();

    const short = await renderTab((a) => {
      const empty = (x: number) => ({
        threshold_pct: x,
        dips: null,
        recovered: null,
        open: null,
        small_sample: true,
        reason: "insufficient_history",
        records: [],
      });
      return {
        ...a,
        swing_dips: {
          as_of: "2024-02-15",
          bars: 100,
          window_rows: 252,
          thresholds: [empty(10), empty(20)],
          zigzag: [],
        },
      };
    });
    const card = screen.getByTestId("inv-swing");
    expect(within(card).getByTestId("inv-swing-row-10")).toHaveTextContent(
      "Needs about a year of prices (252 trading days).",
    );
    expect(within(card).getByTestId("inv-swing-records-empty")).toHaveTextContent(
      "252 trading days",
    );
    short.unmount();
  });

  it("SWD-U07: a bad value degrades one cell, a bad row does not blank the table", () => {
    const b = swingDips() as { thresholds: Array<Record<string, unknown>> };
    const first = b.thresholds[0]!;
    const parsed = parseSwingDips({
      swing_dips: {
        ...b,
        thresholds: [
          { ...first, median_depth_pct: "deep", worst_depth_pct: Infinity },
          42,
          b.thresholds[1],
        ],
      },
    });
    expect(parsed.block.kind).toBe("ok");
    if (parsed.block.kind === "ok") {
      const rows = parsed.block.value.thresholds;
      expect(rows).toHaveLength(2);
      expect(rows[0]!.median_depth_pct).toBeNull();
      expect(rows[0]!.worst_depth_pct).toBeNull();
      expect(rows[0]!.dips).toBe(3);
    }
    expect(parseSwingDips(undefined).block.kind).toBe("missing");
  });

  it("SWD-U08: the 10% / 20% choice switches the last-dips table", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await renderTab();
    const card = screen.getByTestId("inv-swing");
    const pick = within(card).getByTestId("inv-swing-pick-select") as HTMLSelectElement;
    expect(pick.value).toBe("10");
    await user.selectOptions(pick, "20");
    expect(within(card).getByTestId("inv-swing-records-empty")).toHaveTextContent(
      "No dip of 20% or more in this history.",
    );
    await user.selectOptions(pick, "10");
    expect(within(card).getAllByTestId("inv-swing-record")).toHaveLength(3);
  });

  it("SWD-U09: the swing legs rows and the caption that a bounce is not a recovery", async () => {
    await renderTab();
    const legs = screen.getByTestId("inv-swing-legs");
    const r10 = within(legs).getByTestId("inv-swing-leg-row-10");
    const cells = Array.from(r10.querySelectorAll("td")).map((c) => text(c));
    expect(cells.slice(0, 3)).toEqual(["4", "3", "1"]);
    expect(cells[3]).toContain("-22.2%");
    expect(cells[4]).toContain("-24.2%");
    expect(cells[6]).toContain("1.0 days");
    expect(within(legs).getByTestId("inv-swing-legs-note")).toHaveTextContent(
      "A bounce is not a recovery of the old high",
    );
    expect(within(legs).getByTestId("inv-swing-leg-row-20")).toHaveTextContent("only 1 swing;");
  });

  it("SWD-U10: the definition is generated from docs/05 12.13 and names no ids", () => {
    const spec = readFileSync(SPEC_PATH as string, "utf8");
    expect(readFileSync(join(web, "src/lib/definitions.ts"), "utf8").replace(/\r\n/g, "\n")).toBe(
      buildDefinitions(spec),
    );
    const t = definitions.swing_dips.text;
    expect(t.length).toBeGreaterThan(30);
    expect(t).not.toMatch(/SWD|\bsection\b|docs\/|\b[a-z]+_[a-z_]+\b|\*\*|`/);
  });

  it("SWD-U11: the card is loaded on demand and never calls the network", () => {
    const src = readFileSync(join(web, "src/components/stock/chart/AnalysisTab.tsx"), "utf8");
    expect(src).toMatch(/dynamic\(\(\) => import\("\.\/SwingDipsCard"\)/);
    const card = readFileSync(join(web, "src/components/stock/chart/SwingDipsCard.tsx"), "utf8");
    expect(card).not.toMatch(/fetch\(|XMLHttpRequest|style=\{\{|#[0-9a-fA-F]{3,6}\b/);
  });
});
