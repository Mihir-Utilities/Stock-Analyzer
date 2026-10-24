"use client";

import { useEffect, useRef, useState } from "react";
import type { ThemeName } from "@/lib/theme/tokens";

type EChartsType = import("echarts/core").EChartsType;

export interface EChartHandle {
  /** SVG data URL of the current drawing, or null before the chart is ready. */
  svgDataUrl: () => string | null;
}

/**
 * Thin ECharts host. Do not use directly: charts go through ChartFrame (CLAUDE.md). Re-creates the
 * instance when the theme changes (theme sync) and resizes with its container.
 */
export function EChart({
  option,
  theme,
  height,
  label,
  onHandle,
  onError,
}: {
  option: Record<string, unknown>;
  theme: ThemeName;
  height: number;
  label: string;
  onHandle?: (h: EChartHandle | null) => void;
  onError?: (e: unknown) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [chart, setChart] = useState<EChartsType | null>(null);

  useEffect(() => {
    let disposed = false;
    let instance: EChartsType | null = null;
    let observer: ResizeObserver | undefined;
    import("./echarts-core")
      .then(({ echarts }) => {
        const el = host.current;
        if (disposed || !el) return;
        instance = echarts.init(el, `analyzer-${theme}`, {
          renderer: "svg",
          width: el.clientWidth || 600,
          height: el.clientHeight || height,
        });
        if (typeof ResizeObserver !== "undefined") {
          observer = new ResizeObserver(() => {
            if (el.clientWidth > 0) instance?.resize({ width: el.clientWidth, height });
          });
          observer.observe(el);
        }
        setChart(instance);
      })
      .catch((e: unknown) => onError?.(e));
    return () => {
      disposed = true;
      observer?.disconnect();
      instance?.dispose();
      setChart(null);
    };
    // The instance depends on the theme only; option changes go through setOption below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, height]);

  useEffect(() => {
    if (!chart) return;
    try {
      chart.setOption(option, { notMerge: true });
    } catch (e) {
      onError?.(e);
    }
  }, [chart, option, onError]);

  useEffect(() => {
    if (!onHandle) return;
    onHandle(chart ? { svgDataUrl: () => chart.getDataURL({ type: "svg" }) } : null);
    return () => onHandle(null);
  }, [chart, onHandle]);

  return (
    <div
      ref={host}
      role="img"
      aria-label={label}
      data-testid="chart-canvas"
      data-ready={chart ? "true" : "false"}
      style={{ height }}
      className="w-full"
    />
  );
}
