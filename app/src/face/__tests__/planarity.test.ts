/**
 * Planarity tests.
 *
 * The important ones don't assert on hand-picked numbers — they build a
 * synthetic 3D head and a synthetic flat screen, rotate both under a real
 * perspective projection, and check the residual separates them. That is the
 * property the defence depends on; anything weaker just tests the arithmetic.
 */
import {
  MIN_MOTION,
  applyHomography,
  bestPlanarityResidual,
  homographyFromFourPoints,
  interocularDistance,
  planarityResidual,
} from '../planarity';
import type {FaceLandmarks, Point} from '../../camera/types';

/** A face in 3D millimetres: origin between the eyes, +z toward the camera. */
interface Point3 {
  x: number;
  y: number;
  z: number;
}

const HEAD: Record<keyof FaceLandmarks, Point3> = {
  leftEye: {x: -32, y: 0, z: 0},
  rightEye: {x: 32, y: 0, z: 0},
  // The nose protrudes ~21 mm. This is the entire signal.
  noseBase: {x: 0, y: 42, z: 21},
  mouthLeft: {x: -24, y: 72, z: 0},
  mouthRight: {x: 24, y: 72, z: 0},
};

/** Same landmarks, but printed on a flat surface — every z is 0. */
const FLAT: Record<keyof FaceLandmarks, Point3> = Object.fromEntries(
  Object.entries(HEAD).map(([k, p]) => [k, {...p, z: 0}]),
) as Record<keyof FaceLandmarks, Point3>;

const CAMERA_DISTANCE = 350; // mm, arm's length
const FOCAL = 900; // px

/** Rotate about the vertical axis by `yawDeg`, then project perspectively. */
function project(
  model: Record<keyof FaceLandmarks, Point3>,
  yawDeg: number,
): FaceLandmarks {
  const t = (yawDeg * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  const one = (p: Point3): Point => {
    const x = p.x * cos + p.z * sin;
    const z = -p.x * sin + p.z * cos;
    const depth = CAMERA_DISTANCE - z;
    return {x: (FOCAL * x) / depth, y: (FOCAL * p.y) / depth};
  };
  return {
    leftEye: one(model.leftEye),
    rightEye: one(model.rightEye),
    noseBase: one(model.noseBase),
    mouthLeft: one(model.mouthLeft),
    mouthRight: one(model.mouthRight),
  };
}

/** Add uniform pixel jitter, to model landmark detector noise. */
function jitter(lm: FaceLandmarks, px: number, seed = 1): FaceLandmarks {
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return (s / 0x7fffffff) * 2 - 1;
  };
  const j = (p: Point): Point => ({x: p.x + rnd() * px, y: p.y + rnd() * px});
  return {
    leftEye: j(lm.leftEye),
    rightEye: j(lm.rightEye),
    noseBase: j(lm.noseBase),
    mouthLeft: j(lm.mouthLeft),
    mouthRight: j(lm.mouthRight),
  };
}

describe('homography', () => {
  it('reproduces an exact projective mapping of four points', () => {
    const src = [
      {x: 0, y: 0},
      {x: 10, y: 0},
      {x: 10, y: 10},
      {x: 0, y: 10},
    ];
    const dst = [
      {x: 2, y: 1},
      {x: 13, y: 0},
      {x: 12, y: 11},
      {x: 1, y: 9},
    ];
    const h = homographyFromFourPoints(src, dst)!;
    expect(h).not.toBeNull();
    for (let i = 0; i < 4; i++) {
      const got = applyHomography(h, src[i])!;
      expect(got.x).toBeCloseTo(dst[i].x, 6);
      expect(got.y).toBeCloseTo(dst[i].y, 6);
    }
  });

  it('refuses a degenerate (collinear) configuration', () => {
    const collinear = [
      {x: 0, y: 0},
      {x: 1, y: 1},
      {x: 2, y: 2},
      {x: 3, y: 3},
    ];
    expect(homographyFromFourPoints(collinear, collinear)).toBeNull();
  });

  it('rejects wrong-sized inputs', () => {
    expect(homographyFromFourPoints([{x: 0, y: 0}], [{x: 0, y: 0}])).toBeNull();
  });
});

describe('planarity separates a 3D face from a flat surface', () => {
  it('a flat screen turning produces almost no residual', () => {
    // Every point is coplanar, so the homography explains the nose exactly.
    const r = planarityResidual(project(FLAT, 0), project(FLAT, 20));
    expect(r.usable).toBe(true);
    expect(r.residual).toBeLessThan(0.005);
  });

  it('a real head turning produces a large residual', () => {
    const r = planarityResidual(project(HEAD, 0), project(HEAD, 20));
    expect(r.usable).toBe(true);
    expect(r.residual).toBeGreaterThan(0.05);
  });

  it('separates them by a wide margin at every realistic turn angle', () => {
    // The margin is what a threshold would live in, so check the whole range
    // the challenge actually produces rather than one convenient angle.
    for (const yaw of [12, 15, 20, 25, 30]) {
      const flat = planarityResidual(project(FLAT, 0), project(FLAT, yaw));
      const head = planarityResidual(project(HEAD, 0), project(HEAD, yaw));
      expect(head.residual).toBeGreaterThan(flat.residual * 10);
    }
  });

  it('residual grows with rotation — more turn, more evidence', () => {
    const small = planarityResidual(project(HEAD, 0), project(HEAD, 10));
    const large = planarityResidual(project(HEAD, 0), project(HEAD, 30));
    expect(large.residual).toBeGreaterThan(small.residual);
  });

  it('works for a leftward turn too, not just rightward', () => {
    const r = planarityResidual(project(HEAD, 0), project(HEAD, -20));
    expect(r.usable).toBe(true);
    expect(r.residual).toBeGreaterThan(0.05);
  });
});

describe('honest failure modes', () => {
  it('reports unusable when the head barely moved', () => {
    // No rotation means no parallax, so a flat surface and a real face are
    // indistinguishable. This MUST read as unknown, never as "flat".
    const r = planarityResidual(project(HEAD, 0), project(HEAD, 0.5));
    expect(r.motion).toBeLessThan(MIN_MOTION);
    expect(r.usable).toBe(false);
  });

  it('a pure translation of a flat surface stays flat', () => {
    // Sliding a phone sideways is not parallax; it must not read as 3D.
    const base = project(FLAT, 0);
    const shift = (p: Point): Point => ({x: p.x + 40, y: p.y + 6});
    const moved: FaceLandmarks = {
      leftEye: shift(base.leftEye),
      rightEye: shift(base.rightEye),
      noseBase: shift(base.noseBase),
      mouthLeft: shift(base.mouthLeft),
      mouthRight: shift(base.mouthRight),
    };
    const r = planarityResidual(base, moved);
    expect(r.usable).toBe(true);
    expect(r.residual).toBeLessThan(0.005);
  });

  it('a flat surface scaled toward the camera stays flat', () => {
    const base = project(FLAT, 0);
    const zoom = (p: Point): Point => ({x: p.x * 1.3, y: p.y * 1.3});
    const closer: FaceLandmarks = {
      leftEye: zoom(base.leftEye),
      rightEye: zoom(base.rightEye),
      noseBase: zoom(base.noseBase),
      mouthLeft: zoom(base.mouthLeft),
      mouthRight: zoom(base.mouthRight),
    };
    expect(planarityResidual(base, closer).residual).toBeLessThan(0.005);
  });

  it('survives realistic landmark jitter', () => {
    // ML Kit landmarks are noisy. The separation has to hold anyway, or the
    // check is a lab curiosity. ~1.5 px of jitter on a ~165 px eye separation.
    const flat = planarityResidual(
      jitter(project(FLAT, 0), 1.5, 7),
      jitter(project(FLAT, 22), 1.5, 21),
    );
    const head = planarityResidual(
      jitter(project(HEAD, 0), 1.5, 7),
      jitter(project(HEAD, 22), 1.5, 21),
    );
    expect(head.residual).toBeGreaterThan(flat.residual * 3);
  });

  it('degenerate landmarks report unusable rather than flat', () => {
    const same: Point = {x: 5, y: 5};
    const degenerate: FaceLandmarks = {
      leftEye: same,
      rightEye: same,
      noseBase: same,
      mouthLeft: same,
      mouthRight: same,
    };
    expect(planarityResidual(degenerate, degenerate).usable).toBe(false);
  });
});

describe('bestPlanarityResidual', () => {
  it('picks the frame with the most parallax across a turn', () => {
    const seq = [0, 4, 10, 18, 26].map(y => project(HEAD, y));
    const best = bestPlanarityResidual(seq);
    expect(best.usable).toBe(true);
    // Should match the widest turn, which carries the most evidence.
    expect(best.residual).toBeCloseTo(
      planarityResidual(seq[0], seq[4]).residual,
      6,
    );
  });

  it('reports unusable for a sequence that never moved', () => {
    const still = [0, 0.1, 0.2].map(y => project(HEAD, y));
    expect(bestPlanarityResidual(still).usable).toBe(false);
  });

  it('a flat surface stays low across a whole turn sequence', () => {
    const seq = [0, 5, 12, 20, 28].map(y => project(FLAT, y));
    expect(bestPlanarityResidual(seq).residual).toBeLessThan(0.005);
  });

  it('handles an empty or single-frame sequence', () => {
    expect(bestPlanarityResidual([]).usable).toBe(false);
    expect(bestPlanarityResidual([project(HEAD, 0)]).usable).toBe(false);
  });
});

describe('interocularDistance', () => {
  it('measures eye separation in pixels', () => {
    const lm = project(HEAD, 0);
    expect(interocularDistance(lm)).toBeCloseTo(
      Math.hypot(lm.leftEye.x - lm.rightEye.x, lm.leftEye.y - lm.rightEye.y),
      6,
    );
  });
});
