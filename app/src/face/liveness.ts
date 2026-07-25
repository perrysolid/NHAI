import {THRESHOLDS} from '../config';
import {LIVENESS_TEXT, pick} from '../i18n';
import type {Face} from '../camera/types';

export type ActiveChallengeKind = 'blink' | 'turn' | 'smile';
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
 * Randomized active liveness over three quick actions: blink, smile and a head
 * turn (left/right), demanded one at a time in a RANDOM order each attempt.
 *
 *  - blink requires a full open -> closed -> open cycle (a static photo of open
 *    eyes never closes; of closed eyes never opens)
 *  - smile and head-turn add expression/pose checks
 *
 * Because the order is chosen per attempt and gated step-by-step, a pre-recorded
 * video on a phone cannot satisfy it — the recording cannot match an order it
 * did not anticipate. On native this stacks with the passive MiniFASNet
 * anti-spoof for replay/screen defense. Fully offline; no network, no extra
 * model. The recognition + match compute itself stays under a second.
 */
export class ActiveLivenessChallenge {
  private status: LivenessStatus = 'idle';
  private challenges: ActiveChallengeKind[];
  private index = 0;
  private startedAt = 0;
  // blink cycle + pose baselines
  private blinkPhase: 'await_open' | 'await_close' | 'await_reopen' =
    'await_open';
  private baselineYaw: number | null = null;
  // motion evidence over the whole attempt
  private minEye = 1;
  private maxEye = 0;

  constructor(
    rng: () => number = Math.random,
    fixedSteps?: ActiveChallengeKind[],
    count: number = THRESHOLDS.livenessActionCount,
  ) {
    if (fixedSteps && fixedSteps.length) {
      this.challenges = fixedSteps;
    } else {
      // A single action must be motion-based (blink/turn) so a static photo
      // can't satisfy it — a photo of a smiling face would pass 'smile' alone.
      // The full 3-action showcase adds 'smile' for variety.
      const n = Math.max(1, count);
      const pool: ActiveChallengeKind[] =
        n <= 1 ? ['blink', 'turn'] : ['blink', 'smile', 'turn'];
      this.challenges = shuffle<ActiveChallengeKind>(pool, rng).slice(0, n);
    }
  }

  start(now: number): LivenessSnapshot {
    this.status = 'running';
    this.index = 0;
    this.startedAt = now;
    this.minEye = 1;
    this.maxEye = 0;
    this.resetStep();
    return this.snapshot(now);
  }

  update(face: Face | null, now: number): LivenessSnapshot {
    if (this.status !== 'running') {
      return this.snapshot(now);
    }
    if (face) {
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
        // Final guard: when a blink is required, the eye signal must have
        // actually swung (real blink), defeating a held static presentation.
        const needsMotion = this.challenges.includes('blink');
        this.status =
          !needsMotion ||
          this.maxEye - this.minEye >= THRESHOLDS.livenessMotionRange
            ? 'passed'
            : 'failed';
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
    switch (this.challenges[this.index]) {
      case 'blink': {
        const eye = Math.min(
          face.leftEyeOpenProbability ?? 1,
          face.rightEyeOpenProbability ?? 1,
        );
        const open = eye >= THRESHOLDS.blinkOpenProb;
        const closed = eye <= THRESHOLDS.blinkClosedProb;
        if (this.blinkPhase === 'await_open' && open) {
          this.blinkPhase = 'await_close';
        } else if (this.blinkPhase === 'await_close' && closed) {
          this.blinkPhase = 'await_reopen';
        } else if (this.blinkPhase === 'await_reopen' && open) {
          return true;
        }
        return false;
      }
      case 'smile':
        return (face.smilingProbability ?? 0) >= THRESHOLDS.smileProb;
      case 'turn': {
        if (this.baselineYaw === null) {
          this.baselineYaw = face.yawAngle;
        }
        return (
          Math.abs(face.yawAngle - this.baselineYaw) >=
          THRESHOLDS.headTurnDeltaDeg
        );
      }
    }
  }
}

/**
 * Combine active + passive liveness. BOTH must pass: the active sequence defeats
 * static photos and (via randomization) casual video replays, the passive
 * anti-spoof model defeats screen/print replays.
 */
export function evaluateDualLiveness(input: {
  passiveScore: number;
  activeStatus: LivenessStatus;
}): {passed: boolean; passivePassed: boolean; activePassed: boolean} {
  const passivePassed = input.passiveScore >= THRESHOLDS.livenessPassive;
  const activePassed = input.activeStatus === 'passed';
  return {passed: activePassed && passivePassed, passivePassed, activePassed};
}
