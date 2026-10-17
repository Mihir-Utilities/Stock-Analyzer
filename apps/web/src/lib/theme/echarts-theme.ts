import { categoricalPalette, colorTokens, divergingMid, type ThemeName } from "./tokens";

// ECharts theme generated from tokens (docs/06a section 9). Plain object so this file does not
// import ECharts; ChartFrame (F02) registers it with `echarts.registerTheme`.

interface AxisTheme {
  axisLine: { lineStyle: { color: string } };
  axisTick: { lineStyle: { color: string } };
  axisLabel: { color: string };
  splitLine: { lineStyle: { color: string } };
}

export interface EchartsTheme {
  color: string[];
  backgroundColor: string;
  textStyle: { color: string; fontFamily: string };
  title: { textStyle: { color: string }; subtextStyle: { color: string } };
  legend: { textStyle: { color: string } };
  categoryAxis: AxisTheme;
  valueAxis: AxisTheme;
  timeAxis: AxisTheme;
  tooltip: { backgroundColor: string; borderColor: string; textStyle: { color: string } };
  candlestick: {
    itemStyle: { color: string; color0: string; borderColor: string; borderColor0: string };
  };
  /** Sequential ramp for heatmaps: single hue of --accent. */
  visualMap: { color: string[] };
  /** Diverging ramp for returns: down, neutral, up. */
  diverging: [string, string, string];
}

function axis(theme: ThemeName): AxisTheme {
  const border = colorTokens.border[theme];
  return {
    axisLine: { lineStyle: { color: border } },
    axisTick: { lineStyle: { color: border } },
    axisLabel: { color: colorTokens["text-2"][theme] },
    splitLine: { lineStyle: { color: border } },
  };
}

export function echartsTheme(theme: ThemeName): EchartsTheme {
  const c = (name: keyof typeof colorTokens) => colorTokens[name][theme];
  return {
    color: [...categoricalPalette],
    backgroundColor: "transparent",
    textStyle: { color: c("text-2"), fontFamily: "Inter, system-ui, sans-serif" },
    title: { textStyle: { color: c("text-1") }, subtextStyle: { color: c("text-2") } },
    legend: { textStyle: { color: c("text-2") } },
    categoryAxis: axis(theme),
    valueAxis: axis(theme),
    timeAxis: axis(theme),
    tooltip: {
      backgroundColor: c("surface-2"),
      borderColor: c("border"),
      textStyle: { color: c("text-1") },
    },
    // India convention: green up, red down.
    candlestick: {
      itemStyle: {
        color: c("up"),
        color0: c("down"),
        borderColor: c("up"),
        borderColor0: c("down"),
      },
    },
    visualMap: { color: [c("accent"), c("accent-weak").slice(0, 7)] },
    diverging: [c("down"), divergingMid, c("up")],
  };
}
