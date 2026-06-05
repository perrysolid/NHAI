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

describe('active liveness', () => {
  it('passes a blink challenge on closed to open eyes', () => {
    const challenge = new ActiveLivenessChallenge(() => 0.99, 1);
    challenge.start(0);
    expect(
      challenge.update(
        face({leftEyeOpenProbability: 0, rightEyeOpenProbability: 0}),
        100,
      ).status,
    ).toBe('running');
    expect(
      challenge.update(
        face({leftEyeOpenProbability: 1, rightEyeOpenProbability: 1}),
        200,
      ).status,
    ).toBe('passed');
  });

  it('fails when timeout elapses', () => {
    const challenge = new ActiveLivenessChallenge(() => 0.99, 1);
    challenge.start(0);
    expect(
      challenge.update(face(), THRESHOLDS.activeChallengeTimeoutMs + 1000)
        .status,
    ).toBe('failed');
  });

  it('uses active liveness as the pass/fail source and reports passive status', () => {
    const highPassive = evaluateDualLiveness({
      passiveScore: 0.8,
      activeStatus: 'passed',
    });
    expect(highPassive.passed).toBe(true);
    expect(highPassive.passivePassed).toBe(true);

    const lowPassive = evaluateDualLiveness({
      passiveScore: 0.2,
      activeStatus: 'passed',
    });
    expect(lowPassive.passed).toBe(true);
    expect(lowPassive.passivePassed).toBe(false);

    expect(
      evaluateDualLiveness({passiveScore: 0.8, activeStatus: 'failed'}).passed,
    ).toBe(false);
  });
});
