/**
 * livenessActions — the single, shared definition of every active-liveness
 * gesture: blink, smile, turn-left, turn-right. Used by BOTH the enrollment
 * flow (screens/CameraScreen.tsx, which walks through every action once) and
 * the verify challenge (face/liveness.ts, which picks a random subset) — one
 * implementation, not two, so a fix or a new action only needs to happen here.
 *
 * To add a new action:
 *   1. Add its id to LIVENESS_ACTIONS (and LivenessActionKind).
 *   2. Add any state it needs to ActionState / freshActionState.
 *   3. Add a case to isActionSatisfied.
 *   4. Add its guidance text to i18n.ts's LIVENESS_TEXT.
 * Nothing else needs to change — both enrollment and verify pick it up
 * automatically (enrollment iterates LIVENESS_ACTIONS; verify samples from it).
 */
import {THRESHOLDS} from '../config';
import type {Face} from '../camera/types';

export type LivenessActionKind = 'blink' | 'smile' | 'turnLeft' | 'turnRight';

/** The full pool of supported actions, in the fixed order enrollment uses. */
export const LIVENESS_ACTIONS: LivenessActionKind[] = [
  'blink',
  'smile',
  'turnLeft',
  'turnRight',
];

/** Short display label for checklists/buttons. */
export const ACTION_LABEL: Record<LivenessActionKind, string> = {
  blink: 'Blink',
  smile: 'Smile',
  turnLeft: 'Turn Head Left',
  turnRight: 'Turn Head Right',
};

/** Per-action mutable tracking state. Reset (freshActionState()) whenever the
 *  active action changes — leftover phase/baseline from a previous action
 *  would otherwise corrupt detection of the next one. */
export interface ActionState {
  blinkPhase: 'await_open' | 'await_close' | 'await_reopen';
  minEye: number;
  maxEye: number;
  baselineYaw: number | null;
}

export function freshActionState(): ActionState {
  return {
    blinkPhase: 'await_open',
    minEye: 1,
    maxEye: 0,
    baselineYaw: null,
  };
}

/**
 * Latch the reference yaw a turn is measured against, but only once the head is
 * roughly frontal. Returns true when a baseline is available.
 *
 * A turn is verified as a DELTA (motion is the security property — an absolute
 * angle would let a photo held at a tilt satisfy "turn left" without moving).
 * The hazard is the baseline itself: latch it while the user already happens to
 * be turned and the target angle lands outside the ±maxYawDeg quality gate, so
 * the action can never be satisfied no matter how far they turn. Deferring until
 * frontal bounds the baseline to ±turnBaselineMaxYawDeg, keeping
 * baseline ± headTurnDeltaDeg comfortably inside the gate.
 */
function captureTurnBaseline(face: Face, state: ActionState): boolean {
  if (state.baselineYaw === null) {
    if (Math.abs(face.yawAngle) > THRESHOLDS.turnBaselineMaxYawDeg) {
      return false; // not frontal yet — wait rather than latch a bad reference
    }
    state.baselineYaw = face.yawAngle;
  }
  return true;
}

/**
 * True the instant `kind` is confirmed on this frame. Mutates `state` to
 * track progress across calls for the SAME action — the caller must swap in
 * a fresh state when moving to a different action.
 */
export function isActionSatisfied(
  kind: LivenessActionKind,
  face: Face,
  state: ActionState,
): boolean {
  switch (kind) {
    case 'blink': {
      const eye = Math.min(
        face.leftEyeOpenProbability ?? 1,
        face.rightEyeOpenProbability ?? 1,
      );
      state.minEye = Math.min(state.minEye, eye);
      state.maxEye = Math.max(state.maxEye, eye);
      const open = eye >= THRESHOLDS.blinkOpenProb;
      const closed = eye <= THRESHOLDS.blinkClosedProb;
      if (state.blinkPhase === 'await_open' && open) {
        state.blinkPhase = 'await_close';
      } else if (state.blinkPhase === 'await_close' && closed) {
        state.blinkPhase = 'await_reopen';
      } else if (state.blinkPhase === 'await_reopen' && open) {
        // Guard against a flat/near-static reading sneaking through the
        // open/closed cutoffs without a real swing — defeats a held photo.
        return state.maxEye - state.minEye >= THRESHOLDS.livenessMotionRange;
      }
      return false;
    }
    case 'smile':
      return (face.smilingProbability ?? 0) >= THRESHOLDS.smileProb;
    case 'turnLeft': {
      if (!captureTurnBaseline(face, state)) {
        return false;
      }
      // Signed delta (not abs()) so left and right are independently
      // verifiable — a leftward swing never satisfies "turn right".
      return face.yawAngle - state.baselineYaw! <= -THRESHOLDS.headTurnDeltaDeg;
    }
    case 'turnRight': {
      if (!captureTurnBaseline(face, state)) {
        return false;
      }
      return face.yawAngle - state.baselineYaw! >= THRESHOLDS.headTurnDeltaDeg;
    }
  }
}
