/**
 * brightness — cheap mean-luma probe by drawing the video onto a tiny canvas.
 * Mirrors the native meanLuma() brightness gate.
 */
export function sampleBrightness(
  source: HTMLVideoElement | HTMLCanvasElement,
  scratch: HTMLCanvasElement,
): number {
  const w = 16;
  const h = 16;
  scratch.width = w;
  scratch.height = h;
  const ctx = scratch.getContext('2d', {willReadFrequently: true});
  if (!ctx) {
    return 128;
  }
  try {
    ctx.drawImage(source, 0, 0, w, h);
    const {data} = ctx.getImageData(0, 0, w, h);
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) {
      sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
    return sum / (w * h);
  } catch {
    return 128; // e.g. tainted canvas before stream is ready
  }
}
