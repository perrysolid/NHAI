import {THRESHOLDS} from '../config';
import {LIVENESS_TEXT, pick} from '../i18n';
import type {Face} from '../camera/types';

export type ActiveChallengeKind = 'blink' | 'smile' | 'turn';
export type LivenessStatus = 'idle' | 'running' | 'passed' | 'failed';

export interface LivenessSnapshot {
  status: LivenessStatus;
  challenges: ActiveChallengeKind[];
  index: number;
  guidance: string;
  progress: number;
  msLeft: number;
}

function shuffle<T>(items: T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Active liveness with a MANDATORY blink as the first challenge.
 *
 * The blink requires a full open -> closed -> open eye cycle, which a static
 * photo physically cannot produce (a photo of open eyes never reads "closed";
 * a photo of closed eyes never reads "open"). We additionally require evidence
 * of real motion (the eye-open signal must actually vary), so detector jitter
 * on a held photo cannot satisfy the challenge.
 */
export class ActiveLivenessChallenge {
  private status: LivenessStatus = 'idle';
  private challenges: ActiveChallengeKind[];
  private index = 0;
  private startedAt = 0;
  // blink cycle state
  private blinkPhase: 'await_open' | 'await_close' | 'await_reopen' =
    'await_open';
  private baselineYaw: number | null = null;
  // motion evidence over the whole attempt
  private minEye = 1;
  private maxEye = 0;
  private faceFrames = 0;

  constructor(rng: () => number = Math.random, extraChallenges = 0) {
    // Blink is always required and always first. Optional extra challenges add
    // friction for spoofers without weakening the photo-proof guarantee.
    const extras = shuffle<ActiveChallengeKind>(['turn', 'smile'], rng).slice(
      0,
      Math.max(0, Math.min(2, extraChallenges)),
    );
    this.challenges = ['blink', ...extras];
  }

  start(now: number): LivenessSnapshot {
    this.status = 'running';
    this.index = 0;
    this.startedAt = now;
    this.minEye = 1;
    this.maxEye = 0;
    this.faceFrames = 0;
    this.resetStep();
    return this.snapshot(now);
  }

  update(face: Face | null, now: number): LivenessSnapshot {
    if (this.status !== 'running') {
      return this.snapshot(now);
    }
    if (face) {
      this.faceFrames += 1;
      const eye = Math.min(
        face.leftEyeOpenProbability ?? 1,
        face.rightEyeOpenProbability ?? 1,
      );
      this.minEye = Math.min(this.minEye, eye);
      this.maxEye = Math.max(this.maxEye, eye);
    }
    if (now - this.startedAt > THRESHOLDS.activeChallengeTimeoutMs) {
      this.status = 'failed';
      return this.snapshot(now);
    }
    if (face && this.isCurrentSatisfied(face)) {
      this.index += 1;
      this.resetStep();
      if (this.index >= this.challenges.length) {
        // Final guard: the eye-open signal must have shown real variation over
        // the attempt (a genuine blink), defeating a static presentation.
        if (this.maxEye - this.minEye >= THRESHOLDS.livenessMotionRange) {
          this.status = 'passed';
        } else {
          this.status = 'failed';
        }
      }
    }
    return this.snapshot(now);
  }

  snapshot(now: number): LivenessSnapshot {
    const done = this.status === 'passed' ? this.challenges.length : this.index;
    const msLeft =
      this.status === 'running'
        ? Math.max(
            0,
            THRESHOLDS.activeChallengeTimeoutMs - (now - this.startedAt),
          )
        : 0;
    let guidance = '';
    if (this.status === 'running') {
      guidance = pick(LIVENESS_TEXT[this.challenges[this.index]]);
    } else if (this.status === 'passed') {
      guidance = pick(LIVENESS_TEXT.passed);
    } else if (this.status === 'failed') {
      guidance = pick(LIVENESS_TEXT.failed);
    }
    return {
      status: this.status,
      challenges: this.challenges,
      index: this.index,
      guidance,
      progress: this.challenges.length ? done / this.challenges.length : 0,
      msLeft,
    };
  }

  private resetStep(): void {
    this.blinkPhase = 'await_open';
    this.baselineYaw = null;
  }

  private isCurrentSatisfied(face: Face): boolean {
    const current = this.challenges[this.index];
    if (current === 'blink') {
      const eye = Math.min(
        face.leftEyeOpenProbability ?? 1,
        face.rightEyeOpenProbability ?? 1,
      );
      const open = eye >= THRESHOLDS.blinkOpenProb;
      const closed = eye <= THRESHOLDS.blinkClosedProb;
      // Require a full open -> closed -> open cycle.
      if (this.blinkPhase === 'await_open' && open) {
        this.blinkPhase = 'await_close';
      } else if (this.blinkPhase === 'await_close' && closed) {
        this.blinkPhase = 'await_reopen';
      } else if (this.blinkPhase === 'await_reopen' && open) {
        return true;
      }
      return false;
    }
    if (current === 'smile') {
      return (face.smilingProbability ?? 0) >= THRESHOLDS.smileProb;
    }
    if (this.baselineYaw === null) {
      this.baselineYaw = face.yawAngle;
    }
    return (
      Math.abs(face.yawAngle - this.baselineYaw) >= THRESHOLDS.headTurnDeltaDeg
    );
  }
}

/**
 * Combine active + passive liveness. BOTH must pass: the active blink defeats
 * static photos, the passive anti-spoof model defeats screen / print replays.
 */
export function evaluateDualLiveness(input: {
  passiveScore: number;
  activeStatus: LivenessStatus;
}): {passed: boolean; passivePassed: boolean; activePassed: boolean} {
  const passivePassed = input.passiveScore >= THRESHOLDS.livenessPassive;
  const activePassed = input.activeStatus === 'passed';
  return {passed: activePassed && passivePassed, passivePassed, activePassed};
}
