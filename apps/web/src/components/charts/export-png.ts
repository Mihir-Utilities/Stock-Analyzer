import { downloadBlob } from "@/components/ui/csv";

/**
 * Rasterise an SVG data URL (from the ECharts SVG renderer) to a PNG download at 2x. The
 * background is the card surface so the image is readable outside the app. No network involved:
 * the image source is a data URL.
 */
export async function downloadPng(svgDataUrl: string, filename: string): Promise<void> {
  const img = new Image();
  img.decoding = "async";
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("The chart image could not be rendered."));
    img.src = svgDataUrl;
  });
  const scale = 2;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, (img.naturalWidth || 600) * scale);
  canvas.height = Math.max(1, (img.naturalHeight || 320) * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is not available in this browser.");
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--surface-1").trim();
  if (bg) {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("PNG export failed.");
  downloadBlob(blob, filename);
}
