import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => cleanup());

// jsdom has no canvas. ECharts (SVG renderer) only needs text measurement from a 2d context.
if (typeof HTMLCanvasElement !== "undefined") {
  HTMLCanvasElement.prototype.getContext = function getContext() {
    return { font: "", measureText: (t: string) => ({ width: t.length * 6 }) };
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
}
