/**
 * planarity — tells a real 3D face from a flat one (phone screen, printed photo)
 * using nothing but the 5 landmarks the detector already returns.
 *
 * THE IDEA. When a surface rotates, how its points move on screen depends on its
 * shape. For a FLAT surface every point's motion is explained exactly by a
 * homography — an 8-DOF projective transform. A real face is not flat, so no
 * homography can explain it, and the leftover error is the depth signal.
 *
 * ML Kit's 5 landmarks happen to be exactly the right 5:
 *   • the two eyes and two mouth corners sit roughly on one plane, and 4 point
 *     correspondences determine a homography EXACTLY (8 equations, 8 unknowns);
 *   • the NOSE TIP is the one landmark clearly off that plane (~2 cm proud).
 * So: fit the homography on the 4 coplanar points, use it to predict where the
 * nose should land, and compare with where the nose actually landed.
 *
 *   flat screen or photo  → everything coplanar → prediction correct → residual ~0
 *   real face             → nose protrudes      → prediction wrong   → residual large
 *
 * WHY THIS AND NOT A FLASH CHECK. Reflection-based liveness needs the emitted
 * light to compete with ambient, and a phone screen delivers ~100 lux against
 * 100,000 lux of Indian daylight — 0.1% SNR. This uses motion instead of light,
 * so it is unaffected by sun. It also needs no torch (front cameras have none),
 * no new model, and no extra user effort: the verify challenge already asks the
 * user to turn their head, which is precisely the motion this measures.
 *
 * It is the poor-man's version of what Face ID does. Face ID projects 30,000
 * known IR dots and measures how the face distorts the pattern — structured
 * light. Here we recover the same 3D information from motion instead of
 * projection — structure from motion. Same signal, no projector.
 *
 * Pure and deterministic, so it is unit-tested. No native or worklet dependency.
 */
import type {FaceLandmarks, Point} from '../camera/types';

/** Row-major 3x3 homography, h[8] fixed at 1. */
export type Homography = readonly number[];

/**
 * Solve `A x = b` by Gaussian elimination with partial pivoting.
 * Returns null when the system is singular — i.e. the points were degenerate
 * (collinear or coincident), which must never be treated as "flat".
 */
function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) {
        pivot = r;
      }
    }
    if (Math.abs(m[pivot][col]) < 1e-9) {
      return null; // singular: degenerate landmark configuration
    }
    [m[col], m[pivot]] = [m[pivot], m[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) {
        continue;
      }
      const f = m[r][col] / m[col][col];
      for (let c = col; c <= n; c++) {
        m[r][c] -= f * m[col][c];
      }
    }
  }
  // Gauss-Jordan leaves the matrix diagonal, so each unknown is just the
  // augmented column over the diagonal entry of its own row.
  return m.map((row, i) => row[n] / row[i]);
}

/**
 * Exact homography mapping four `src` points onto four `dst` points (DLT).
 * Four correspondences give 8 equations for the 8 free parameters, so this is a
 * determined solve, not a least-squares fit — which is what lets the fifth
 * point (the nose) act as an independent test.
 */
export function homographyFromFourPoints(
  src: readonly Point[],
  dst: readonly Point[],
): Homography | null {
  if (src.length !== 4 || dst.length !== 4) {
    return null;
  }
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const {x, y} = src[i];
    const {x: u, y: v} = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const h = solve(A, b);
  return h ? [...h, 1] : null;
}

/** Apply a homography to a point. Null if the point maps to infinity. */
export function applyHomography(h: Homography, p: Point): Point | null {
  const w = h[6] * p.x + h[7] * p.y + h[8];
  if (Math.abs(w) < 1e-9) {
    return null;
  }
  return {
    x: (h[0] * p.x + h[1] * p.y + h[2]) / w,
    y: (h[3] * p.x + h[4] * p.y + h[5]) / w,
  };
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** Eye separation — the natural scale for normalizing pixel distances. */
export function interocularDistance(lm: FaceLandmarks): number {
  return dist(lm.leftEye, lm.rightEye);
}

export interface PlanarityResult {
  /** Nose reprojection error as a FRACTION of interocular distance.
   *  ~0 = flat surface, larger = genuine 3D structure. */
  residual: number;
  /** How much the head actually turned between the two frames, in units of
   *  interocular distance. The residual is only meaningful once this is
   *  non-trivial — no rotation means no parallax to measure. */
  motion: number;
  /** False when the geometry was degenerate or there was too little motion to
   *  judge. Callers must treat this as UNKNOWN, never as "flat". */
  usable: boolean;
}

/**
 * Minimum inter-frame motion, in interocular units, before the residual means
 * anything. Below this the landmarks have barely moved, so a flat surface and a
 * real face are indistinguishable and any residual is landmark noise.
 *
 * Calibrated against a simulated head (65 mm eye separation, 21 mm nose relief)
 * at 350 mm under perspective projection. Note how little the landmarks
 * actually translate during a yaw — a rotation mostly COMPRESSES the projected
 * face rather than moving it, so this number is much smaller than it looks:
 *
 *     yaw    motion    residual (3D head)    residual (flat)
 *      5°    0.0056        0.031                 0.0000
 *     12°    0.0150        0.074                 0.0000
 *     20°    0.0345        0.127                 0.0000
 *     30°    0.0747        0.200                 0.0000
 *
 * 0.012 sits just below the 12° that THRESHOLDS.headTurnDeltaDeg already
 * demands, so any turn the challenge accepts also yields a usable measurement,
 * while a near-still face is correctly reported unknown.
 */
export const MIN_MOTION = 0.012;

/**
 * Compare two observations of the same face and report how non-planar the
 * motion between them was.
 *
 * Both landmark sets must be in the SAME pixel coordinate space.
 */
export function planarityResidual(
  before: FaceLandmarks,
  after: FaceLandmarks,
): PlanarityResult {
  const scale = interocularDistance(after);
  const unusable: PlanarityResult = {residual: 0, motion: 0, usable: false};
  if (!(scale > 1e-6)) {
    return unusable;
  }

  // The four points assumed coplanar. The nose is deliberately excluded — it is
  // the test point, and including it would let the fit absorb the very signal
  // being measured.
  const src = [
    before.leftEye,
    before.rightEye,
    before.mouthLeft,
    before.mouthRight,
  ];
  const dst = [
    after.leftEye,
    after.rightEye,
    after.mouthLeft,
    after.mouthRight,
  ];

  // Motion is measured on the plane points only, so a mis-tracked nose cannot
  // inflate it and make a weak observation look usable.
  const motion =
    src.reduce((sum, p, i) => sum + dist(p, dst[i]), 0) / src.length / scale;

  const h = homographyFromFourPoints(src, dst);
  if (!h) {
    return {residual: 0, motion, usable: false};
  }
  const predicted = applyHomography(h, before.noseBase);
  if (!predicted) {
    return {residual: 0, motion, usable: false};
  }

  return {
    residual: dist(predicted, after.noseBase) / scale,
    motion,
    usable: motion >= MIN_MOTION,
  };
}

/**
 * Best (largest) usable residual across a sequence of observations, comparing
 * every later frame against the first.
 *
 * Largest rather than mean on purpose: parallax grows with rotation, so the
 * frames at the extremes of the turn carry the signal and the ones near the
 * start carry none. Averaging would dilute the evidence with frames that were
 * never informative.
 */
export function bestPlanarityResidual(
  frames: readonly FaceLandmarks[],
): PlanarityResult {
  let best: PlanarityResult = {residual: 0, motion: 0, usable: false};
  for (let i = 1; i < frames.length; i++) {
    const r = planarityResidual(frames[0], frames[i]);
    if (r.usable && r.residual > best.residual) {
      best = r;
    } else if (!best.usable && r.motion > best.motion) {
      best = r; // keep the most informative unusable one for diagnostics
    }
  }
  return best;
}
