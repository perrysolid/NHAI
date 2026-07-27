/**
 * faceAlign — ArcFace-style 5-point similarity alignment (the ideal crop for
 * EdgeFace-S / MobileFaceNet).
 *
 * These models are trained on faces warped by a similarity transform (rotation +
 * uniform scale + translation) that pins 5 landmarks — the two eyes, nose base,
 * and the two mouth corners — onto a fixed 112x112 template. This one transform
 * simultaneously:
 *   • rotates the face upright (so no separate orientation hack is needed),
 *   • scales it to a consistent size,
 *   • centres it, cropping out background.
 * A plain bounding-box crop does none of these, which is why genuine/impostor
 * cosine distributions overlap without it.
 *
 * Pure, deterministic, unit-testable. Samples the output through the inverse
 * transform (edge-clamped bilinear), exactly like faceCrop.
 */
import type {FaceLandmarks, Point} from './types';

/** InsightFace / ArcFace canonical 5-point template for a 112x112 crop, in
 *  (leftEye, rightEye, nose, mouthLeft, mouthRight) order. */
export const ARCFACE_TEMPLATE_112: readonly Point[] = [
  {x: 38.2946, y: 51.6963},
  {x: 73.5318, y: 51.5014},
  {x: 56.0252, y: 71.7366},
  {x: 41.5493, y: 92.3655},
  {x: 70.7299, y: 92.2041},
];

export interface SimilarityTransform {
  a: number;
  b: number;
  tx: number;
  ty: number;
}

/**
 * Least-squares 2D similarity transform (rotation + uniform scale + translation,
 * no reflection) mapping `src` onto `dst`. Closed form via centroids.
 */
export function similarityTransform(
  src: readonly Point[],
  dst: readonly Point[],
): SimilarityTransform {
  const n = src.length;
  if (n < 2 || n !== dst.length) {
    throw new Error('similarityTransform: need >=2 matched point pairs');
  }
  let msx = 0;
  let msy = 0;
  let mdx = 0;
  let mdy = 0;
  for (let i = 0; i < n; i++) {
    msx += src[i].x;
    msy += src[i].y;
    mdx += dst[i].x;
    mdy += dst[i].y;
  }
  msx /= n;
  msy /= n;
  mdx /= n;
  mdy /= n;

  let num = 0;
  let cross = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const csx = src[i].x - msx;
    const csy = src[i].y - msy;
    const cdx = dst[i].x - mdx;
    const cdy = dst[i].y - mdy;
    num += csx * cdx + csy * cdy;
    cross += csx * cdy - csy * cdx;
    den += csx * csx + csy * csy;
  }
  if (den === 0) {
    throw new Error('similarityTransform: degenerate source points');
  }
  const a = num / den;
  const b = cross / den;
  const tx = mdx - (a * msx - b * msy);
  const ty = mdy - (b * msx + a * msy);
  return {a, b, tx, ty};
}

export interface AlignRequest {
  rgb: Uint8Array | number[];
  width: number;
  height: number;
  /** 5 landmarks in the SAME pixel coordinate space as `rgb`. */
  landmarks: FaceLandmarks;
  /** Output side (square). Recognition models use 112. */
  targetSize: number;
  template?: readonly Point[];
}

function toSrcPoints(l: FaceLandmarks): Point[] {
  return [l.leftEye, l.rightEye, l.noseBase, l.mouthLeft, l.mouthRight];
}

/** Warp a face into the canonical template frame: targetSize x targetSize RGB. */
export function alignFace(req: AlignRequest): Uint8Array {
  const {rgb, width, height, landmarks, targetSize} = req;
  if (width <= 0 || height <= 0) {
    throw new Error('alignFace: invalid buffer dimensions');
  }
  if (rgb.length < width * height * 3) {
    throw new Error(
      `alignFace: buffer too small (${rgb.length} < ${width * height * 3})`,
    );
  }
  const scale = targetSize / 112;
  const template =
    req.template ??
    ARCFACE_TEMPLATE_112.map(p => ({x: p.x * scale, y: p.y * scale}));

  const t = similarityTransform(toSrcPoints(landmarks), template);
  const det = t.a * t.a + t.b * t.b;
  if (det === 0) {
    throw new Error('alignFace: non-invertible transform');
  }
  const ia = t.a / det;
  const ib = t.b / det;

  const out = new Uint8Array(targetSize * targetSize * 3);
  const maxX = width - 1;
  const maxY = height - 1;

  for (let oy = 0; oy < targetSize; oy++) {
    const dy = oy + 0.5 - t.ty;
    for (let ox = 0; ox < targetSize; ox++) {
      const dx = ox + 0.5 - t.tx;
      const sx = ia * dx + ib * dy;
      const sy = -ib * dx + ia * dy;

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
