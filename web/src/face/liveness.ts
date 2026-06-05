/**
 * liveness — active challenge state machine. The user must complete a few
 * randomized challenges (blink / smile / head-turn) within a time window. A
 * static photo can't do these on command, so this defeats print/screen spoofs.
 *
 * Pure & deterministic given the signal stream + clock, so it's unit-testable.
 */
import {LIVENESS} from '../lib/config';
import {LIVENESS_TEXT, pick} from '../lib/i18n';
import type {FaceSignals} from './pipeline';

export type ChallengeKind = 'blink' | 'smile' | 'turn' | 'nod';
export type LivenessStatus = 'idle' | 'running' | 'passed' | 'failed';


export interface LivenessSnapshot {
  status: LivenessStatus;
  challenges: ChallengeKind[];
  index: number;
  prompt: string;
  /** 0..1 progress across challenges. */
  progress: number;
  msLeft: number;
}

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export class LivenessChallenge {
  private status: LivenessStatus = 'idle';
  private challenges: ChallengeKind[] = [];
  private index = 0;
  private startedAt = 0;
  // per-challenge sub-state
  private blinkPhase: 'await_open' | 'await_close' | 'await_reopen' =
    'await_open';
  private blinkOpenEar = 0;
  private blinkMinEar = Number.POSITIVE_INFINITY;
  private turnBaselineYaw: number | null = null;
  private nodBaselinePitch: number | null = null;

  constructor(rng: () => number = Math.random, fixedSteps?: ChallengeKind[]) {
    if (fixedSteps && fixedSteps.length) {
      this.challenges = fixedSteps;
      return;
    }
    // Randomized 3-layer challenge: blink + head-turn are always required, plus
    // a random third (smile or nod), in a RANDOM order chosen live. A
    // pre-recorded video cannot comply with an order it did not anticipate.
    const third: ChallengeKind = shuffle<ChallengeKind>(['smile', 'nod'], rng)[0];
    this.challenges = shuffle<ChallengeKind>(['blink', 'turn', third], rng);
  }

  start(now: number): void {
    this.status = 'running';
    this.index = 0;
    this.startedAt = now;
    this.resetSub();
  }

  private resetSub(): void {
    this.blinkPhase = 'await_open';
    this.blinkOpenEar = 0;
    this.blinkMinEar = Number.POSITIVE_INFINITY;
    this.turnBaselineYaw = null;
    this.nodBaselinePitch = null;
  }

  private current(): ChallengeKind {
    return this.challenges[this.index];
  }

  private satisfied(s: FaceSignals): boolean {
    switch (this.current()) {
      case 'blink': {
        this.blinkOpenEar = Math.max(this.blinkOpenEar, s.ear);
        this.blinkMinEar = Math.min(this.blinkMinEar, s.ear);

        // Absolute EAR thresholds are brittle across browser webcams, so we
        // also treat a sharp drop from the subject's own open-eye baseline as
        // "closed" and a recovery back toward it as "open".
        const open =
          s.ear >= LIVENESS.earOpen ||
          (this.blinkOpenEar > 0 &&
            s.ear >= this.blinkOpenEar * LIVENESS.blinkReopenRatio);
        const closed =
          s.ear <= LIVENESS.earClosed ||
          (this.blinkOpenEar > 0 &&
            (this.blinkOpenEar - s.ear >= LIVENESS.blinkDrop ||
              s.ear <= this.blinkOpenEar * LIVENESS.blinkClosedRatio));

        // Require a FULL open -> closed -> open cycle. A static photo of open
        // eyes never closes; a photo of closed eyes never opens — both fail.
        if (this.blinkPhase === 'await_open' && open) {
          this.blinkPhase = 'await_close';
        } else if (this.blinkPhase === 'await_close' && closed) {
          this.blinkPhase = 'await_reopen';
        } else if (this.blinkPhase === 'await_reopen' && open) {
          // and the eye signal must have actually swung (real motion).
          return (
            Number.isFinite(this.blinkMinEar) &&
            this.blinkOpenEar - this.blinkMinEar >= LIVENESS.blinkDrop
          );
        }
        return false;
      }
      case 'smile':
        return s.happy >= LIVENESS.smileProb;
      case 'turn':
        if (this.turnBaselineYaw === null) {
          this.turnBaselineYaw = s.yawDeg;
        }
        return (
          Math.abs(s.yawDeg - this.turnBaselineYaw) >= LIVENESS.headTurnDeltaDeg
        );
      case 'nod':
        if (this.nodBaselinePitch === null) {
          this.nodBaselinePitch = s.pitchDeg;
        }
        return (
          Math.abs(s.pitchDeg - this.nodBaselinePitch) >=
          LIVENESS.nodPitchDeltaDeg
        );
    }
  }

  /** Advance the machine with the latest signals (or null if no face). */
  update(signals: FaceSignals | null, now: number): LivenessSnapshot {
    if (this.status === 'running') {
      if (now - this.startedAt > LIVENESS.timeoutMs) {
        this.status = 'failed';
      } else if (signals && this.satisfied(signals)) {
        this.index += 1;
        this.resetSub();
        if (this.index >= this.challenges.length) {
          this.status = 'passed';
        }
      }
    }
    return this.snapshot(now);
  }

  snapshot(now: number): LivenessSnapshot {
    const done =
      this.status === 'passed' ? this.challenges.length : this.index;
    const msLeft =
      this.status === 'running'
        ? Math.max(0, LIVENESS.timeoutMs - (now - this.startedAt))
        : 0;
    let prompt = '';
    if (this.status === 'running') {
      prompt = pick(LIVENESS_TEXT[this.current()]);
    } else if (this.status === 'passed') {
      prompt = pick(LIVENESS_TEXT.passed);
    } else if (this.status === 'failed') {
      prompt = pick(LIVENESS_TEXT.failed);
    }
    return {
      status: this.status,
      challenges: this.challenges,
      index: this.index,
      prompt,
      progress: this.challenges.length ? done / this.challenges.length : 0,
      msLeft,
    };
  }

  get state(): LivenessStatus {
    return this.status;
  }
}
