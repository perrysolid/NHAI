import {LIVENESS_ACTION_DEADLINE_MS, THRESHOLDS} from '../config';
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
  /** Time left in the whole-attempt backstop window. */
  msLeft: number;
  /** Time left to complete the CURRENT action (the binding deadline). */
  actionMsLeft: number;
}

/**
 * Deadline for one action. A direct lookup with NO fallback on purpose:
 * LIVENESS_ACTION_DEADLINE_MS is a total Record over LivenessActionKind, so
 * adding an action without a deadline is a compile error. A `??` default here
 * would turn that compile error into a silent runtime guess for a value that
 * governs whether a relay attack succeeds.
 */
export function deadlineForAction(kind: LivenessActionKind): number {
  return LIVENESS_ACTION_DEADLINE_MS[kind];
}

/** One prompt→outcome measurement, emitted for deadline calibration. */
export interface ActionTiming {
  action: LivenessActionKind;
  /** Time from the action being demanded to it being confirmed, or to the
   *  deadline being missed. */
  ms: number;
  outcome: 'confirmed' | 'expired';
}

export type ActionTimingHook = (timing: ActionTiming) => void;

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
 *
 * Each action additionally carries its OWN deadline (see deadlineForAction),
 * measured from the moment that action is demanded. Randomization alone does not
 * stop a LIVE relay — an accomplice on a video call performs any action on
 * demand — but a relay cannot escape its round-trip latency, so a tight
 * per-action deadline is what separates "in front of the lens" from "on the
 * other end of a call". Missing it fails the whole attempt, not just the action:
 * the deadline is a security control, and a retry is one tap away.
 */
export class ActiveLivenessChallenge {
  private status: LivenessStatus = 'idle';
  private actions: LivenessActionKind[];
  private index = 0;
  private startedAt = 0;
  /** When the CURRENT action was demanded — the per-action deadline clock. */
  private actionStartedAt = 0;
  private state: ActionState = freshActionState();

  constructor(
    rng: () => number = Math.random,
    fixedActions?: LivenessActionKind[],
    count: number = THRESHOLDS.livenessActionCount,
    /** Optional timing hook for deadline calibration (face/livenessCalibration).
     *  Kept as a callback so this class stays free of storage concerns and
     *  remains pure enough to unit test. Never allowed to affect the outcome. */
    private onTiming?: ActionTimingHook,
  ) {
    if (fixedActions && fixedActions.length) {
      this.actions = fixedActions;
    } else {
      const n = Math.max(1, Math.min(count, LIVENESS_ACTIONS.length));
      this.actions = shuffle(LIVENESS_ACTIONS, rng).slice(0, n);
    }
  }

  /** Emit a timing sample; a throwing hook must never fail a verify. */
  private emitTiming(
    action: LivenessActionKind,
    ms: number,
    outcome: 'confirmed' | 'expired',
  ): void {
    if (!this.onTiming) {
      return;
    }
    try {
      this.onTiming({action, ms, outcome});
    } catch {
      /* diagnostics only */
    }
  }

  start(now: number): LivenessSnapshot {
    this.status = 'running';
    this.index = 0;
    this.startedAt = now;
    this.actionStartedAt = now;
    this.state = freshActionState();
    return this.snapshot(now);
  }

  update(face: Face | null, now: number): LivenessSnapshot {
    if (this.status !== 'running') {
      return this.snapshot(now);
    }
    // Whole-attempt backstop.
    if (now - this.startedAt > THRESHOLDS.activeChallengeTimeoutMs) {
      this.status = 'failed';
      return this.snapshot(now);
    }
    // Per-action deadline — the anti-relay control. Checked BEFORE evaluating
    // the action so a response that arrives after the deadline cannot pass:
    // late-but-correct is exactly what a relayed or synthesized response looks
    // like. Deliberately NOT paused while the face is absent — wall-clock from
    // the prompt is the whole point, and pausing would hand an attacker free
    // time simply by stepping out of frame.
    const current = this.actions[this.index];
    const elapsed = now - this.actionStartedAt;
    if (elapsed > deadlineForAction(current)) {
      this.status = 'failed';
      this.emitTiming(current, elapsed, 'expired');
      return this.snapshot(now);
    }
    if (face && isActionSatisfied(current, face, this.state)) {
      this.emitTiming(current, elapsed, 'confirmed');
      this.index += 1;
      if (this.index >= this.actions.length) {
        this.status = 'passed';
      } else {
        // Next action is demanded now, so its deadline starts now.
        this.actionStartedAt = now;
        this.state = freshActionState();
      }
    }
    return this.snapshot(now);
  }

  snapshot(now: number): LivenessSnapshot {
    const done = this.status === 'passed' ? this.actions.length : this.index;
    const running = this.status === 'running';
    const msLeft = running
      ? Math.max(
          0,
          THRESHOLDS.activeChallengeTimeoutMs - (now - this.startedAt),
        )
      : 0;
    const actionMsLeft = running
      ? Math.max(
          0,
          deadlineForAction(this.actions[this.index]) -
            (now - this.actionStartedAt),
        )
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
      actionMsLeft,
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
