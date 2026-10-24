import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useState } from "react";
import { InfoPopover } from "@/components/ui/overlays";
import type { ChartDataset, ChartSeries } from "./chart-data";
import { ChartFrame } from "./ChartFrame";

const meta: Meta = { title: "Charts/ChartFrame", parameters: { layout: "padded" } };
export default meta;
type Story = StoryObj;

// Illustrative numbers only; no real market data.
function make(n: number, withForecast = false): ChartDataset {
  const x = Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(2024, 0, 1 + i));
    return d.toISOString().slice(0, 10);
  });
  const wave = (i: number, phase: number, base: number) =>
    base + Math.sin(i / 9 + phase) * 8 + i * 0.03;
  const series: ChartSeries[] = [
    {
      id: "a",
      name: "Alpha",
      unit: "INR",
      kind: "line",
      values: x.map((_, i) => Math.round(wave(i, 0, 100) * 100) / 100),
      format: (v) => v.toFixed(2),
    },
    {
      id: "b",
      name: "Beta",
      unit: "INR",
      kind: "area",
      values: x.map((_, i) => (i % 17 === 5 ? null : Math.round(wave(i, 2, 90) * 100) / 100)),
      nullReason: "No trade that day",
      format: (v) => v.toFixed(2),
    },
  ];
  if (withForecast) {
    series.push({
      id: "f",
      name: "Forecast p50",
      unit: "INR",
      kind: "line",
      forecast: true,
      values: x.map((_, i) => (i > n * 0.7 ? Math.round(wave(i, 0.4, 104) * 100) / 100 : null)),
      nullReason: "Forecast starts later",
    });
  }
  return { xName: "Date", x, series, source: "Synthetic story data", asOf: "2024-12-31" };
}

const info = (
  <InfoPopover label="About this chart">Illustrative series for the component story.</InfoPopover>
);

function WithRanges({ n }: { n: number }) {
  const [range, setRange] = useState("1Y");
  return (
    <ChartFrame
      title="Price"
      info={info}
      dataset={make(n, true)}
      ranges={{ options: ["1M", "3M", "1Y", "5Y"], value: range, onChange: setRange }}
    />
  );
}

export const Ready: Story = { render: () => <WithRanges n={120} /> };
export const Loading: Story = {
  render: () => <ChartFrame title="Price" dataset={make(10)} state="loading" />,
};
export const Empty: Story = { render: () => <ChartFrame title="Price" dataset={make(0)} /> };
export const Partial: Story = {
  render: () => (
    <ChartFrame
      title="Price"
      dataset={make(40)}
      state="partial"
      message="Beta is missing 3 days."
    />
  ),
};
export const Stale: Story = {
  render: () => <ChartFrame title="Price" dataset={make(40)} state="stale" />,
};
export const ErrorState: Story = {
  render: () => (
    <ChartFrame
      title="Price"
      dataset={make(10)}
      state="error"
      message="Prices could not be loaded."
      onRetry={() => {}}
    />
  ),
};
export const Points1: Story = { render: () => <ChartFrame title="1 point" dataset={make(1)} /> };
export const Points2: Story = { render: () => <ChartFrame title="2 points" dataset={make(2)} /> };
export const Points10: Story = {
  render: () => <ChartFrame title="10 points" dataset={make(10)} />,
};
export const Points2000: Story = {
  render: () => <ChartFrame title="2,000 points" dataset={make(2000)} />,
};
export const BarsAndForecast: Story = {
  render: () => {
    const d = make(8, true);
    return (
      <ChartFrame
        title="Bars with a forecast series"
        dataset={{
          ...d,
          series: d.series.map((s) => ({ ...s, kind: "bar" as const })),
        }}
      />
    );
  },
};
