/**
 * presence — derives a PRESENT / ABSENT attendance mark from a synced record.
 *
 * The device reports measurements; it does not decide attendance. This module
 * turns those measurements into the single column an attendance register needs,
 * server-side, so the rule is applied uniformly across the fleet and can be
 * changed without shipping a new app build.
 *
 * A record is PRESENT only when all of the following hold:
 *   1. liveness passed        — a live human, not a reproduction
 *   2. identity matched       — the embedding matched the enrolled template
 *   3. composite score is adequate
 *   4. the GPS fix was not flagged as a mock provider
 *   5. the device was inside its assigned geofence
 *
 * Everything else is ABSENT, with a reason recorded. The reason matters as much
 * as the verdict: "absent" because someone spoofed the camera and "absent"
 * because their GPS could not lock are very different facts for a supervisor,
 * and collapsing them into one boolean destroys the distinction.
 */
import type {AttendanceRecord} from './store.js';

export type AttendanceStatus = 'present' | 'absent';

export interface PresenceEvaluation {
  status: AttendanceStatus;
  /** Short machine-readable reason; stable enough to group by in a report. */
  reason: string;
}

/**
 * Maximum accepted match distance. The device accepts a cosine similarity of
 * 0.65 or better, and distance is reported as (1 − cosine), so the equivalent
 * ceiling is 0.35. Keep these two in step: loosening one without the other
 * means the register disagrees with the handset about who was recognised.
 */
export const MAX_MATCH_DISTANCE = 0.35;

/** Composite Authentication Score at or above which a record is trusted. */
export const MIN_SCORE = 70;

/**
 * Minimum passive liveness probability. Default 0 — i.e. disabled.
 *
 * The passive anti-spoof model is bundled and computed but not yet calibrated
 * on target hardware, so its absolute scale is not yet meaningful. Gating on it
 * today would mark almost every genuine inspector absent. Raise this only once
 * real faces and screen replays have been measured and a floor sits in the gap
 * between them; `livenessPassed` carries the actual verdict until then.
 */
export const MIN_LIVENESS_SCORE = 0;

/**
 * Whether a record with no GPS fix at all can still be PRESENT.
 *
 * Default true — a missing fix is not evidence of absence. GPS routinely fails
 * to lock indoors, under structures, or in the first seconds after a cold
 * start, and marking a working inspector absent for it is a false negative on
 * someone's attendance record. A fix that exists and is *outside* the assigned
 * site is a different matter and always fails.
 *
 * Set false once every deployed site has a provisioned geofence and the field
 * data shows fixes are reliably available.
 */
export const ALLOW_PRESENT_WITHOUT_LOCATION = true;

export function evaluatePresence(r: AttendanceRecord): PresenceEvaluation {
  // Ordered most-specific first, so the reason names the real cause rather than
  // whichever check happened to run first.
  if (!r.livenessPassed) {
    return {status: 'absent', reason: 'liveness_failed'};
  }
  if (r.matchDistance > MAX_MATCH_DISTANCE) {
    return {status: 'absent', reason: 'identity_not_matched'};
  }
  if (typeof r.score === 'number' && r.score < MIN_SCORE) {
    return {status: 'absent', reason: 'score_below_threshold'};
  }

  const loc = r.location;
  if (!loc) {
    return ALLOW_PRESENT_WITHOUT_LOCATION
      ? {status: 'present', reason: 'present_no_location_fix'}
      : {status: 'absent', reason: 'no_location_fix'};
  }
  if (loc.mocked) {
    return {status: 'absent', reason: 'mocked_location'};
  }
  if (!loc.geofencePassed) {
    return {status: 'absent', reason: 'outside_assigned_site'};
  }
  return {status: 'present', reason: 'present_on_site'};
}

/** True when the record should appear as PRESENT on the attendance register. */
export function isPresent(r: AttendanceRecord): boolean {
  return evaluatePresence(r).status === 'present';
}

/** Human-readable label for a reason code, for the operations console. */
export function presenceReasonLabel(reason: string): string {
  const labels: Record<string, string> = {
    present_on_site: 'On site, verified',
    present_no_location_fix: 'Verified, no GPS fix',
    liveness_failed: 'Liveness failed',
    identity_not_matched: 'Identity not matched',
    score_below_threshold: 'Score below threshold',
    mocked_location: 'Mock GPS detected',
    outside_assigned_site: 'Outside assigned site',
    no_location_fix: 'No GPS fix',
  };
  return labels[reason] ?? reason;
}
