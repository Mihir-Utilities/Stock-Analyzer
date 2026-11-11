// Writes the PWA icons into public/icons (PNG, no dependencies). Colours are the design tokens
// (src/lib/theme/tokens.ts): bg and accent, dark theme. The glyph is three rising bars.
// Run: node scripts/gen-icons.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const BG = [0x0b, 0x0f, 0x14];
const ACCENT = [0x4c, 0x8d, 0xff];

function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** `safe` is the fraction of the canvas the glyph may use (maskable icons keep a 20% margin). */
function png(size, safe) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  const box = size * safe;
  const x0 = (size - box) / 2;
  const y0 = (size - box) / 2;
  const barW = box / 5;
  const heights = [0.4, 0.65, 1];
  for (let y = 0; y < size; y++) {
    const row = y * (size * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      let px = BG;
      for (let i = 0; i < 3; i++) {
        const bx = x0 + barW * (1 + i * 1.5 - (i === 0 ? 0.25 : 0.25));
        const h = box * heights[i];
        if (x >= bx && x < bx + barW && y >= y0 + box - h && y < y0 + box) px = ACCENT;
      }
      raw.set(px, row + 1 + x * 3);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync("public/icons", { recursive: true });
writeFileSync("public/icons/icon-192.png", png(192, 0.6));
writeFileSync("public/icons/icon-512.png", png(512, 0.6));
writeFileSync("public/icons/icon-maskable-512.png", png(512, 0.45));
console.log("icons written");
