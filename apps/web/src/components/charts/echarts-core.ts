// Tree-shaken ECharts (docs/06a section 2): only the charts and components in use, SVG renderer
// (works without canvas, exports to PNG through an <img>/<canvas> round trip). Loaded with a
// dynamic import from EChart so it stays out of every route's first-load JS. Later tasks add the
// chart types they need here (candlestick, heatmap, treemap, ...).
import { BarChart, LineChart } from "echarts/charts";
import { AriaComponent, GridComponent, TooltipComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { SVGRenderer } from "echarts/renderers";
import { echartsTheme } from "@/lib/theme/echarts-theme";

echarts.use([LineChart, BarChart, GridComponent, TooltipComponent, AriaComponent, SVGRenderer]);
echarts.registerTheme("analyzer-dark", echartsTheme("dark"));
echarts.registerTheme("analyzer-light", echartsTheme("light"));

export { echarts };
