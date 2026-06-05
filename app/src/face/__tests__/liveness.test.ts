import {ActiveLivenessChallenge, evaluateDualLiveness} from '../liveness';
import {THRESHOLDS} from '../../config';
import type {Face} from '../../camera/types';

function face(overrides: Partial<Face> = {}): Face {
  return {
    bounds: {x: 0, y: 0, width: 400, height: 400},
    yawAngle: 0,
    pitchAngle: 0,
    rollAngle: 0,
    leftEyeOpenProbability: 1,
    rightEyeOpenProbability: 1,
    smilingProbability: 0,
    ...overrides,
  };
}
const open = face({leftEyeOpenProbability: 1, rightEyeOpenProbability: 1});
const closed = face({leftEyeOpenProbability: 0, rightEyeOpenProbability: 0});

describe('active liveness (3-layer randomized)', () => {
  it('always demands a blink plus a head turn', () => {
    const c = new ActiveLivenessChallenge();
    const snap = c.start(0);
    expect(snap.challenges).toContain('blink');
    expect(snap.challenges).toContain('turn');
    expect(snap.challenges.length).toBe(3);
  });

  it('passes a blink on a full open-close-open cycle', () => {
    const c = new ActiveLivenessChallenge(Math.random, ['blink']);
    c.start(0);
    expect(c.update(open, 100).status).toBe('running');
    expect(c.update(closed, 200).status).toBe('running');
    expect(c.update(open, 300).status).toBe('passed');
  });

  it('rejects a static open-eyed photo (the spoof case)', () => {
    const c = new ActiveLivenessChallenge(Math.random, ['blink']);
    c.start(0);
    for (let t = 100; t <= THRESHOLDS.activeChallengeTimeoutMs; t += 200) {
      c.update(open, t);
    }
    expect(
      c.update(open, THRESHOLDS.activeChallengeTimeoutMs + 200).status,
    ).toBe('failed');
  });

  it('completes a full blink -> turn -> nod sequence in order', () => {
    const c = new ActiveLivenessChallenge(Math.random, [
      'blink',
      'turn',
      'nod',
    ]);
    c.start(0);
    c.update(open, 100);
    c.update(closed, 200);
    expect(c.update(open, 300).status).toBe('running'); // blink done
    c.update(face({yawAngle: 0}), 400); // turn baseline (frontal)
    expect(
      c.update(face({yawAngle: THRESHOLDS.headTurnDeltaDeg + 5}), 500).status,
    ).toBe('running'); // turn done
    c.update(face({pitchAngle: 0}), 600); // nod baseline (frontal)
    expect(
      c.update(face({pitchAngle: THRESHOLDS.nodPitchDeltaDeg + 5}), 700).status,
    ).toBe('passed'); // nod done
  });

  it('fails when the demanded order is not followed (replay defense)', () => {
    const c = new ActiveLivenessChallenge(Math.random, ['turn', 'blink']);
    c.start(0);
    // doing the blink first does not satisfy the turn step
    c.update(closed, 100);
    expect(c.update(open, 200).status).toBe('running');
  });

  it('fails when timeout elapses', () => {
    const c = new ActiveLivenessChallenge(Math.random, ['blink']);
    c.start(0);
    expect(
      c.update(open, THRESHOLDS.activeChallengeTimeoutMs + 1000).status,
    ).toBe('failed');
  });

  it('requires BOTH active and passive liveness to pass', () => {
    expect(
      evaluateDualLiveness({passiveScore: 0.8, activeStatus: 'passed'}).passed,
    ).toBe(true);
    expect(
      evaluateDualLiveness({passiveScore: 0.2, activeStatus: 'passed'}).passed,
    ).toBe(false);
    expect(
      evaluateDualLiveness({passiveScore: 0.8, activeStatus: 'failed'}).passed,
    ).toBe(false);
  });
});
