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

describe('active liveness', () => {
  it('passes a blink on a full open-close-open cycle', () => {
    const c = new ActiveLivenessChallenge(() => 0.99, 0);
    c.start(0);
    expect(c.update(open, 100).status).toBe('running');
    expect(c.update(closed, 200).status).toBe('running');
    expect(c.update(open, 300).status).toBe('passed');
  });

  it('rejects a static open-eyed photo (the spoof case)', () => {
    const c = new ActiveLivenessChallenge(() => 0.99, 0);
    c.start(0);
    // a held photo: eyes never close, no motion
    for (let t = 100; t <= THRESHOLDS.activeChallengeTimeoutMs; t += 200) {
      c.update(open, t);
    }
    expect(
      c.update(open, THRESHOLDS.activeChallengeTimeoutMs + 200).status,
    ).toBe('failed');
  });

  it('rejects when there is no real eye motion even if a frame reads closed', () => {
    // a near-flat signal that barely dips cannot span the motion range
    const c = new ActiveLivenessChallenge(() => 0.99, 0);
    c.start(0);
    const flatHigh = face({
      leftEyeOpenProbability: 0.95,
      rightEyeOpenProbability: 0.95,
    });
    expect(c.update(flatHigh, 100).status).toBe('running');
    expect(c.update(flatHigh, 200).status).toBe('running');
  });

  it('fails when timeout elapses', () => {
    const c = new ActiveLivenessChallenge(() => 0.99, 0);
    c.start(0);
    expect(
      c.update(open, THRESHOLDS.activeChallengeTimeoutMs + 1000).status,
    ).toBe('failed');
  });

  it('requires BOTH active and passive liveness to pass', () => {
    expect(
      evaluateDualLiveness({passiveScore: 0.8, activeStatus: 'passed'}).passed,
    ).toBe(true);
    // active passed but passive too low -> blocked (was the spoof hole)
    expect(
      evaluateDualLiveness({passiveScore: 0.2, activeStatus: 'passed'}).passed,
    ).toBe(false);
    // passive fine but active not passed -> blocked
    expect(
      evaluateDualLiveness({passiveScore: 0.8, activeStatus: 'failed'}).passed,
    ).toBe(false);
  });
});
