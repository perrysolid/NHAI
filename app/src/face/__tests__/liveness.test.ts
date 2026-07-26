import {ActiveLivenessChallenge, evaluateDualLiveness} from '../liveness';
import {THRESHOLDS} from '../../config';
import {LIVENESS_ACTIONS} from '../livenessActions';
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
describe('ActiveLivenessChallenge', () => {
  it('defaults to livenessActionCount (2) unique actions from the full pool', () => {
    const c = new ActiveLivenessChallenge();
    const snap = c.start(0);
    expect(snap.actions).toHaveLength(THRESHOLDS.livenessActionCount);
    for (const action of snap.actions) {
      expect(LIVENESS_ACTIONS).toContain(action);
    }
    expect(new Set(snap.actions).size).toBe(snap.actions.length);
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

  it('completes a full blink -> turnLeft sequence in order', () => {
    const c = new ActiveLivenessChallenge(Math.random, ['blink', 'turnLeft']);
    c.start(0);
    c.update(open, 100);
    c.update(closed, 200);
    expect(c.update(open, 300).status).toBe('running');
    c.update(face({yawAngle: 0}), 400);
    expect(
      c.update(face({yawAngle: -THRESHOLDS.headTurnDeltaDeg - 5}), 500).status,
    ).toBe('passed');
  });

  it('fails when the demanded order is not followed (replay defense)', () => {
    const c = new ActiveLivenessChallenge(Math.random, ['turnLeft', 'blink']);
    c.start(0);
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

  it('both actions must complete for challenge to pass', () => {
    const c = new ActiveLivenessChallenge(Math.random, ['smile', 'blink']);
    c.start(0);
    expect(
      c.update(face({smilingProbability: 0.95}), 100).status,
    ).toBe('running');
    expect(
      c.update(open, 2000).status,
    ).toBe('running');
  });

  it('missing first action (turn) cannot skip ahead to second action (blink)', () => {
    const c = new ActiveLivenessChallenge(Math.random, ['turnLeft', 'blink']);
    c.start(0);
    c.update(closed, 100);
    expect(c.update(open, 200).status).toBe('running');
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
