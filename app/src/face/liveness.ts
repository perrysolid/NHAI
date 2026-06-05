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

export class ActiveLivenessChallenge {
  private status: LivenessStatus = 'idle';
  private challenges: ActiveChallengeKind[];
  private index = 0;
  private startedAt = 0;
  private sawClosedEyes = false;
  private baselineYaw: number | null = null;

  constructor(rng: () => number = Math.random, challengeCount = 2) {
    this.challenges = shuffle<ActiveChallengeKind>(
      ['blink', 'smile', 'turn'],
      rng,
    ).slice(0, Math.max(1, Math.min(3, challengeCount)));
  }

  start(now: number): LivenessSnapshot {
    this.status = 'running';
    this.index = 0;
    this.startedAt = now;
    this.resetStep();
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
    if (face && this.isCurrentSatisfied(face)) {
      this.index += 1;
      this.resetStep();
      if (this.index >= this.challenges.length) {
        this.status = 'passed';
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
    this.sawClosedEyes = false;
    this.baselineYaw = null;
  }

  private isCurrentSatisfied(face: Face): boolean {
    const current = this.challenges[this.index];
    if (current === 'blink') {
      const left = face.leftEyeOpenProbability ?? 1;
      const right = face.rightEyeOpenProbability ?? 1;
      const bothClosed =
        left <= THRESHOLDS.blinkClosedProb &&
        right <= THRESHOLDS.blinkClosedProb;
      const bothOpen =
        left >= THRESHOLDS.blinkOpenProb && right >= THRESHOLDS.blinkOpenProb;
      if (bothClosed) {
        this.sawClosedEyes = true;
      }
      return this.sawClosedEyes && bothOpen;
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

export function evaluateDualLiveness(input: {
  passiveScore: number;
  activeStatus: LivenessStatus;
}): {passed: boolean; passivePassed: boolean; activePassed: boolean} {
  const passivePassed = input.passiveScore >= THRESHOLDS.livenessPassive;
  const activePassed = input.activeStatus === 'passed';
  return {passed: passivePassed && activePassed, passivePassed, activePassed};
}
