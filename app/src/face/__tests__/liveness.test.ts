import {ActiveLivenessChallenge, evaluateDualLiveness} from '../liveness';
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
    expect(challenge.update(face(), 7000).status).toBe('failed');
  });

  it('requires passive and active liveness', () => {
    expect(
      evaluateDualLiveness({passiveScore: 0.8, activeStatus: 'passed'}).passed,
    ).toBe(true);
    expect(
      evaluateDualLiveness({passiveScore: 0.2, activeStatus: 'passed'}).passed,
    ).toBe(false);
  });
});
