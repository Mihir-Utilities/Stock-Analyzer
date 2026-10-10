# 06a. Frontend Design System (professional, data-dense, accessible)

Goal: a calm, institutional-grade analytics look (think a Bloomberg/Koyfin-like clarity, not a toy dashboard): dense but legible, consistent, fast, with rich visualisation and **no information loss** (every API field is reachable in the UI; every chart has a data-table view).

## 1. Principles
1. **Data first:** numbers and charts lead; chrome recedes. No decorative gradients, no stock photos, no emojis as UI.
2. **Density with hierarchy:** compact tables (row height 36 px desktop, 44 px touch), clear type scale, generous whitespace between groups, not inside tables.
3. **Consistency:** one component for each job (one Card, one DataTable, one ChartFrame, one Stat). Never hand-style one-offs.
4. **Honesty:** every metric shows unit, source and as-of; nulls show a reason; estimates and forecasts are visually distinct (dashed lines, hatched areas, "Experimental" tag).
5. **Progressive disclosure:** summary first, detail one tap away (popovers, drawers, "Show data"), never hidden forever.
6. **Accessible by default:** WCAG 2.1 AA, keyboard operable, color never the only signal.
7. **Fast:** skeletons, lazy-loaded charts, virtualization, no layout shift.

## 2. Tech choices (all permissive licences; verify in S15)
Next.js (MIT), React, TypeScript, Tailwind CSS (MIT), shadcn/ui + Radix UI (MIT) for primitives, **Apache ECharts** (Apache-2.0) as the single chart library (candlestick, line, area, bar, stacked, heatmap, treemap, sunburst, gauge, radar, scatter/bubble, waterfall via bar stacking, calendar heatmap, boxplot, histogram), `lucide-react` icons (ISC), Inter (OFL) self-hosted via `next/font/local` (no external font requests), TanStack Query/Table/Virtual (MIT), `decimal.js` (MIT), `date-fns` (MIT), `zod` (MIT). No component or chart library with a copyleft licence. Keep ECharts bundles tree-shaken (`echarts/core` + only used charts/components), loaded with dynamic imports.

## 3. Design tokens

### 3.1 Color (CSS variables; HSL shown as hex)
| Token | Dark | Light | Use |
|---|---|---|---|
| `--bg` | #0B0F14 | #F7F8FA | App background |
| `--surface-1` | #111720 | #FFFFFF | Cards |
| `--surface-2` | #18202B | #F0F2F5 | Raised/hover, table header |
| `--surface-3` | #202A37 | #E7EAEE | Pressed, chips |
| `--border` | #263140 | #D9DEE5 | Hairlines |
| `--text-1` | #E8EDF3 | #0F1722 | Primary text |
| `--text-2` | #A5B1C0 | #4A5667 | Secondary |
| `--text-3` | #6F7C8D | #7A8696 | Tertiary/disabled |
| `--accent` | #4C8DFF | #2F6FEB | Links, primary actions, selected |
| `--accent-weak` | #4C8DFF1F | #2F6FEB1A | Selection backgrounds |
| `--up` | #2BB673 | #12805A | Gain |
| `--down` | #F0524D | #C5352F | Loss |
| `--warn` | #E6A23C | #B26B00 | Stale/warning |
| `--info` | #5BC0DE | #0F7B98 | Informational |
| `--exp` | #B07CFF | #7A3FD0 | Experimental/forecast tag and fan chart |
Chart categorical palette (colorblind-safe, 8): #4C8DFF, #F5A524, #2BB673, #B07CFF, #F0524D, #5BC0DE, #E86AA6, #9AA5B1. Sequential (heatmaps): single-hue ramp of `--accent`. Diverging (returns): `--down` <- #3A4656 -> `--up`. Verify contrast >= 4.5:1 for text and >= 3:1 for graphics in both themes (automated axe + manual).

### 3.2 Typography
Inter, fallback system-ui. Numeric columns use `font-variant-numeric: tabular-nums`. Scale: 11/12 (caption), 13 (table/body-sm), 14 (body), 16 (lead), 20 (section title), 24 (page title), 32 (hero price), 40 (mobile hero price 32). Weights 400/500/600. Line height 1.4 (body), 1.2 (numbers). Letter-spacing 0; uppercase micro-labels 11 px with +0.04em.

### 3.3 Spacing, radius, elevation, motion
4-px base grid (4, 8, 12, 16, 24, 32, 48). Card padding 16 (mobile) / 20 (desktop). Radius 8 (cards), 6 (inputs/buttons), 999 (chips). Elevation: borders instead of shadows in dark; subtle `0 1px 2px rgba(0,0,0,.06)` in light. Motion: 120 ms ease-out for hover/focus, 200 ms for drawers; chart animation 300 ms on first render only; all disabled under `prefers-reduced-motion`.

### 3.4 Layout
Breakpoints: 0-639 (mobile), 640-1023 (tablet), 1024-1439 (desktop), 1440+ (wide). Desktop shell: left sidebar 232 px (collapsible to 64), top bar 56 px (search, market status pill, theme, user menu), content max-width 1440 with 24 px gutters; 12-column grid (gap 16). Mobile shell: top bar 52 px + bottom tab bar 56 px with safe-area insets. Stock page uses a sticky header (price, change, actions) and a scrollable tab bar.

## 4. Component catalogue (each has Storybook stories for all states)
| Component | Spec |
|---|---|
| `Card` | Title row (title, info popover, actions), body, footer chips (`SourceChip`, `AsOfChip`); states loading/empty/partial/stale/error |
| `Stat` | Label, value (tabular), delta (arrow + sign + color), unit, tooltip with formula/definition and source |
| `DeltaBadge` | Arrow + signed % with color; neutral for zero/null |
| `DataTable` | TanStack Table, sticky header and first column, column pinning, sortable, resizable, density toggle, virtualization above 100 rows, sparkline/databar/heat cells, CSV export (formula-injection-safe), empty/error states, keyboard navigation |
| `ChartFrame` | Wraps every ECharts chart: title, legend toggles, range chips, "Show data" table toggle (accessible alternative + no-information-loss), export PNG/CSV, fullscreen, loading skeleton, empty state, error state, theme sync, crosshair tooltip with units |
| `Sparkline` | Tiny line/area with last-point dot; used in tables and cards |
| `Gauge` | Semi-circle 0-100 with labeled bands (trend/risk/quality) |
| `RangeBar` | 52-week low/high with marker and percentile tick |
| `SourceChip` / `AsOfChip` / `DepthChip` | Source + date; amber when stale; "5 quarters, 4 years" |
| `ExperimentalBanner` | Purple-tinted strip with fixed copy; cannot be dismissed on forecast views |
| `EmptyState` | Icon, one-sentence explanation, primary action |
| `Skeleton` | Matches final layout dimensions |
| `SearchPalette` | Command-palette dialog; see frontend spec |
| `Toast`, `ConfirmDialog`, `Drawer`, `Tabs`, `Tooltip`, `Popover` | Radix-based |
| `FormField` | Label, hint, unit suffix, inline error, accessible description |
| `Wizard` | Multi-step (upload, validate, preview, commit) with progress |
| `Timeline` | Corporate actions/events list with markers |
| `Heatmap` | Calendar or month x year matrix with diverging scale and legend |

## 5. Visualization catalogue (maximum visual coverage; all via `ChartFrame`)
| Area | Visuals (all with "Show data") |
|---|---|
| Stock overview | Price+volume candlestick (mini, 1Y); 52-week RangeBar; performance bar chart (1W..5Y returns, diverging colors); Gauges for trend/risk/quality; Radar of quality components; Sparkline KPIs |
| Stock chart | Candlestick/line/area, volume, SMA/EMA/Bollinger overlays, RSI/MACD/Stochastic/ADX panes, compare overlay, corporate-action markers, support/resistance bands, log scale |
| Stock analysis (inside Chart tab, "Analysis" sub-tab) | Drawdown (underwater) chart; rolling volatility line; daily-return histogram with normal overlay; month x year returns heatmap (seasonality); calendar heatmap of daily returns; rolling beta line; return distribution boxplot by month |
| Fundamentals | Grouped bars (revenue, EBITDA, net profit) + YoY line; margins lines; EPS bars; P&L waterfall for the latest period (revenue -> costs -> EBITDA -> D&A -> interest -> PBT -> tax -> PAT); stacked balance-sheet composition; cash-flow bars (CFO/CFI/CFF) with FCF line; DuPont-style ROE decomposition bars; valuation band (P/E percentile strip) |
| Ownership | Stacked bars/area per quarter (promoter/FII/DII-ex-MF/MF/public/govt); pledge line; QoQ diverging bars; small multiples per holder |
| Peers | Bubble scatter (x=P/E or choice, y=ROE or choice, size=market cap); percentile bars; radar overlay vs peer median; ranked bar chart for a chosen metric |
| Prediction | Fan chart (q10-q50-q90) over recent prices; bucket gauge; reliability (calibration) plot in model card; live track-record line (hit rate, coverage); AUC-by-fold bars |
| Portfolio | Allocation sunburst/treemap (sector > stock); contribution-to-return bars; P&L waterfall by holding; portfolio vs Nifty growth line (indexed 100); XIRR card; drawdown chart; realized P&L cumulative line |
| Mutual funds | NAV line with rolling-return band; rolling 1Y return distribution histogram; calendar-year returns bars; SIP growth area (invested vs value) with installment markers; risk-return scatter (compare); returns heatmap table (funds x periods) |
| Screener | Results table with data bars and sparklines; two-metric scatter (any metrics); distribution histogram of a chosen metric with filter thresholds marked |
| Dashboard | Index sparkline tiles; watchlist heatmap/treemap (size by value or market cap if available, color by day change); upcoming-events timeline; alert activity strip |

Chart rules: consistent axis formats (`format.ts`), units in axis titles, tooltips show value + unit + date + source, legends are toggleable, colors from the palette in a fixed order per series identity (same stock = same color across charts in one view), forecasts dashed/hatched in `--exp`, estimated values marked, downsampling indicated. Charts must render with 0, 1, 2, 10 and 2,000 points without errors.

## 6. "No information loss" policy
1. A **field coverage matrix** (in `06-frontend-spec.md` section 8) maps every API response field to the UI element showing it; a test fails if a field is unmapped.
2. Every chart has "Show data" (table with all plotted values and export CSV).
3. Truncated text always has a tooltip/expand; long tables are virtualized, not cut.
4. Nulls show reasons, never blank cells.
5. Derived values expose their formula/definition in a tooltip (from a single `definitions.ts` generated from `05-analytics-spec.md`).
6. Warnings from the API (`warnings[]`) are always rendered (page-level banner or card chip).

## 7. Responsive patterns
Mobile: single column; tables become horizontally scrollable with sticky first column or "card rows" for key lists; charts full-width with touch crosshair (long press), pinch zoom, and a bottom-sheet legend; dense tables offer a "metrics picker". Tablet: two columns. Desktop: up to 12-column dashboards; wide: side-by-side chart + table.

## 8. Iconography and imagery
`lucide-react` only; 16/20 px; stroke 1.75. No raster images except the PWA icon set (generated SVG-based). Empty states use simple SVG glyphs from the same icon set.

## 9. Theming and persistence
CSS variables on `:root[data-theme]`; theme stored in `app_user.display_prefs` and localStorage; initial theme from `prefers-color-scheme`. ECharts theme objects generated from tokens (`echartsTheme(dark|light)`).

## 10. Quality gates (CI)
Lighthouse mobile >= 90 performance and >= 95 accessibility on the main routes; axe with zero serious violations; bundle budgets (<= 250 kB gz JS per route, charts lazy); visual regression snapshots for key components in both themes (Playwright); Storybook builds; unit tests for all formatters and definitions.
