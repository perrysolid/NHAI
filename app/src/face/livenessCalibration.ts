/**
 * livenessCalibration — measures how long real users actually take to complete
 * each active-liveness action, so the anti-relay deadlines in
 * LIVENESS_ACTION_DEADLINE_MS can be set from field data instead of guesswork.
 *
 * WHY THIS EXISTS. The per-action deadline is the cheapest defence against a
 * live video-call relay (CLAUDE.md §5, threat 5): a relay cannot escape its
 * round-trip latency, so a tight deadline separates "in front of the lens" from
 * "on the other end of a call". But the deadline is a two-sided error:
 *   • too loose → the relay fits inside it and the defence does nothing;
 *   • too tight → real inspectors get rejected in the field, which is worse,
 *     because it breaks attendance for people who did nothing wrong.
 * The shipped defaults (4s / 5s) are deliberately loose guesses. They are loose
 * because every prompt is SPOKEN (speech/tts.ts at rate 0.5) and users wait for
 * the voice line before acting — the ~1.5-2s figure the literature suggests is
 * measured on silent, text-only prompts and does not transfer.
 *
 * This module turns that guess into a measurement. Pure and deterministic apart
 * from the storage adapter, so the statistics are unit-tested.
 *
 * HOW TO RUN A CALIBRATION PASS
 *   1. Set FLAGS.CALIBRATE_LIVENESS = true in config.ts and install the build.
 *   2. Enroll, then run ~30 genuine verify attempts. Vary what actually varies
 *      in the field: both languages, indoor and outdoor light, gloves, older and
 *      slower users, users unfamiliar with the app. Do NOT only test yourself —
 *      you know what the prompt says before it finishes speaking, which is
 *      exactly the bias this is trying to remove.
 *   3. Read the table: Settings → CALIBRATION → "Show timing report" (or watch
 *      the [CALIB] lines in `adb logcat` / Metro).
 *   4. Copy the recommended values into LIVENESS_ACTION_DEADLINE_MS.
 *   5. Re-measure the ATTACK case: film a video call performing the challenge
 *      and confirm it now exceeds the deadline. A deadline that admits the relay
 *      is a deadline that bought you nothing.
 *   6. Set FLAGS.CALIBRATE_LIVENESS back to false before shipping.
 */
import type {KeyValueStorage} from '../auth/offlineStore';
import {deadlineForAction} from './liveness';
import {LIVENESS_ACTIONS, type LivenessActionKind} from './livenessActions';

const SAMPLES_KEY = 'dfa.liveness.calibration.v1';

/** Hard cap on retained samples — calibration data must never grow unbounded. */
const MAX_SAMPLES = 500;

/** Added to the measured p95 to absorb the users you did not test. */
export const HEADROOM_MS = 500;

/**
 * Never recommend a deadline below this, whatever the data says. A spoken Hindi
 * prompt at rate 0.5 takes well over a second to deliver, and a sample set drawn
 * from confident users who already know the prompt will happily suggest 1200ms —
 * a number that would false-reject a first-time user in the field.
 */
export const RECOMMENDATION_FLOOR_MS = 2500;

/**
 * Below this many confirmed samples the percentile is not meaningful: p95 of 10
 * samples is just "the slowest one you happened to see".
 */
export const MIN_CONFIDENT_SAMPLES = 12;

/** Fraction of expired attempts above which the current deadline is too tight. */
const TOO_TIGHT_RATE = 0.1;

export type SampleOutcome = 'confirmed' | 'expired';

export interface CalibrationSample {
  action: LivenessActionKind;
  /** Prompt -> confirmation (or -> deadline) in ms. */
  ms: number;
  outcome: SampleOutcome;
  /** Wall clock, so a stale pass can be recognised and discarded. */
  at: number;
}

export type Verdict = 'need-more-data' | 'too-tight' | 'can-tighten' | 'ok';

export interface ActionStats {
  action: LivenessActionKind;
  /** Confirmed samples only — expired ones have no completion time. */
  n: number;
  expired: number;
  min: number;
  p50: number;
  p95: number;
  max: number;
  currentMs: number;
  recommendedMs: number;
  verdict: Verdict;
}

/** Nearest-rank percentile over an ASCENDING-sorted array. */
export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) {
    return 0;
  }
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  const index = Math.min(sortedAsc.length - 1, Math.max(0, rank - 1));
  return sortedAsc[index];
}

/** Round up to the next 100ms — deadlines are tuned coarsely, not to the ms. */
function roundUp100(ms: number): number {
  return Math.ceil(ms / 100) * 100;
}

export function recommendedDeadline(p95: number): number {
  return Math.max(RECOMMENDATION_FLOOR_MS, roundUp100(p95 + HEADROOM_MS));
}

function verdictFor(
  n: number,
  expired: number,
  recommendedMs: number,
  currentMs: number,
): Verdict {
  if (n < MIN_CONFIDENT_SAMPLES) {
    return 'need-more-data';
  }
  // Users are hitting the wall — the deadline is rejecting genuine attempts.
  if (expired / (n + expired) > TOO_TIGHT_RATE) {
    return 'too-tight';
  }
  // Slack worth reclaiming: every second removed comes straight out of the
  // attacker's relay budget.
  if (recommendedMs < currentMs - HEADROOM_MS) {
    return 'can-tighten';
  }
  return 'ok';
}

export function summarize(samples: CalibrationSample[]): ActionStats[] {
  return LIVENESS_ACTIONS.map(action => {
    const mine = samples.filter(s => s.action === action);
    const confirmed = mine
      .filter(s => s.outcome === 'confirmed')
      .map(s => s.ms)
      .sort((a, b) => a - b);
    const expired = mine.length - confirmed.length;
    const p95 = percentile(confirmed, 95);
    const currentMs = deadlineForAction(action);
    const recommendedMs = recommendedDeadline(p95);
    return {
      action,
      n: confirmed.length,
      expired,
      min: confirmed.length ? confirmed[0] : 0,
      p50: percentile(confirmed, 50),
      p95,
      max: confirmed.length ? confirmed[confirmed.length - 1] : 0,
      currentMs,
      recommendedMs,
      verdict: verdictFor(confirmed.length, expired, recommendedMs, currentMs),
    };
  });
}

const VERDICT_NOTE: Record<Verdict, string> = {
  'need-more-data': 'need more runs',
  'too-tight': 'TOO TIGHT — rejecting real users',
  'can-tighten': 'can tighten',
  ok: 'ok',
};

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

function padLeft(s: string, width: number): string {
  return s.length >= width ? s : ' '.repeat(width - s.length) + s;
}

/**
 * Human-readable table for `adb logcat` or an on-device Alert. Deliberately
 * plain text — this gets read on a phone in the field, not in a browser.
 */
export function formatReport(stats: ActionStats[]): string {
  const lines: string[] = [];
  const totalConfirmed = stats.reduce((sum, s) => sum + s.n, 0);
  const totalExpired = stats.reduce((sum, s) => sum + s.expired, 0);

  lines.push(`samples: ${totalConfirmed} confirmed, ${totalExpired} expired`);
  lines.push('');
  lines.push(
    `${pad('action', 10)}${padLeft('n', 4)}${padLeft('exp', 5)}${padLeft(
      'p50',
      7,
    )}${padLeft('p95', 7)}${padLeft('now', 7)}${padLeft('rec', 7)}`,
  );
  for (const s of stats) {
    lines.push(
      `${pad(s.action, 10)}${padLeft(String(s.n), 4)}${padLeft(
        String(s.expired),
        5,
      )}${padLeft(`${s.p50}`, 7)}${padLeft(`${s.p95}`, 7)}${padLeft(
        `${s.currentMs}`,
        7,
      )}${padLeft(`${s.recommendedMs}`, 7)}`,
    );
    lines.push(`${pad('', 10)}${VERDICT_NOTE[s.verdict]}`);
  }

  lines.push('');
  if (totalConfirmed === 0) {
    lines.push('No data yet. Run verify attempts with CALIBRATE_LIVENESS on.');
    return lines.join('\n');
  }
  if (stats.some(s => s.verdict === 'need-more-data')) {
    lines.push(
      `Under ${MIN_CONFIDENT_SAMPLES} samples for some actions — p95 is not`,
    );
    lines.push('meaningful yet. Keep running attempts before changing config.');
  }
  if (stats.some(s => s.verdict === 'too-tight')) {
    lines.push(
      'Some deadlines are rejecting genuine users. Loosen those FIRST;',
    );
    lines.push('a false reject in the field is worse than a slower challenge.');
  }
  lines.push('');
  lines.push('Copy into LIVENESS_ACTION_DEADLINE_MS (config.ts):');
  for (const s of stats) {
    const suffix = s.verdict === 'need-more-data' ? '   // low confidence' : '';
    lines.push(`  ${s.action}: ${s.recommendedMs},${suffix}`);
  }
  lines.push('');
  lines.push('Then re-test the RELAY case before trusting these numbers.');
  return lines.join('\n');
}

/**
 * Persists samples through the same KeyValueStorage the offline store uses, so
 * a calibration pass survives app restarts across a day of field testing.
 * Recording must never influence a verify outcome — every method here is
 * best-effort and swallows storage errors.
 */
export class CalibrationRecorder {
  constructor(private storage: KeyValueStorage) {}

  record(sample: CalibrationSample): void {
    try {
      const all = this.samples();
      all.push(sample);
      // Keep the most recent window; old passes reflect old deadlines.
      const trimmed =
        all.length > MAX_SAMPLES ? all.slice(all.length - MAX_SAMPLES) : all;
      this.storage.set(SAMPLES_KEY, JSON.stringify(trimmed));
    } catch {
      /* calibration is diagnostics — never break verify over it */
    }
  }

  samples(): CalibrationSample[] {
    try {
      const raw = this.storage.getString(SAMPLES_KEY);
      if (!raw) {
        return [];
      }
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as CalibrationSample[]) : [];
    } catch {
      return [];
    }
  }

  report(): string {
    return formatReport(summarize(this.samples()));
  }

  clear(): void {
    try {
      this.storage.delete(SAMPLES_KEY);
    } catch {
      /* ignore */
    }
  }
}
