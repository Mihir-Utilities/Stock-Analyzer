import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EChart } from "@/components/charts/EChart";
import "./dom-matchers";

// A fake echarts instance: the host's lifecycle (init once, resize on height change, keep the zoom
// window when only the option changes) is under test here, not drawing.
const setOption = vi.fn();
let zoom = { start: 0, end: 100 };
const instance = {
  setOption: (...a: unknown[]) => setOption(...a),
  resize: vi.fn(),
  dispose: vi.fn(),
  getOption: () => ({ dataZoom: [{ ...zoom }] }),
  dispatchAction: vi.fn((a: { start: number; end: number }) => {
    zoom = { start: a.start, end: a.end };
  }),
  getDataURL: () => "data:",
};
const init = vi.fn(() => instance);
vi.mock("@/components/charts/echarts-core", () => ({ echarts: { init: () => init() } }));

type Opt = Record<string, unknown>;
const option = (n: number, extra: Opt = {}): Opt => ({
  xAxis: [{ data: Array.from({ length: n }, (_, i) => `d${i}`) }],
  dataZoom: [{ type: "inside", start: 0, end: 100 }],
  ...extra,
});
const lastZoom = () => {
  const o = setOption.mock.calls.at(-1)?.[0] as { dataZoom: Array<{ start: number; end: number }> };
  return [o.dataZoom[0]?.start, o.dataZoom[0]?.end];
};

beforeEach(() => {
  zoom = { start: 0, end: 100 };
  setOption.mockClear();
  init.mockClear();
  instance.resize.mockClear();
  instance.dispose.mockClear();
});

describe("EChart host", () => {
  it("a height change resizes the same instance (no dispose) and the zoom window survives", async () => {
    const { rerender } = render(<EChart option={option(30)} theme="dark" height={340} label="c" />);
    await vi.waitFor(() => expect(setOption).toHaveBeenCalledTimes(1));
    expect(init).toHaveBeenCalledTimes(1);
    zoom = { start: 20, end: 60 }; // the user zoomed
    rerender(<EChart option={option(30, { grid: 1 })} theme="dark" height={460} label="c" />);
    await vi.waitFor(() => expect(instance.resize).toHaveBeenCalledWith({ height: 460 }));
    await vi.waitFor(() => expect(setOption).toHaveBeenCalledTimes(2));
    expect(init).toHaveBeenCalledTimes(1);
    expect(instance.dispose).not.toHaveBeenCalled();
    expect(lastZoom()).toEqual([20, 60]);
  });

  it("a different x range (range chip) does not inherit the old zoom window", async () => {
    const { rerender } = render(<EChart option={option(30)} theme="dark" height={340} label="c" />);
    await vi.waitFor(() => expect(setOption).toHaveBeenCalledTimes(1));
    zoom = { start: 20, end: 60 };
    rerender(<EChart option={option(90)} theme="dark" height={340} label="c" />);
    await vi.waitFor(() => expect(setOption).toHaveBeenCalledTimes(2));
    expect(lastZoom()).toEqual([0, 100]);
  });

  it("a theme change re-creates the instance", async () => {
    const { rerender } = render(<EChart option={option(30)} theme="dark" height={340} label="c" />);
    await vi.waitFor(() => expect(setOption).toHaveBeenCalledTimes(1));
    rerender(<EChart option={option(30)} theme="light" height={340} label="c" />);
    await vi.waitFor(() => expect(init).toHaveBeenCalledTimes(2));
    expect(instance.dispose).toHaveBeenCalledTimes(1);
  });

  it("keyboard +, arrows and 0 change the visible window on the focusable region", async () => {
    const { getByTestId } = render(
      <EChart option={option(30)} theme="dark" height={340} label="c" keyboardHintId="hint" />,
    );
    await vi.waitFor(() => expect(setOption).toHaveBeenCalledTimes(1));
    const region = getByTestId("chart-canvas");
    expect(region).toHaveAttribute("tabindex", "0");
    const press = (key: string) =>
      region.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    expect(press("+")).toBe(false); // handled: default prevented
    expect(zoom.end - zoom.start).toBeLessThan(100);
    const width = zoom.end - zoom.start;
    const before = zoom.start;
    press("ArrowRight");
    expect(zoom.start).toBeGreaterThan(before);
    expect(zoom.end - zoom.start).toBeCloseTo(width);
    press("0");
    expect(zoom).toEqual({ start: 0, end: 100 });
    expect(press("x")).toBe(true); // other keys are not swallowed
  });
});
