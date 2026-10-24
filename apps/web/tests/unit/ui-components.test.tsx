import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExperimentalBanner } from "@/components/ui/banners";
import { AsOfChip } from "@/components/ui/chips";
import { Card } from "@/components/ui/Card";
import * as csv from "@/components/ui/csv";
import { DataTable, type DataColumn } from "@/components/ui/DataTable";
import { DeltaBadge } from "@/components/ui/DeltaBadge";
import { FormField } from "@/components/ui/FormField";
import { Gauge } from "@/components/ui/Gauge";
import { heatColor, Heatmap } from "@/components/ui/Heatmap";
import { ConfirmDialog, Tabs, ToastProvider, useToast } from "@/components/ui/overlays";
import { RangeBar, rangePosition } from "@/components/ui/RangeBar";
import { Sparkline, sparklinePoints } from "@/components/ui/Sparkline";
import { Stat } from "@/components/ui/Stat";
import { Timeline } from "@/components/ui/Timeline";
import { Wizard } from "@/components/ui/Wizard";

afterEach(() => vi.restoreAllMocks());

interface Row {
  id: string;
  name: string;
  pe: number | null;
  hist: number[];
}
const cols: DataColumn<Row>[] = [
  { id: "name", header: "Name", value: (r) => r.name },
  {
    id: "pe",
    header: "P/E",
    kind: "num",
    value: (r) => r.pe,
    display: (r) => (r.pe === null ? null : r.pe.toFixed(1)),
    nullReason: "Loss-making",
  },
  { id: "bar", header: "Bar", kind: "databar", max: 100, value: (r) => r.pe },
  { id: "trend", header: "Trend", kind: "sparkline", value: () => null, spark: (r) => r.hist },
];
const rows = (n: number): Row[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `r${i}`,
    name: i === 0 ? "=EVIL()" : `Co ${i}`,
    pe: i === 1 ? null : i,
    hist: [1, 2, 3],
  }));

describe("DataTable", () => {
  it("shows a reason for null cells and never 0", () => {
    render(<DataTable label="T" columns={cols} rows={rows(3)} rowKey={(r) => r.id} />);
    expect(screen.getAllByTestId("null-cell")[0]?.textContent).toContain("Loss-making");
    expect(screen.getAllByTestId("databar").length).toBeGreaterThan(0);
    expect(screen.getAllByTestId("sparkline").length).toBe(3);
  });

  it("sorts with nulls last and exposes aria-sort", async () => {
    render(<DataTable label="T" columns={cols} rows={rows(4)} rowKey={(r) => r.id} />);
    // TanStack sorts numbers descending on the first click.
    await userEvent.click(screen.getByTestId("sort-pe"));
    const first = screen.getAllByTestId("data-row")[0];
    expect(first && within(first).getAllByRole("gridcell")[1]?.textContent).toBe("3.0");
    const last = screen.getAllByTestId("data-row").at(-1);
    expect(last && within(last).getAllByTestId("null-cell")[0]).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: /P\/E/ }).getAttribute("aria-sort")).toBe(
      "descending",
    );
  });

  it("UI-18 virtualizes above 100 rows", () => {
    // jsdom has no layout; give the scroll box a size so the virtualizer has a window.
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(480);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
    render(<DataTable label="T" columns={cols} rows={rows(1000)} rowKey={(r) => r.id} />);
    expect(screen.getAllByTestId("data-row").length).toBeLessThan(100);
    expect(screen.getByTestId("data-table-count").textContent).toContain("1000");
  });

  it("does not virtualize at 100 rows or fewer", () => {
    render(<DataTable label="T" columns={cols} rows={rows(100)} rowKey={(r) => r.id} />);
    expect(screen.getAllByTestId("data-row")).toHaveLength(100);
  });

  it("IMP-15: CSV export prefixes dangerous cells", async () => {
    const spy = vi.spyOn(csv, "downloadCsv").mockImplementation(() => {});
    render(
      <DataTable
        label="T"
        columns={cols}
        rows={rows(3)}
        rowKey={(r) => r.id}
        csvFilename="x.csv"
      />,
    );
    await userEvent.click(screen.getByTestId("data-table-export"));
    const text = spy.mock.calls[0]?.[0] ?? "";
    expect(text).toContain("'=EVIL()");
    expect(spy.mock.calls[0]?.[1]).toBe("x.csv");
  });

  it("roving keyboard navigation moves between cells", async () => {
    render(<DataTable label="T" columns={cols} rows={rows(5)} rowKey={(r) => r.id} />);
    const cells = screen.getAllByRole("gridcell");
    cells[0]?.focus();
    await userEvent.keyboard("{ArrowRight}");
    await vi.waitFor(() => expect(document.activeElement?.getAttribute("data-c")).toBe("1"));
    await userEvent.keyboard("{ArrowDown}");
    await vi.waitFor(() => expect(document.activeElement?.getAttribute("data-r")).toBe("1"));
  });

  it("renders loading, empty and error states", async () => {
    const retry = vi.fn();
    const { rerender } = render(
      <DataTable label="T" columns={cols} rows={[]} rowKey={(r) => r.id} state="loading" />,
    );
    expect(screen.getByTestId("data-table-loading")).toBeTruthy();
    rerender(<DataTable label="T" columns={cols} rows={[]} rowKey={(r) => r.id} />);
    expect(screen.getByTestId("empty-state")).toBeTruthy();
    rerender(
      <DataTable
        label="T"
        columns={cols}
        rows={[]}
        rowKey={(r) => r.id}
        state="error"
        onRetry={retry}
      />,
    );
    await userEvent.click(screen.getByTestId("data-table-retry"));
    expect(retry).toHaveBeenCalled();
  });

  it("density toggle changes row height", async () => {
    render(<DataTable label="T" columns={cols} rows={rows(3)} rowKey={(r) => r.id} />);
    expect(screen.getAllByTestId("data-row")[0]?.style.height).toBe("36px");
    await userEvent.click(screen.getByTestId("data-table-density"));
    expect(screen.getAllByTestId("data-row")[0]?.style.height).toBe("44px");
  });
});

describe("small components", () => {
  it("Stat shows a reason instead of an unknown value", () => {
    render(
      <Stat
        label="P/E"
        value={null}
        nullReason="Loss-making"
        source="Owner entry"
        asOf="2025-03-31"
      />,
    );
    expect(screen.getByTestId("stat-null").textContent).toContain("Loss-making");
    expect(screen.queryByTestId("stat-value")).toBeNull();
    expect(screen.getByText(/Source: Owner entry/)).toBeTruthy();
  });

  it("DeltaBadge is neutral for zero and unknown, never NaN", () => {
    const { rerender } = render(<DeltaBadge value={0} text="0.00%" />);
    expect(screen.getByTestId("delta-badge").dataset["direction"]).toBe("flat");
    rerender(<DeltaBadge value={Number.NaN} text="NaN%" />);
    expect(screen.getByTestId("delta-badge").textContent).toBe("n/a");
    rerender(<DeltaBadge value={-1.2} text="-1.20%" />);
    expect(screen.getByTestId("delta-badge").dataset["direction"]).toBe("down");
  });

  // UI-17: NaN / Infinity / null never render as 0, NaN or Infinity (chart cases: chart-frame.test).
  it("UI-17 Sparkline ignores NaN, Infinity and null and says n/a when under two points remain", () => {
    for (const values of [
      [Number.NaN, Number.NaN, Number.NaN],
      [1, Number.POSITIVE_INFINITY, null],
      [null, null],
    ]) {
      const { unmount } = render(<Sparkline values={values} label="x" />);
      expect(screen.getByTestId("sparkline-empty").textContent).toBe("n/a");
      unmount();
    }
    const { container } = render(<Sparkline values={[1, Number.NaN, 3, null, 5]} label="x" />);
    expect(container.innerHTML).not.toMatch(/NaN|Infinity/);
  });

  it("UI-17 RangeBar shows the reason for NaN, Infinity and inverted ranges", () => {
    const cases: Array<[number | null, number | null, number | null]> = [
      [Number.NaN, 20, 15],
      [10, Number.POSITIVE_INFINITY, 15],
      [10, 20, Number.NEGATIVE_INFINITY],
      [20, 20, 20],
    ];
    for (const [low, high, value] of cases) {
      const { unmount, container } = render(
        <RangeBar
          low={low}
          high={high}
          value={value}
          lowText={null}
          highText={null}
          valueText={null}
          nullReason="Reason"
        />,
      );
      expect(screen.getByTestId("range-bar-null").textContent).toContain("Reason");
      expect(screen.queryByTestId("range-bar-marker")).toBeNull();
      expect(container.innerHTML).not.toMatch(/NaN|Infinity/);
      unmount();
    }
  });

  it("UI-17 Heatmap prints n/a (never NaN or Infinity) for non-finite cells", () => {
    render(
      <Heatmap
        label="Monthly returns"
        rows={["2024"]}
        columns={["Jan", "Feb", "Mar"]}
        cells={[
          [
            { value: Number.NaN, text: "NaN%" },
            { value: Number.POSITIVE_INFINITY, text: "Infinity%" },
            { value: null, text: null },
          ],
        ]}
        maxAbs={5}
        legend={{ negative: "-5%", positive: "+5%" }}
      />,
    );
    expect(screen.getAllByTestId("heat-cell").map((c) => c.textContent)).toEqual([
      "n/a",
      "n/a",
      "n/a",
    ]);
  });

  it("Sparkline with fewer than two points says n/a", () => {
    render(<Sparkline values={[1, null, Number.NaN]} label="x" />);
    expect(screen.getByTestId("sparkline-empty")).toBeTruthy();
    expect(sparklinePoints([5, 5, 5], 90, 30).every((p) => p.y === 15)).toBe(true);
  });

  it("Gauge and RangeBar show reasons for null", () => {
    const bands = [
      { from: 0, to: 40, label: "Weak", tone: "down" as const },
      { from: 40, to: 100, label: "Strong", tone: "up" as const },
    ];
    const { rerender } = render(
      <Gauge
        label="Quality"
        value={null}
        valueText={null}
        bands={bands}
        nullReason="Needs 4 quarters"
      />,
    );
    expect(screen.getByTestId("gauge-null").textContent).toContain("Needs 4 quarters");
    rerender(<Gauge label="Quality" value={72} valueText="72" bands={bands} />);
    expect(screen.getByTestId("gauge-band").textContent).toBe("Strong");
    expect(rangePosition(10, 20, 15)).toBe(50);
    expect(rangePosition(20, 10, 15)).toBeNull();
    render(
      <RangeBar
        low={null}
        high={20}
        value={15}
        lowText={null}
        highText="20"
        valueText="15"
        nullReason="No 52-week data"
      />,
    );
    expect(screen.getByTestId("range-bar-null").textContent).toContain("No 52-week data");
  });

  it("Heatmap prints every value and a reason for unknown cells", () => {
    render(
      <Heatmap
        label="Monthly returns"
        rows={["2024"]}
        columns={["Jan", "Feb"]}
        cells={[
          [
            { value: 2, text: "+2.0%" },
            { value: null, text: null },
          ],
        ]}
        maxAbs={5}
        legend={{ negative: "-5%", positive: "+5%" }}
      />,
    );
    expect(screen.getAllByTestId("heat-cell").map((c) => c.textContent)).toEqual(["+2.0%", "n/a"]);
    expect(heatColor(null, 5)).toBeUndefined();
    expect(heatColor(Number.POSITIVE_INFINITY, 5)).toBeUndefined();
  });

  it("Card states render and stale is worded", () => {
    const { rerender } = render(<Card title="C" state="loading" />);
    expect(screen.getAllByTestId("skeleton").length).toBeGreaterThan(0);
    rerender(
      <Card title="C" state="stale" source="AMFI" asOf="2025-01-01">
        body
      </Card>,
    );
    expect(screen.getByTestId("asof-chip").textContent).toContain("stale");
    rerender(
      <Card title="C" state="partial" message="3 of 5 quarters">
        body
      </Card>,
    );
    expect(screen.getByTestId("banner").textContent).toContain("3 of 5");
  });

  it("AsOfChip says unknown rather than blank", () => {
    render(<AsOfChip asOf={null} />);
    expect(screen.getByTestId("asof-chip").textContent).toContain("unknown");
  });

  it("ExperimentalBanner has no dismiss control", () => {
    render(<ExperimentalBanner />);
    expect(within(screen.getByTestId("experimental-banner")).queryByRole("button")).toBeNull();
  });

  it("FormField links hint and error to the control", () => {
    render(
      <FormField label="Price" hint="Per share" unit="INR" error="Must be positive">
        {(p) => <input {...p} />}
      </FormField>,
    );
    const input = screen.getByLabelText("Price");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")?.split(" ")).toHaveLength(2);
  });

  it("Timeline empty state and items", () => {
    const { rerender } = render(<Timeline items={[]} />);
    expect(screen.getByTestId("empty-state")).toBeTruthy();
    rerender(<Timeline items={[{ id: "1", date: "2025-01-01", kind: "Split", title: "1:5" }]} />);
    expect(screen.getAllByTestId("timeline-item")).toHaveLength(1);
  });

  it("Wizard gates Next on canAdvance and commits on the last step", async () => {
    const onNext = vi.fn();
    const onCommit = vi.fn();
    const steps = [
      { id: "a", label: "Upload", content: "A" },
      { id: "b", label: "Commit", content: "B" },
    ];
    const { rerender } = render(
      <Wizard
        steps={steps}
        step={0}
        canAdvance={false}
        onBack={() => {}}
        onNext={onNext}
        onCommit={onCommit}
      />,
    );
    expect((screen.getByTestId("wizard-next") as HTMLButtonElement).disabled).toBe(true);
    rerender(
      <Wizard
        steps={steps}
        step={1}
        canAdvance
        onBack={() => {}}
        onNext={onNext}
        onCommit={onCommit}
      />,
    );
    await userEvent.click(screen.getByTestId("wizard-commit"));
    expect(onCommit).toHaveBeenCalled();
  });

  it("Tabs move with arrow keys", async () => {
    render(
      <Tabs
        label="t"
        tabs={[
          { id: "a", label: "A", content: "pa" },
          { id: "b", label: "B", content: "pb" },
        ]}
      />,
    );
    screen.getByTestId("tab-a").focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByTestId("tab-b").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("pb")).toBeTruthy();
  });

  it("UI-22 a dialog closed natively while the parent keeps open=true is re-opened and reported", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        open
        title="Stuck"
        message="m"
        confirmLabel="OK"
        onConfirm={() => {}}
        onCancel={onCancel}
      />,
    );
    const dlg = screen.getByTestId("confirm-dialog");
    expect(dlg.hasAttribute("open")).toBe(true);
    // Simulate the browser closing it (second Escape): attribute gone, `close` event fired.
    dlg.removeAttribute("open");
    dlg.dispatchEvent(new Event("close"));
    expect(onCancel).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5);
    expect(dlg.hasAttribute("open")).toBe(true);
    vi.useRealTimers();
  });

  it("UI-22 Cancel button reports once and an ignoring parent keeps the dialog open", async () => {
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        open
        title="Stuck"
        message="m"
        confirmLabel="OK"
        onConfirm={() => {}}
        onCancel={onCancel}
      />,
    );
    await userEvent.click(screen.getByTestId("confirm-cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("confirm-dialog").hasAttribute("open")).toBe(true);
  });

  it("ConfirmDialog calls back", async () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        title="Delete?"
        message="Sure"
        confirmLabel="Delete"
        danger
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );
    await userEvent.click(screen.getByTestId("confirm-ok"));
    expect(onConfirm).toHaveBeenCalled();
  });

  it("Toast appears and can be dismissed", async () => {
    function Trigger() {
      const toast = useToast();
      return (
        <button type="button" data-testid="go" onClick={() => toast("Saved")}>
          go
        </button>
      );
    }
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );
    await userEvent.click(screen.getByTestId("go"));
    expect(screen.getByTestId("toast").textContent).toContain("Saved");
    await userEvent.click(screen.getByTestId("toast-close"));
    expect(screen.queryByTestId("toast")).toBeNull();
  });
});
