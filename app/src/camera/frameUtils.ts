/**
 * frameUtils — small worklet-safe helpers for frame processing.
 *
 * These run on the VisionCamera worklet thread, so they must be marked
 * 'worklet' and avoid any JS-thread-only APIs.
 */

/**
 * Mean luma (0..255) of a tightly-packed RGB uint8 buffer.
 * Rec. 601 luma weights. Used as a cheap brightness gate after downscaling the
 * frame (e.g. to 16x16) with vision-camera-resize-plugin.
 */
export function meanLuma(rgb: Uint8Array): number {
  'worklet';
  const pixels = rgb.length / 3;
  if (pixels <= 0) {
    return 0;
  }
  let sum = 0;
  for (let i = 0; i < rgb.length; i += 3) {
    sum += 0.299 * rgb[i] + 0.587 * rgb[i + 1] + 0.114 * rgb[i + 2];
  }
  return sum / pixels;
}
