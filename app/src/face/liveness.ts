import {THRESHOLDS} from '../config';
import {LIVENESS_TEXT, pick} from '../i18n';
import type {Face} from '../camera/types';
import {
  LIVENESS_ACTIONS,
  freshActionState,
  isActionSatisfied,
  type ActionState,
  type LivenessActionKind,
} from './livenessActions';

export type LivenessStatus = 'idle' | 'running' | 'passed' | 'failed';

export interface LivenessSnapshot {
  status: LivenessStatus;
  actions: LivenessActionKind[];
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
 * Randomized active liveness over a subset of the shared action pool
 * (face/livenessActions.ts: blink, smile, turnLeft, turnRight), demanded one
 * at a time in a RANDOM order each attempt.
 *
 * Because the order (and which actions) is chosen per attempt and gated
 * step-by-step, a pre-recorded video on a phone cannot satisfy it — the
 * recording cannot match a selection it did not anticipate. On native this
 * stacks with the passive MiniFASNet anti-spoof for replay/screen defense.
 * Fully offline; no network, no extra model.
 */
export class ActiveLivenessChallenge {
  private status: LivenessStatus = 'idle';
  private actions: LivenessActionKind[];
  private index = 0;
  private startedAt = 0;
  private state: ActionState = freshActionState();

  constructor(
    rng: () => number = Math.random,
    fixedActions?: LivenessActionKind[],
    count: number = THRESHOLDS.livenessActionCount,
  ) {
    if (fixedActions && fixedActions.length) {
      this.actions = fixedActions;
    } else {
      const n = Math.max(1, Math.min(count, LIVENESS_ACTIONS.length));
      this.actions = shuffle(LIVENESS_ACTIONS, rng).slice(0, n);
    }
  }

  start(now: number): LivenessSnapshot {
    this.status = 'running';
    this.index = 0;
    this.startedAt = now;
    this.state = freshActionState();
    return this.snapshot(now);
  }

  update(face: Face | null, now: number): LivenessSnapshot {
    if (this.status !== 'running') {
      return this.snapshot(now);
    }
    if (now - this.startedAt > THRESHOLDS.activeChallengeTimeoutMs) {
      this.status = 'failed';
      return this.snapshot(now);
    }
    if (face && isActionSatisfied(this.actions[this.index], face, this.state)) {
      this.index += 1;
      if (this.index >= this.actions.length) {
        this.status = 'passed';
      } else {
        this.state = freshActionState();
      }
    }
    return this.snapshot(now);
  }

  snapshot(now: number): LivenessSnapshot {
    const done = this.status === 'passed' ? this.actions.length : this.index;
    const msLeft =
      this.status === 'running'
        ? Math.max(0, THRESHOLDS.activeChallengeTimeoutMs - (now - this.startedAt))
        : 0;
    let guidance = '';
    if (this.status === 'running') {
      guidance = pick(LIVENESS_TEXT[this.actions[this.index]]);
    } else if (this.status === 'passed') {
      guidance = pick(LIVENESS_TEXT.passed);
    } else if (this.status === 'failed') {
      guidance = pick(LIVENESS_TEXT.failed);
    }
    return {
      status: this.status,
      actions: this.actions,
      index: this.index,
      guidance,
      progress: this.actions.length ? done / this.actions.length : 0,
      msLeft,
    };
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
