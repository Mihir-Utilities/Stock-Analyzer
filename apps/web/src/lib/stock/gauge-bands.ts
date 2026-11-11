import type { GaugeBand } from "@/components/ui/Gauge";

// Trend and risk gauge bands, shared by the Overview and the Prediction tab. Bands touch (each
// `from` equals the previous `to`) so a fractional score such as 20.5 always lands in a band; the
// Gauge picks the first band whose range contains the value, so a score on a boundary takes the
// lower band.
export const TREND_BANDS: GaugeBand[] = [
  { from: 0, to: 20, label: "Strong down", tone: "down" },
  { from: 20, to: 40, label: "Down", tone: "warn" },
  { from: 40, to: 60, label: "Sideways", tone: "info" },
  { from: 60, to: 80, label: "Up", tone: "up" },
  { from: 80, to: 100, label: "Strong up", tone: "up" },
];
export const RISK_BANDS: GaugeBand[] = [
  { from: 0, to: 33, label: "Low", tone: "up" },
  { from: 33, to: 66, label: "Medium", tone: "warn" },
  { from: 66, to: 100, label: "High", tone: "down" },
];
