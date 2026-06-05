/**
 * liveness — active challenge state machine. The user must complete a few
 * randomized challenges (blink / smile / head-turn) within a time window. A
 * static photo can't do these on command, so this defeats print/screen spoofs.
 *
 * Pure & deterministic given the signal stream + clock, so it's unit-testable.
 */
import {LIVENESS} from '../lib/config';
import type {FaceSignals} from './pipeline';

export type ChallengeKind = 'blink' | 'smile' | 'turn';
export type LivenessStatus = 'idle' | 'running' | 'passed' | 'failed';

// Short bilingual prompts (English / हिन्दी). Static, offline-safe.
const PROMPTS: Record<ChallengeKind, string> = {
  blink: 'Blink / पलक झपकाएँ',
  smile: 'Smile / मुस्कुराएँ',
  turn: 'Turn your head / सिर घुमाएँ',
};

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
  private blinkSawClosed = false;
  private turnBaselineYaw: number | null = null;

  constructor(rng: () => number = Math.random) {
    const pool: ChallengeKind[] = ['blink', 'smile', 'turn'];
    this.challenges = shuffle(pool, rng).slice(
      0,
      Math.max(1, Math.min(LIVENESS.challengeCount, pool.length)),
    );
  }

  start(now: number): void {
    this.status = 'running';
    this.index = 0;
    this.startedAt = now;
    this.resetSub();
  }

  private resetSub(): void {
    this.blinkSawClosed = false;
    this.turnBaselineYaw = null;
  }

  private current(): ChallengeKind {
    return this.challenges[this.index];
  }

  private satisfied(s: FaceSignals): boolean {
    switch (this.current()) {
      case 'blink':
        if (s.ear < LIVENESS.earClosed) {
          this.blinkSawClosed = true;
        }
        return this.blinkSawClosed && s.ear > LIVENESS.earOpen;
      case 'smile':
        return s.happy >= LIVENESS.smileProb;
      case 'turn':
        if (this.turnBaselineYaw === null) {
          this.turnBaselineYaw = s.yawDeg;
        }
        return (
          Math.abs(s.yawDeg - this.turnBaselineYaw) >= LIVENESS.headTurnDeltaDeg
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
      prompt = PROMPTS[this.current()];
    } else if (this.status === 'passed') {
      prompt = 'Liveness confirmed / सत्यापित';
    } else if (this.status === 'failed') {
      prompt = 'Liveness failed / विफल — पुनः प्रयास';
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
