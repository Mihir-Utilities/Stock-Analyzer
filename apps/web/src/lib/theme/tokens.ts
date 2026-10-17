// Design tokens, docs/06a-design-system.md section 3.1. Hex values exactly as specified.
// This file is the single source for the CSS variables (see theme-css.ts) and the ECharts theme.

export type ThemeName = "dark" | "light";

export const colorTokens = {
  bg: { dark: "#0B0F14", light: "#F7F8FA" },
  "surface-1": { dark: "#111720", light: "#FFFFFF" },
  "surface-2": { dark: "#18202B", light: "#F0F2F5" },
  "surface-3": { dark: "#202A37", light: "#E7EAEE" },
  border: { dark: "#263140", light: "#D9DEE5" },
  "text-1": { dark: "#E8EDF3", light: "#0F1722" },
  "text-2": { dark: "#A5B1C0", light: "#4A5667" },
  "text-3": { dark: "#6F7C8D", light: "#7A8696" },
  accent: { dark: "#4C8DFF", light: "#2F6FEB" },
  "accent-weak": { dark: "#4C8DFF1F", light: "#2F6FEB1A" },
  up: { dark: "#2BB673", light: "#12805A" },
  down: { dark: "#F0524D", light: "#C5352F" },
  warn: { dark: "#E6A23C", light: "#B26B00" },
  info: { dark: "#5BC0DE", light: "#0F7B98" },
  exp: { dark: "#B07CFF", light: "#7A3FD0" },
} as const;

export type ColorToken = keyof typeof colorTokens;

/** Colorblind-safe categorical palette (8). */
export const categoricalPalette = [
  "#4C8DFF",
  "#F5A524",
  "#2BB673",
  "#B07CFF",
  "#F0524D",
  "#5BC0DE",
  "#E86AA6",
  "#9AA5B1",
] as const;

/** Diverging midpoint between --down and --up. */
export const divergingMid = "#3A4656";

export const spacing = [4, 8, 12, 16, 24, 32, 48] as const;
export const radius = { card: 8, control: 6, chip: 999 } as const;
export const breakpoints = { tablet: 640, desktop: 1024, wide: 1440 } as const;
export const layout = {
  sidebar: 232,
  sidebarCollapsed: 64,
  topbarDesktop: 56,
  topbarMobile: 52,
  tabbar: 56,
  contentMax: 1440,
} as const;
