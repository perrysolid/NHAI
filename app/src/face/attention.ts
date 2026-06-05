/**
 * attention — on-device drowsiness & inattention monitor (EAR, PERCLOS, blink
 * rate, micro-sleep, head look-away). Derived from ML Kit eye-open probabilities
 * and head pose; pure and deterministic, so it is unit-tested. No model, no
 * network. Mirrors the web demo's monitor.
 */
import {DROWSINESS} from '../config';

interface Sample {
  t: number;
  closed: boolean;
  present: boolean;
}

export type AttentionState = 'alert' | 'drowsy' | 'no-face';

export interface AttentionSnapshot {
  /** eye-open proxy 0..1 (mean of left/right eye-open probability). */
  ear: number;
  perclos: number;
  blinks: number;
  blinkRate: number;
  longestClosureMs: number;
  drowsy: boolean;
  lookingAway: boolean;
  state: AttentionState;
}

export interface AttentionInput {
  /** mean eye-open probability 0..1 (ML Kit). */
  eyeOpen: number;
  yawDeg: number;
  present: boolean;
}

export class AttentionMonitor {
  private samples: Sample[] = [];
  private lastEar = 0;
  private lastYaw = 0;

  reset(): void {
    this.samples = [];
    this.lastEar = 0;
    this.lastYaw = 0;
  }

  update(input: AttentionInput | null, now: number): AttentionSnapshot {
    const present = !!input?.present;
    const ear = input?.eyeOpen ?? 0;
    this.lastEar = ear;
    this.lastYaw = input?.yawDeg ?? this.lastYaw;
    const closed = present && ear < DROWSINESS.earClosed;

    this.samples.push({t: now, closed, present});
    const cutoff = now - DROWSINESS.windowMs;
    while (this.samples.length && this.samples[0].t < cutoff) {
      this.samples.shift();
    }
    return this.snapshot(now);
  }

  snapshot(now: number): AttentionSnapshot {
    const present = this.samples.filter(s => s.present);
    if (present.length === 0) {
      return {
        ear: 0,
        perclos: 0,
        blinks: 0,
        blinkRate: 0,
        longestClosureMs: 0,
        drowsy: false,
        lookingAway: false,
        state: 'no-face',
      };
    }
    const closedCount = present.filter(s => s.closed).length;
    const perclos = closedCount / present.length;

    let blinks = 0;
    let longestClosureMs = 0;
    let runStart: number | null = null;
    let prevClosed = false;
    for (const s of present) {
      if (s.closed && !prevClosed) {
        runStart = s.t;
      }
      if (!s.closed && prevClosed) {
        blinks++;
        if (runStart !== null) {
          longestClosureMs = Math.max(longestClosureMs, s.t - runStart);
        }
        runStart = null;
      }
      prevClosed = s.closed;
    }
    if (prevClosed && runStart !== null) {
      longestClosureMs = Math.max(longestClosureMs, now - runStart);
    }

    const spanMs = Math.max(1, now - present[0].t);
    const blinkRate = (blinks / spanMs) * 60000;
    const lookingAway = Math.abs(this.lastYaw) >= DROWSINESS.lookAwayYawDeg;
    const drowsy =
      perclos >= DROWSINESS.perclosDrowsy ||
      longestClosureMs >= DROWSINESS.sustainedClosureMs;

    return {
      ear: this.lastEar,
      perclos,
      blinks,
      blinkRate,
      longestClosureMs,
      drowsy,
      lookingAway,
      state: drowsy ? 'drowsy' : 'alert',
    };
  }
}
