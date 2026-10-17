// WCAG 2.1 relative luminance and contrast ratio (docs/06a section 3.1, UI-04).

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

export function parseHex(hex: string): { r: number; g: number; b: number; a: number } {
  const m = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(hex);
  if (!m || m[1] === undefined) throw new Error(`bad hex colour: ${hex}`);
  const n = parseInt(m[1], 16);
  return {
    r: (n >> 16) & 255,
    g: (n >> 8) & 255,
    b: n & 255,
    a: m[2] === undefined ? 1 : parseInt(m[2], 16) / 255,
  };
}

/** Composite a possibly translucent foreground over an opaque background. */
export function over(fg: string, bg: string): string {
  const f = parseHex(fg);
  const b = parseHex(bg);
  const mix = (x: number, y: number) => Math.round(x * f.a + y * (1 - f.a));
  const h = (v: number) => v.toString(16).padStart(2, "0");
  return `#${h(mix(f.r, b.r))}${h(mix(f.g, b.g))}${h(mix(f.b, b.b))}`;
}

export function luminance(hex: string): number {
  const { r, g, b } = parseHex(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
