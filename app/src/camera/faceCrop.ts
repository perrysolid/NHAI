/**
 * faceCrop — align a detected face out of a full-frame RGB buffer.
 *
 * Why this exists: the recognition (MobileFaceNet/EdgeFace) and passive
 * anti-spoof (MiniFASNet) models are trained on a TIGHT, roughly-aligned face
 * crop — 112x112 for recognition, an ~2.7x face-box crop for MiniFASNet. Feeding
 * them a full-frame center-crop (the old worklet path) meant the models embedded
 * the whole scene, not the face, so recognition never matched and the anti-spoof
 * score was meaningless.
 *
 * The vision-camera-resize-plugin's own `crop` option is applied in the rotated
 * sensor buffer on Android, so a crop computed from frame/face coordinates lands
 * out of bounds and the plugin returns an EMPTY buffer ("got 0"). To avoid that
 * entirely, the worklet only ever does a plain full-frame downscale (a code path
 * that is reliable on-device), and we crop the face HERE, in pure JS, from that
 * downscaled RGB buffer using the face bounding box. Deterministic and unit
 * testable — no native/worklet dependency.
 */
import type {FaceBounds} from './types';

export interface CropRequest {
  /** Tightly-packed RGB uint8, length === width * height * 3. */
  rgb: Uint8Array | number[];
  width: number;
  height: number;
  /** Face box in the SAME pixel coordinate space as `rgb` (already scaled to it). */
  box: FaceBounds;
  /** Square crop side = max(box.width, box.height) * expansion, centred on the box. */
  expansion: number;
  /** Output is targetSize x targetSize x 3, tightly packed RGB. */
  targetSize: number;
  /** Rotate the sampling grid about the box centre by this many degrees so the
   *  output crop is upright. On this device the sensor buffer is landscape while
   *  the phone is portrait, so the face is rotated 90°; a quarter-turn here makes
   *  the crop upright for the recognition model. Default 0 = no rotation. */
  rotationDeg?: number;
}

/**
 * Scale a face box reported in frame coordinates into the coordinate space of a
 * uniformly downscaled buffer (mediumWidth = frameWidth * s).
 */
export function scaleBox(box: FaceBounds, scale: number): FaceBounds {
  return {
    x: box.x * scale,
    y: box.y * scale,
    width: box.width * scale,
    height: box.height * scale,
  };
}

/**
 * Crop a square, face-centred region and bilinearly resample it to
 * targetSize x targetSize RGB. Samples outside the buffer are edge-clamped, so a
 * face near the frame edge still yields a full crop instead of failing.
 */
export function cropFace(req: CropRequest): Uint8Array {
  const {rgb, width, height, box, expansion, targetSize, rotationDeg = 0} = req;
  if (width <= 0 || height <= 0) {
    throw new Error('cropFace: invalid buffer dimensions');
  }
  if (rgb.length < width * height * 3) {
    throw new Error(
      `cropFace: buffer too small (${rgb.length} < ${width * height * 3})`,
    );
  }

  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const side = Math.max(box.width, box.height) * expansion;

  // Rotate the sampling grid about the box centre so the output is upright.
  // For output pixel (u,v) centred on 0, sample the source at
  // (cx + u·cosθ − v·sinθ, cy + u·sinθ + v·cosθ). θ=0 reduces to the plain crop.
  const theta = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);

  const out = new Uint8Array(targetSize * targetSize * 3);
  const maxX = width - 1;
  const maxY = height - 1;

  for (let oy = 0; oy < targetSize; oy++) {
    const v = ((oy + 0.5) / targetSize - 0.5) * side;
    for (let ox = 0; ox < targetSize; ox++) {
      const u = ((ox + 0.5) / targetSize - 0.5) * side;
      const sx = cx + u * cos - v * sin;
      const sy = cy + u * sin + v * cos;
      const cxF = clamp(sx, 0, maxX);
      const cyF = clamp(sy, 0, maxY);
      const x1 = Math.floor(cxF);
      const x2 = Math.min(x1 + 1, maxX);
      const fx = cxF - x1;
      const y1 = Math.floor(cyF);
      const y2 = Math.min(y1 + 1, maxY);
      const fy = cyF - y1;

      const oBase = (oy * targetSize + ox) * 3;
      for (let c = 0; c < 3; c++) {
        const p11 = rgb[(y1 * width + x1) * 3 + c];
        const p12 = rgb[(y1 * width + x2) * 3 + c];
        const p21 = rgb[(y2 * width + x1) * 3 + c];
        const p22 = rgb[(y2 * width + x2) * 3 + c];
        const top = p11 + (p12 - p11) * fx;
        const bottom = p21 + (p22 - p21) * fx;
        out[oBase + c] = Math.round(top + (bottom - top) * fy);
      }
    }
  }
  return out;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
