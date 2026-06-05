/**
 * geometry — pure landmark math used for liveness + pose gating.
 *
 * face-api gives 68 landmarks. We derive:
 *  - Eye Aspect Ratio (EAR) for blink detection
 *  - rough yaw/pitch estimates from eye/nose/box geometry (face-api doesn't
 *    expose Euler angles), good enough to gate "look straight" and detect a turn.
 */
export interface Pt {
  x: number;
  y: number;
}
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function centroid(pts: Pt[]): Pt {
  const s = pts.reduce((acc, p) => ({x: acc.x + p.x, y: acc.y + p.y}), {
    x: 0,
    y: 0,
  });
  return {x: s.x / pts.length, y: s.y / pts.length};
}

/**
 * Eye Aspect Ratio for a 6-point eye (face-api getLeftEye/getRightEye order):
 * EAR = (|p1-p5| + |p2-p4|) / (2 * |p0-p3|).
 * High (~0.3) when open, low (~0.1) when closed.
 */
export function eyeAspectRatio(eye: Pt[]): number {
  if (eye.length < 6) {
    return 0;
  }
  const vert = dist(eye[1], eye[5]) + dist(eye[2], eye[4]);
  const horiz = 2 * dist(eye[0], eye[3]);
  return horiz === 0 ? 0 : vert / horiz;
}

export function averageEAR(leftEye: Pt[], rightEye: Pt[]): number {
  return (eyeAspectRatio(leftEye) + eyeAspectRatio(rightEye)) / 2;
}

/**
 * Rough yaw (left/right head turn) in degrees from eye centers + nose tip.
 * Sign: positive ≈ turned to subject's left. Heuristic, not calibrated.
 */
export function estimateYawDeg(
  leftEye: Pt[],
  rightEye: Pt[],
  noseTip: Pt,
): number {
  const lc = centroid(leftEye);
  const rc = centroid(rightEye);
  const eyeMid = {x: (lc.x + rc.x) / 2, y: (lc.y + rc.y) / 2};
  const interocular = dist(lc, rc) || 1;
  // horizontal nose offset from the eye midpoint, normalized by eye spacing.
  const offset = (noseTip.x - eyeMid.x) / interocular;
  return offset * 90; // map ~[-1,1] to ~[-90,90] deg
}

/** Rough pitch (up/down) in degrees from nose vs eye line, normalized by box. */
export function estimatePitchDeg(
  leftEye: Pt[],
  rightEye: Pt[],
  noseTip: Pt,
  box: Box,
): number {
  const lc = centroid(leftEye);
  const rc = centroid(rightEye);
  const eyeMidY = (lc.y + rc.y) / 2;
  const expected = box.height * 0.33; // nose sits ~1/3 below the eyes when frontal
  const actual = noseTip.y - eyeMidY;
  const norm = (actual - expected) / (box.height || 1);
  return norm * 90;
}
