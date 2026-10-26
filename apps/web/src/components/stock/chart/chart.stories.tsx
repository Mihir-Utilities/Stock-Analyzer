import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { ChartFrame } from "@/components/charts/ChartFrame";
import { buildChartDataset } from "@/lib/stock/chart-model";
import type { Bar } from "@/lib/stock/schemas";

const meta: Meta = { title: "Stock/PriceChart", parameters: { layout: "padded" } };
export default meta;
type Story = StoryObj;

// Illustrative numbers only; no real market data.
function bars(n: number): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < n; i++) {
    const c = 100 + Math.sin(i / 8) * 9 + i * 0.05;
    const d = new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10);
    out.push([d, c - 0.4, c + 1.2, c - 1.1, c, 1000 + ((i * 37) % 400)]);
  }
  return out;
}

function chart(n: number, panes: boolean, compare = false) {
  const b = bars(n);
  const other = compare ? b.map((x) => [x[0], x[1], x[2], x[3], x[4] * 1.5, x[5]] as Bar) : null;
  return buildChartDataset({
    symbol: "DEMO",
    bars: b,
    series: { ok: false, reason: "no indicator series in this story" },
    actions: b[n - 10] ? [{ date: b[n - 10]?.[0] ?? "", type: "split", label: "1:2 split" }] : [],
    support: [{ price: 104, touches: 3 }],
    resistance: [{ price: 112, touches: 2 }],
    selection: {
      type: "candle",
      overlays: new Set(),
      panes: new Set(panes ? ["volume"] : []),
      log: false,
      adjusted: true,
    },
    compare: other ? { symbol: "PEER", bars: other } : null,
    asOf: "2025-04-10",
  });
}

export const CandlesWithVolume: Story = {
  render: () => {
    const c = chart(90, true);
    return <ChartFrame title="DEMO price chart" dataset={c.dataset} height={c.height} />;
  },
};

export const FewBars: Story = {
  render: () => {
    const c = chart(4, true);
    return <ChartFrame title="DEMO price chart, 4 bars" dataset={c.dataset} height={c.height} />;
  },
};

export const CompareRebased: Story = {
  render: () => {
    const c = chart(90, false, true);
    return <ChartFrame title="DEMO vs PEER" dataset={c.dataset} height={c.height} />;
  },
};

export const NoBars: Story = {
  render: () => (
    <ChartFrame
      title="DEMO price chart"
      state="empty"
      message="No price bars in this range."
      dataset={{ xName: "Date", x: [], series: [], source: "Imported prices", asOf: null }}
    />
  ),
};
