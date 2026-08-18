/**
 * Presence tests.
 *
 * This module decides whether an inspector is marked present on the attendance
 * register, so a wrong verdict is a payroll and accountability problem, not a
 * cosmetic one. Both failure directions are pinned: a spoof must never read as
 * present, and a genuine inspector must never be marked absent for a reason
 * that is not their fault.
 */
import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOW_PRESENT_WITHOUT_LOCATION,
  MAX_MATCH_DISTANCE,
  MIN_SCORE,
  evaluatePresence,
  isPresent,
  presenceReasonLabel,
} from './presence.js';
import type {AttendanceRecord} from './store.js';

function rec(over: Partial<AttendanceRecord> = {}): AttendanceRecord {
  return {
    userId: 'inspector_01',
    timestamp: 1_000,
    deviceId: 'd1',
    livenessPassed: true,
    matchDistance: 0.12,
    score: 91,
    location: {
      lat: 28.61,
      lon: 77.20,
      accuracyM: 12,
      mocked: false,
      geofencePassed: true,
      distanceM: 0,
    },
    ...over,
  };
}

describe('a good verification marks present', () => {
  test('live, matched, on site, high score', () => {
    const e = evaluatePresence(rec());
    assert.equal(e.status, 'present');
    assert.equal(e.reason, 'present_on_site');
    assert.equal(isPresent(rec()), true);
  });

  test('accepts a match exactly at the distance ceiling', () => {
    // Must agree with the handset, which accepts cosine >= 0.65 i.e.
    // distance <= 0.35. An off-by-one here silently disagrees with the app.
    assert.equal(evaluatePresence(rec({matchDistance: MAX_MATCH_DISTANCE})).status, 'present');
  });

  test('accepts a score exactly at the threshold', () => {
    assert.equal(evaluatePresence(rec({score: MIN_SCORE})).status, 'present');
  });

  test('a record with no score at all is not penalised', () => {
    // score is optional on the wire; an older build may omit it, and absence of
    // evidence must not become evidence of absence.
    const {score, ...noScore} = rec();
    assert.equal(evaluatePresence(noScore as AttendanceRecord).status, 'present');
  });
});

describe('spoofing and failure mark absent', () => {
  test('liveness failure', () => {
    const e = evaluatePresence(rec({livenessPassed: false}));
    assert.equal(e.status, 'absent');
    assert.equal(e.reason, 'liveness_failed');
  });

  test('identity not matched', () => {
    const e = evaluatePresence(rec({matchDistance: 0.62}));
    assert.equal(e.status, 'absent');
    assert.equal(e.reason, 'identity_not_matched');
  });

  test('score below the review line', () => {
    const e = evaluatePresence(rec({score: MIN_SCORE - 1}));
    assert.equal(e.status, 'absent');
    assert.equal(e.reason, 'score_below_threshold');
  });

  test('mock GPS provider', () => {
    const e = evaluatePresence(rec({
      location: {...rec().location!, mocked: true, geofencePassed: true},
    }));
    assert.equal(e.status, 'absent');
    assert.equal(e.reason, 'mocked_location');
  });

  test('outside the assigned site', () => {
    const e = evaluatePresence(rec({
      location: {...rec().location!, geofencePassed: false, distanceM: 840},
    }));
    assert.equal(e.status, 'absent');
    assert.equal(e.reason, 'outside_assigned_site');
  });

  test('a spoof that also faked its location still fails on liveness first', () => {
    // The reason should name the most damning cause, not the last check to run.
    const e = evaluatePresence(rec({
      livenessPassed: false,
      location: {...rec().location!, mocked: true},
    }));
    assert.equal(e.reason, 'liveness_failed');
  });
});

describe('missing location is handled deliberately', () => {
  test('no fix does not by itself mark absent', () => {
    // GPS routinely fails indoors or on a cold start. Marking a working
    // inspector absent for that is a false negative on their attendance.
    const {location, ...noLoc} = rec();
    const e = evaluatePresence(noLoc as AttendanceRecord);
    assert.equal(ALLOW_PRESENT_WITHOUT_LOCATION, true);
    assert.equal(e.status, 'present');
    assert.equal(e.reason, 'present_no_location_fix');
  });

  test('the no-fix case is distinguishable from a clean on-site mark', () => {
    // Same verdict, different reason — a supervisor can still tell them apart.
    const {location, ...noLoc} = rec();
    assert.notEqual(
      evaluatePresence(noLoc as AttendanceRecord).reason,
      evaluatePresence(rec()).reason,
    );
  });

  test('a present-but-wrong fix still fails, unlike a missing one', () => {
    assert.equal(
      evaluatePresence(rec({location: {...rec().location!, geofencePassed: false}})).status,
      'absent',
    );
  });
});

describe('reason labels', () => {
  test('every reason the evaluator can emit has a label', () => {
    const reasons = [
      evaluatePresence(rec()).reason,
      evaluatePresence(rec({livenessPassed: false})).reason,
      evaluatePresence(rec({matchDistance: 0.9})).reason,
      evaluatePresence(rec({score: 10})).reason,
      evaluatePresence(rec({location: {...rec().location!, mocked: true}})).reason,
      evaluatePresence(rec({location: {...rec().location!, geofencePassed: false}})).reason,
    ];
    for (const r of reasons) {
      assert.notEqual(presenceReasonLabel(r), r, `unlabelled reason: ${r}`);
    }
  });

  test('an unknown reason falls back to the raw code rather than throwing', () => {
    assert.equal(presenceReasonLabel('something_new'), 'something_new');
  });
});
