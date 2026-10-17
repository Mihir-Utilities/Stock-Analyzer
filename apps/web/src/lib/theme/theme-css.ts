import { colorTokens, divergingMid, type ColorToken, type ThemeName } from "./tokens";

/** CSS variable declarations for one theme, one `--token: value;` line per colour token. */
export function themeVariables(theme: ThemeName): string {
  return (Object.keys(colorTokens) as ColorToken[])
    .map((name) => `--${name}: ${colorTokens[name][theme]};`)
    .concat(`--diverging-mid: ${divergingMid};`)
    .join("\n  ");
}

/** Stylesheet fragment defining both themes on `:root[data-theme]` (docs/06a section 9). */
export function themeStylesheet(): string {
  return [
    `:root, :root[data-theme="dark"] {\n  color-scheme: dark;\n  ${themeVariables("dark")}\n}`,
    `:root[data-theme="light"] {\n  color-scheme: light;\n  ${themeVariables("light")}\n}`,
  ].join("\n");
}
