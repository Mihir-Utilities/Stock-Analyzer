"use client";

import { useEffect, useRef, useState } from "react";
import type { ThemeName } from "@/lib/theme/tokens";
import { categoryCount, keyboardZoom, withZoomWindow, type ZoomWindow } from "./pane-option";

type EChartsType = import("echarts/core").EChartsType;

export interface EChartHandle {
  /** SVG data URL of the current drawing, or null before the chart is ready. */
  svgDataUrl: () => string | null;
}

/**
 * Thin ECharts host. Do not use directly: charts go through ChartFrame (CLAUDE.md). Re-creates the
 * instance when the theme changes (theme sync) and resizes with its container. A height change
 * (a pane toggled) only resizes, and a rebuilt option for the same x range keeps the zoom window.
 * With `keyboardHintId` the wrapper is a focusable group: +/- zoom, arrows pan, 0 resets.
 */
export function EChart({
  option,
  theme,
  height,
  label,
  keyboardHintId,
  onHandle,
  onError,
}: {
  option: Record<string, unknown>;
  theme: ThemeName;
  height: number;
  label: string;
  /** id of the visible hint element; when set the chart is keyboard zoomable. */
  keyboardHintId?: string;
  onHandle?: (h: EChartHandle | null) => void;
  onError?: (e: unknown) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [chart, setChart] = useState<EChartsType | null>(null);
  const heightRef = useRef(height);
  const lastCount = useRef(0);

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
          height: el.clientHeight || heightRef.current,
        });
        if (typeof ResizeObserver !== "undefined") {
          observer = new ResizeObserver(() => {
            if (el.clientWidth > 0)
              instance?.resize({ width: el.clientWidth, height: heightRef.current });
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
  }, [theme]);

  useEffect(() => {
    heightRef.current = height;
    chart?.resize({ height });
  }, [chart, height]);

  const currentWindow = (c: EChartsType): ZoomWindow | null => {
    const dz = (c.getOption() as { dataZoom?: Array<{ start?: number; end?: number }> }).dataZoom;
    const z = dz?.[0];
    return typeof z?.start === "number" && typeof z.end === "number"
      ? { start: z.start, end: z.end }
      : null;
  };

  useEffect(() => {
    if (!chart) return;
    try {
      const count = categoryCount(option);
      const win = count > 0 && count === lastCount.current ? currentWindow(chart) : null;
      lastCount.current = count;
      chart.setOption(win ? withZoomWindow(option, win) : option, { notMerge: true });
    } catch (e) {
      onError?.(e);
    }
  }, [chart, option, onError]);

  useEffect(() => {
    if (!onHandle) return;
    onHandle(chart ? { svgDataUrl: () => chart.getDataURL({ type: "svg" }) } : null);
    return () => onHandle(null);
  }, [chart, onHandle]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!chart || e.ctrlKey || e.metaKey || e.altKey) return;
    const win = currentWindow(chart) ?? { start: 0, end: 100 };
    const next = keyboardZoom(win, e.key);
    if (!next) return;
    e.preventDefault();
    chart.dispatchAction({ type: "dataZoom", start: next.start, end: next.end });
  };

  // The focusable element is the drawing host itself: a focusable ancestor around it stopped the
  // browser delivering two-finger pinch gestures to ECharts (e2e "touch pinch").
  const keyboardProps = keyboardHintId
    ? { role: "group", tabIndex: 0, "aria-describedby": keyboardHintId, onKeyDown }
    : { role: "img" };
  return (
    <div
      ref={host}
      {...keyboardProps}
      aria-label={label}
      data-testid="chart-canvas"
      data-ready={chart ? "true" : "false"}
      style={{ height }}
      className="w-full"
    />
  );
}
