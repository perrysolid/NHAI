/**
 * attention — drowsiness & inattention monitor driven by eye-landmark geometry.
 *
 * Metrics (all derived on-device from face-api 68-landmarks, no extra model):
 *  - EAR        : eye aspect ratio per frame (openness)
 *  - PERCLOS    : fraction of a rolling window with eyes closed — the standard
 *                 fatigue metric used in driver-monitoring research
 *  - blink rate : blinks per minute (closed->open transitions)
 *  - micro-sleep: a single continuous eye closure beyond a threshold
 *  - look-away  : sustained head yaw past a threshold (inattention)
 *
 * Pure & deterministic given the (signals, clock) stream, so it is unit-tested.
 */
import {DROWSINESS} from '../lib/config';

interface Sample {
  t: number;
  closed: boolean;
  present: boolean;
}

export type AttentionState = 'alert' | 'drowsy' | 'no-face';

export interface AttentionSnapshot {
  /** latest eye aspect ratio (0 when no face). */
  ear: number;
  /** 0..1 fraction of the window with eyes closed. */
  perclos: number;
  /** blinks counted within the window. */
  blinks: number;
  /** blinks per minute (extrapolated from the window). */
  blinkRate: number;
  /** longest single eye-closure within the window, ms. */
  longestClosureMs: number;
  drowsy: boolean;
  lookingAway: boolean;
  state: AttentionState;
}

export interface AttentionInput {
  ear: number;
  yawDeg: number;
  present: boolean;
}

export class AttentionMonitor {
  private samples: Sample[] = [];
  private lastEar = 0;
  private lastYaw = 0;
  private closureStart: number | null = null;

  reset(): void {
    this.samples = [];
    this.lastEar = 0;
    this.lastYaw = 0;
    this.closureStart = null;
  }

  update(input: AttentionInput | null, now: number): AttentionSnapshot {
    const present = !!input?.present;
    const ear = input?.ear ?? 0;
    this.lastEar = ear;
    this.lastYaw = input?.yawDeg ?? this.lastYaw;
    const closed = present && ear < DROWSINESS.earClosed;

    this.samples.push({t: now, closed, present});
    const cutoff = now - DROWSINESS.windowMs;
    while (this.samples.length && this.samples[0].t < cutoff) {
      this.samples.shift();
    }

    // micro-sleep: track a continuous closure run
    if (closed) {
      if (this.closureStart === null) {
        this.closureStart = now;
      }
    } else {
      this.closureStart = null;
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

    // blinks = closed->open transitions; longest continuous closure run
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
    // closure still open at window end
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
