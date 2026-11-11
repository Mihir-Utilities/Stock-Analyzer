import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";

// Heavy tabs and sections load through next/dynamic (route budget, F15); the first import in a
// worker has to be transformed, which can take longer than the 1 s default.
configure({ asyncUtilTimeout: 5000 });

afterEach(() => cleanup());

// jsdom has no canvas. ECharts (SVG renderer) only needs text measurement from a 2d context.
if (typeof HTMLCanvasElement !== "undefined") {
  HTMLCanvasElement.prototype.getContext = function getContext() {
    return { font: "", measureText: (t: string) => ({ width: t.length * 6 }) };
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
}
