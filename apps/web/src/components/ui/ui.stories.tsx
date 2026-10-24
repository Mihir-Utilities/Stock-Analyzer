import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useState } from "react";
import { Banner, ExperimentalBanner } from "./banners";
import { Card } from "./Card";
import { AsOfChip, DepthChip, SourceChip } from "./chips";
import { DataTable, type DataColumn } from "./DataTable";
import { DeltaBadge } from "./DeltaBadge";
import { EmptyState } from "./EmptyState";
import { FormField, inputClass } from "./FormField";
import { Gauge } from "./Gauge";
import { Heatmap } from "./Heatmap";
import {
  ConfirmDialog,
  Drawer,
  InfoPopover,
  Tabs,
  ToastProvider,
  Tooltip,
  useToast,
} from "./overlays";
import { RangeBar } from "./RangeBar";
import { Skeleton } from "./Skeleton";
import { Sparkline } from "./Sparkline";
import { Stat } from "./Stat";
import { Timeline } from "./Timeline";
import { Wizard } from "./Wizard";

const meta: Meta = { title: "UI/Components", parameters: { layout: "padded" } };
export default meta;
type Story = StoryObj;

// Numbers are illustrative; formatting here is plain text because format.ts arrives with F03.
const body = <p className="text-body-sm text-text-1">Card body content.</p>;

export const CardStates: Story = {
  render: () => (
    <div className="grid gap-4 tablet:grid-cols-2">
      <Card
        title="Ready"
        source="AMFI NAV file"
        asOf="2025-01-31"
        info={<InfoPopover label="About Ready">Definition text.</InfoPopover>}
      >
        {body}
      </Card>
      <Card title="Loading" state="loading" />
      <Card title="Empty" state="empty" message="No holdings yet. Import a CSV to begin." />
      <Card
        title="Partial"
        state="partial"
        message="3 of 5 quarters available."
        source="Owner entry"
        asOf="2025-01-31"
      >
        {body}
      </Card>
      <Card title="Stale" state="stale" source="mfapi.in" asOf="2025-01-10">
        {body}
      </Card>
      <Card title="Error" state="error" message="Could not load this card." onRetry={() => {}} />
    </div>
  ),
};

export const Stats: Story = {
  render: () => (
    <div className="grid grid-cols-2 gap-4 desktop:grid-cols-4">
      <Stat
        label="NAV"
        value="123.45"
        unit="INR"
        delta={{ value: 1.2, text: "+1.20%" }}
        source="AMFI NAV file"
        asOf="2025-01-31"
        definition="Net asset value per unit."
      />
      <Stat
        label="Day change"
        value="-0.80"
        unit="%"
        delta={{ value: -0.8, text: "-0.80%" }}
        source="Owner broker"
        asOf="2025-01-31"
      />
      <Stat
        label="P/E"
        value={null}
        nullReason="Loss-making, P/E not meaningful"
        source="Owner entry"
        asOf="2025-03-31"
      />
      <Stat
        label="Flat"
        value="10.00"
        unit="INR"
        delta={{ value: 0, text: "0.00%" }}
        source="Owner entry"
        asOf={null}
      />
    </div>
  ),
};

export const Deltas: Story = {
  render: () => (
    <div className="flex gap-4">
      <DeltaBadge value={2.3} text="+2.30%" />
      <DeltaBadge value={-2.3} text="-2.30%" />
      <DeltaBadge value={0} text="0.00%" />
      <DeltaBadge value={null} text={null} />
    </div>
  ),
};

export const Chips: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      <SourceChip source="AMFI NAV file" />
      <AsOfChip asOf="2025-01-31" />
      <AsOfChip asOf="2025-01-10" stale />
      <AsOfChip asOf={null} />
      <DepthChip text="5 quarters, 4 years" />
    </div>
  ),
};

export const Banners: Story = {
  render: () => (
    <div className="flex flex-col gap-2">
      <ExperimentalBanner />
      <Banner tone="info">Prices are end of day.</Banner>
      <Banner tone="warn">Data is 3 days old.</Banner>
      <Banner tone="error">The API did not respond.</Banner>
    </div>
  ),
};

export const EmptyAndSkeleton: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      <EmptyState message="Nothing here yet." />
      <Skeleton className="h-8 w-48" />
    </div>
  ),
};

export const Sparklines: Story = {
  render: () => (
    <div className="flex items-center gap-4">
      <Sparkline label="Trend" values={[1, 3, 2, 5, 4, 6]} />
      <Sparkline label="Trend area" values={[1, 3, null, 5, 4, 6]} area />
      <Sparkline label="One point" values={[3]} />
      <Sparkline label="Flat" values={[2, 2, 2]} />
    </div>
  ),
};

const bands = [
  { from: 0, to: 40, label: "Weak", tone: "down" as const },
  { from: 40, to: 70, label: "Fair", tone: "warn" as const },
  { from: 70, to: 100, label: "Strong", tone: "up" as const },
];
export const Gauges: Story = {
  render: () => (
    <div className="flex flex-wrap gap-6">
      <Gauge label="Quality" value={78} valueText="78" bands={bands} />
      <Gauge label="Risk" value={25} valueText="25" bands={bands} />
      <Gauge
        label="Trend"
        value={null}
        valueText={null}
        bands={bands}
        nullReason="Needs 200 sessions"
      />
    </div>
  ),
};

export const RangeBars: Story = {
  render: () => (
    <div className="flex max-w-md flex-col gap-4">
      <RangeBar
        low={80}
        high={140}
        value={120}
        lowText="80.00"
        highText="140.00"
        valueText="120.00 INR"
        percentile={66}
        percentileText="66th percentile of the year"
      />
      <RangeBar
        low={null}
        high={null}
        value={null}
        lowText={null}
        highText={null}
        valueText={null}
        nullReason="Less than 52 weeks of prices"
      />
    </div>
  ),
};

interface Row {
  id: string;
  name: string;
  pe: number | null;
  ret: number;
  hist: number[];
}
const tableRows = (n: number): Row[] =>
  Array.from({ length: n }, (_, i) => ({
    id: String(i),
    name: `Company ${i + 1}`,
    pe: i % 9 === 4 ? null : 10 + (i % 30),
    ret: ((i * 7) % 21) - 10,
    hist: [3, 4, 3 + (i % 5), 6, 5 + (i % 3)],
  }));
const columns: DataColumn<Row>[] = [
  { id: "name", header: "Name", value: (r) => r.name, width: 160 },
  {
    id: "pe",
    header: "P/E (x)",
    kind: "num",
    value: (r) => r.pe,
    display: (r) => (r.pe === null ? null : r.pe.toFixed(1)),
    nullReason: "Loss-making",
  },
  {
    id: "bar",
    header: "P/E bar",
    kind: "databar",
    max: 40,
    value: (r) => r.pe,
    display: (r) => (r.pe === null ? null : r.pe.toFixed(1)),
    width: 140,
    nullReason: "Loss-making",
  },
  {
    id: "ret",
    header: "1Y return (%)",
    kind: "heat",
    max: 10,
    value: (r) => r.ret,
    display: (r) => `${r.ret > 0 ? "+" : ""}${r.ret.toFixed(1)}%`,
  },
  { id: "trend", header: "Trend", kind: "sparkline", value: () => null, spark: (r) => r.hist },
];
const common = {
  label: "Companies",
  columns,
  rowKey: (r: Row) => r.id,
  source: "Owner entry",
  asOf: "2025-01-31",
};

export const DataTableReady: Story = {
  render: () => <DataTable {...common} rows={tableRows(12)} />,
};
export const DataTableVirtualized: Story = {
  render: () => <DataTable {...common} rows={tableRows(5000)} />,
};
export const DataTableLoading: Story = {
  render: () => <DataTable {...common} rows={[]} state="loading" />,
};
export const DataTableEmpty: Story = {
  render: () => <DataTable {...common} rows={[]} state="empty" message="No companies match." />,
};
export const DataTablePartial: Story = {
  render: () => (
    <DataTable
      {...common}
      rows={tableRows(6)}
      partialNote="Sparklines need 30 sessions; shown where available."
    />
  ),
};
export const DataTableStale: Story = {
  render: () => <DataTable {...common} rows={tableRows(6)} stale asOf="2025-01-05" />,
};
export const DataTableError: Story = {
  render: () => (
    <DataTable
      {...common}
      rows={[]}
      state="error"
      message="The table could not be loaded."
      onRetry={() => {}}
    />
  ),
};

export const HeatmapStory: Story = {
  name: "Heatmap",
  render: () => (
    <Heatmap
      label="Monthly returns"
      rows={["2023", "2024"]}
      columns={["Jan", "Feb", "Mar", "Apr"]}
      maxAbs={8}
      legend={{ negative: "-8%", positive: "+8%" }}
      cells={[
        [
          { value: 4.2, text: "+4.2%" },
          { value: -3.1, text: "-3.1%" },
          { value: 7.9, text: "+7.9%" },
          { value: null, text: null },
        ],
        [
          { value: -7.5, text: "-7.5%" },
          { value: 0.4, text: "+0.4%" },
          { value: 2.2, text: "+2.2%" },
          { value: -0.9, text: "-0.9%" },
        ],
      ]}
    />
  ),
};

export const TimelineStates: Story = {
  render: () => (
    <div className="grid gap-6 tablet:grid-cols-2">
      <Timeline
        items={[
          {
            id: "1",
            date: "2025-01-15",
            kind: "Dividend",
            title: "Interim dividend",
            detail: "INR 5 per share (owner entered)",
          },
          {
            id: "2",
            date: "2024-08-02",
            kind: "Split",
            title: "Split 1:5",
            detail: "Awaiting owner confirmation",
          },
        ]}
      />
      <Timeline items={[]} emptyMessage="No corporate actions recorded." />
    </div>
  ),
};

export const FormFields: Story = {
  render: () => (
    <div className="flex max-w-sm flex-col gap-4">
      <FormField label="Quantity" hint="Whole units" required>
        {(p) => <input {...p} className={inputClass} defaultValue="10" />}
      </FormField>
      <FormField label="Price" unit="INR" error="Must be greater than zero">
        {(p) => <input {...p} className={inputClass} defaultValue="-1" />}
      </FormField>
    </div>
  ),
};

function WizardDemo() {
  const [step, setStep] = useState(0);
  const steps = ["Upload", "Validate", "Preview", "Commit"].map((label, i) => ({
    id: label.toLowerCase(),
    label,
    content: <p className="text-body-sm">Step {i + 1} content.</p>,
  }));
  return (
    <Wizard
      steps={steps}
      step={step}
      canAdvance
      onBack={() => setStep((s) => s - 1)}
      onNext={() => setStep((s) => s + 1)}
      onCommit={() => {}}
      commitLabel="Commit rows"
    />
  );
}
export const WizardStory: Story = { name: "Wizard", render: () => <WizardDemo /> };

function OverlayDemo() {
  const [confirm, setConfirm] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [stuck, setStuck] = useState(false);
  const toast = useToast();
  const btn =
    "h-9 touch-target rounded-control border border-border px-3 text-body-sm hover:bg-surface-3";
  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        data-testid="open-confirm"
        className={btn}
        onClick={() => setConfirm(true)}
      >
        Delete
      </button>
      <button
        type="button"
        data-testid="open-drawer"
        className={btn}
        onClick={() => setDrawer(true)}
      >
        Open drawer
      </button>
      <button type="button" data-testid="show-toast" className={btn} onClick={() => toast("Saved")}>
        Toast
      </button>
      <button type="button" data-testid="open-stuck" className={btn} onClick={() => setStuck(true)}>
        Stuck confirm
      </button>
      <Tooltip text="Compound annual growth rate">
        <button type="button" className={btn}>
          CAGR
        </button>
      </Tooltip>
      <ConfirmDialog
        open={confirm}
        title="Delete holding?"
        message="This cannot be undone."
        confirmLabel="Delete"
        danger
        onConfirm={() => setConfirm(false)}
        onCancel={() => setConfirm(false)}
      />
      {/* Parent that ignores onCancel: the dialog must stay open and consistent. */}
      <ConfirmDialog
        open={stuck}
        title="Cannot dismiss"
        message="The parent ignores Cancel."
        confirmLabel="OK"
        onConfirm={() => setStuck(false)}
        onCancel={() => {}}
      />
      <Drawer open={drawer} title="Details" onClose={() => setDrawer(false)}>
        Drawer content.
      </Drawer>
    </div>
  );
}
export const Overlays: Story = {
  render: () => (
    <ToastProvider>
      <OverlayDemo />
    </ToastProvider>
  ),
};

export const TabsStory: Story = {
  name: "Tabs",
  render: () => (
    <Tabs
      label="Sections"
      tabs={[
        { id: "a", label: "Overview", content: "Overview panel" },
        { id: "b", label: "Data", content: "Data panel" },
      ]}
    />
  ),
};
