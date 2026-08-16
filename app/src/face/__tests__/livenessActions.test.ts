import {
  LIVENESS_ACTIONS,
  ACTION_LABEL,
  freshActionState,
  isActionSatisfied,
} from '../livenessActions';
import type {Face} from '../../camera/types';
import {THRESHOLDS} from '../../config';

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

describe('LIVENESS_ACTIONS', () => {
  it('has all 4 expected actions', () => {
    expect(LIVENESS_ACTIONS).toEqual([
      'blink',
      'smile',
      'turnLeft',
      'turnRight',
    ]);
  });

  it('every action has a non-empty label', () => {
    for (const action of LIVENESS_ACTIONS) {
      expect(ACTION_LABEL[action]).toBeTruthy();
    }
  });
});

describe('freshActionState', () => {
  it('returns a fresh state with expected defaults', () => {
    const state = freshActionState();
    expect(state.blinkPhase).toBe('await_open');
    expect(state.minEye).toBe(1);
    expect(state.maxEye).toBe(0);
    expect(state.baselineYaw).toBeNull();
  });
});

describe('isActionSatisfied', () => {
  describe('blink', () => {
    it('detects a full open-close-open cycle', () => {
      const state = freshActionState();
      expect(
        isActionSatisfied(
          'blink',
          face({leftEyeOpenProbability: 1, rightEyeOpenProbability: 1}),
          state,
        ),
      ).toBe(false);
      expect(state.blinkPhase).toBe('await_close');

      expect(
        isActionSatisfied(
          'blink',
          face({leftEyeOpenProbability: 0, rightEyeOpenProbability: 0}),
          state,
        ),
      ).toBe(false);
      expect(state.blinkPhase).toBe('await_reopen');

      expect(
        isActionSatisfied(
          'blink',
          face({leftEyeOpenProbability: 1, rightEyeOpenProbability: 1}),
          state,
        ),
      ).toBe(true);
    });

    it('rejects a flat reading (no range) even if cutoffs are hit', () => {
      const state = freshActionState();
      state.blinkPhase = 'await_reopen';
      state.minEye = 0.45;
      state.maxEye = 0.55;
      expect(
        isActionSatisfied(
          'blink',
          face({leftEyeOpenProbability: 0.5, rightEyeOpenProbability: 0.5}),
          state,
        ),
      ).toBe(false);
    });

    it('requires both eyes to register open before detecting a close', () => {
      const state = freshActionState();
      expect(
        isActionSatisfied(
          'blink',
          face({leftEyeOpenProbability: 1, rightEyeOpenProbability: 1}),
          state,
        ),
      ).toBe(false);
      expect(state.blinkPhase).toBe('await_close');
    });
  });

  describe('smile', () => {
    it('returns true when smilingProbability meets threshold', () => {
      const state = freshActionState();
      expect(
        isActionSatisfied(
          'smile',
          face({smilingProbability: THRESHOLDS.smileProb}),
          state,
        ),
      ).toBe(true);
    });

    it('returns false when smilingProbability is below threshold', () => {
      const state = freshActionState();
      expect(
        isActionSatisfied('smile', face({smilingProbability: 0}), state),
      ).toBe(false);
    });
  });

  describe('turnLeft', () => {
    it('returns true when yaw decreases by at least headTurnDeltaDeg', () => {
      const state = freshActionState();
      expect(isActionSatisfied('turnLeft', face({yawAngle: 10}), state)).toBe(
        false,
      );
      expect(
        isActionSatisfied(
          'turnLeft',
          face({yawAngle: 10 - THRESHOLDS.headTurnDeltaDeg - 1}),
          state,
        ),
      ).toBe(true);
    });

    it('returns false for rightward yaw (positive delta)', () => {
      const state = freshActionState();
      isActionSatisfied('turnLeft', face({yawAngle: 0}), state);
      expect(
        isActionSatisfied(
          'turnLeft',
          face({yawAngle: THRESHOLDS.headTurnDeltaDeg + 1}),
          state,
        ),
      ).toBe(false);
    });
  });

  describe('turn baseline latching', () => {
    const beyondFrontal = THRESHOLDS.turnBaselineMaxYawDeg + 10;

    it('does not latch a baseline while the head is already turned', () => {
      const state = freshActionState();
      expect(
        isActionSatisfied('turnLeft', face({yawAngle: beyondFrontal}), state),
      ).toBe(false);
      expect(state.baselineYaw).toBeNull();
    });

    it('latches once the head returns to frontal, then measures from there', () => {
      const state = freshActionState();
      isActionSatisfied('turnLeft', face({yawAngle: beyondFrontal}), state);
      isActionSatisfied('turnLeft', face({yawAngle: 5}), state);
      expect(state.baselineYaw).toBe(5);
      expect(
        isActionSatisfied(
          'turnLeft',
          face({yawAngle: 5 - THRESHOLDS.headTurnDeltaDeg - 1}),
          state,
        ),
      ).toBe(true);
    });

    it('keeps the turn target inside the quality gate from any baseline', () => {
      // Regression: latching a baseline at an extreme yaw put the target angle
      // outside ±maxYawDeg, making the action physically unsatisfiable — the
      // user turns and turns and it never registers. Bounding the baseline is
      // what guarantees the demanded angle is actually reachable.
      const worstBaseline = THRESHOLDS.turnBaselineMaxYawDeg;
      expect(worstBaseline + THRESHOLDS.headTurnDeltaDeg).toBeLessThan(
        THRESHOLDS.maxYawDeg,
      );
    });

    it('still requires motion — a tilted still face never satisfies a turn', () => {
      // The delta (not an absolute angle) is the security property: a photo
      // held at a fixed tilt must not pass "turn left".
      const state = freshActionState();
      const held = face({yawAngle: 15});
      for (let i = 0; i < 20; i++) {
        expect(isActionSatisfied('turnLeft', held, state)).toBe(false);
      }
    });
  });

  describe('turnRight', () => {
    it('returns true when yaw increases by at least headTurnDeltaDeg', () => {
      const state = freshActionState();
      expect(isActionSatisfied('turnRight', face({yawAngle: -10}), state)).toBe(
        false,
      );
      expect(
        isActionSatisfied(
          'turnRight',
          face({yawAngle: -10 + THRESHOLDS.headTurnDeltaDeg + 1}),
          state,
        ),
      ).toBe(true);
    });

    it('returns false for leftward yaw (negative delta)', () => {
      const state = freshActionState();
      isActionSatisfied('turnRight', face({yawAngle: 0}), state);
      expect(
        isActionSatisfied(
          'turnRight',
          face({yawAngle: -THRESHOLDS.headTurnDeltaDeg - 1}),
          state,
        ),
      ).toBe(false);
    });
  });
});
