import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// The default 1 s async timeout applies. Tests that render a page with next/dynamic sections
// preload those modules in a beforeAll (see tests/unit/preload.ts), so the transform cost of the
// first import is not charged to a findBy* call.

afterEach(() => cleanup());

// jsdom has no canvas. ECharts (SVG renderer) only needs text measurement from a 2d context.
if (typeof HTMLCanvasElement !== "undefined") {
  HTMLCanvasElement.prototype.getContext = function getContext() {
    return { font: "", measureText: (t: string) => ({ width: t.length * 6 }) };
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
}
