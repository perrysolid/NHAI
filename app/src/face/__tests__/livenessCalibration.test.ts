/**
 * Tests for the deadline calibration harness. The statistics here decide what
 * the anti-relay deadlines get set to, so a wrong percentile or a bad
 * recommendation silently produces either a useless defence (too loose) or
 * field-wide false rejects (too tight). Both failure modes are pinned below.
 */
import {
  CalibrationRecorder,
  HEADROOM_MS,
  MIN_CONFIDENT_SAMPLES,
  RECOMMENDATION_FLOOR_MS,
  formatReport,
  percentile,
  recommendedDeadline,
  summarize,
  type CalibrationSample,
} from '../livenessCalibration';
import {ActiveLivenessChallenge, deadlineForAction} from '../liveness';
import {createMemoryStorage} from '../../auth/offlineStore';
import type {LivenessActionKind} from '../livenessActions';
import type {Face} from '../../camera/types';

function faceOf(overrides: Partial<Face>): Face {
  return {
    bounds: {x: 0, y: 0, width: 400, height: 400},
    yawAngle: 0,
    pitchAngle: 0,
    rollAngle: 0,
    leftEyeOpenProbability: 1,
    rightEyeOpenProbability: 1,
    smilingProbability: 0,
    ...overrides,
  };
}

function samples(
  action: LivenessActionKind,
  ms: number[],
  outcome: 'confirmed' | 'expired' = 'confirmed',
): CalibrationSample[] {
  return ms.map(m => ({action, ms: m, outcome, at: 0}));
}

/** n confirmed samples all at `ms`, enough to clear the confidence bar. */
function confidentRun(action: LivenessActionKind, ms: number) {
  return samples(action, new Array(MIN_CONFIDENT_SAMPLES).fill(ms));
}

describe('percentile', () => {
  it('returns 0 for an empty set rather than NaN', () => {
    expect(percentile([], 95)).toBe(0);
  });

  it('uses nearest-rank, never interpolating past the observed max', () => {
    const sorted = [100, 200, 300, 400, 500];
    expect(percentile(sorted, 50)).toBe(300);
    expect(percentile(sorted, 95)).toBe(500);
    expect(percentile(sorted, 100)).toBe(500);
  });

  it('handles a single sample', () => {
    expect(percentile([1234], 95)).toBe(1234);
  });
});

describe('recommendedDeadline', () => {
  it('adds headroom to p95 and rounds up to 100ms', () => {
    // 3010 + 500 = 3510 -> 3600
    expect(recommendedDeadline(3010)).toBe(3600);
  });

  it('never recommends below the spoken-prompt floor', () => {
    // Fast, confident testers who already know the prompt would otherwise drag
    // the recommendation down to a number that rejects first-time field users.
    expect(recommendedDeadline(200)).toBe(RECOMMENDATION_FLOOR_MS);
    expect(recommendedDeadline(0)).toBe(RECOMMENDATION_FLOOR_MS);
  });
});

describe('summarize', () => {
  it('reports every action in the pool even with no data', () => {
    const stats = summarize([]);
    expect(stats).toHaveLength(4);
    for (const s of stats) {
      expect(s.n).toBe(0);
      expect(s.verdict).toBe('need-more-data');
    }
  });

  it('excludes expired attempts from the timing distribution', () => {
    // An expired attempt has no completion time — folding the deadline value
    // into the percentile would bias every recommendation upward.
    const stats = summarize([
      ...samples('blink', [1000, 1000, 1000]),
      ...samples('blink', [4000], 'expired'),
    ]);
    const blink = stats.find(s => s.action === 'blink')!;
    expect(blink.n).toBe(3);
    expect(blink.expired).toBe(1);
    expect(blink.max).toBe(1000);
  });

  it('withholds a verdict until there are enough samples', () => {
    const stats = summarize(samples('blink', [900, 950, 1000]));
    expect(stats.find(s => s.action === 'blink')!.verdict).toBe(
      'need-more-data',
    );
  });

  it('flags a deadline that is rejecting genuine users', () => {
    // 12 confirmed + 6 expired = 33% failure rate on real attempts.
    const stats = summarize([
      ...confidentRun('blink', 1200),
      ...samples('blink', [4000, 4000, 4000, 4000, 4000, 4000], 'expired'),
    ]);
    expect(stats.find(s => s.action === 'blink')!.verdict).toBe('too-tight');
  });

  it('prioritises the too-tight warning over reclaimable slack', () => {
    // Fast median AND a high expiry rate: the slack is real but irrelevant
    // while genuine users are being turned away.
    const stats = summarize([
      ...confidentRun('blink', 600),
      ...samples('blink', new Array(9).fill(4000), 'expired'),
    ]);
    expect(stats.find(s => s.action === 'blink')!.verdict).toBe('too-tight');
  });

  it('spots slack worth reclaiming', () => {
    // Everyone completes in ~1s against a 4s deadline: recommendation floors at
    // 2500, comfortably tighter than current, so there is budget to take back.
    const stats = summarize(confidentRun('blink', 1000));
    const blink = stats.find(s => s.action === 'blink')!;
    expect(blink.recommendedMs).toBe(RECOMMENDATION_FLOOR_MS);
    expect(blink.recommendedMs).toBeLessThan(blink.currentMs);
    expect(blink.verdict).toBe('can-tighten');
  });

  it('calls a well-matched deadline ok', () => {
    // p95 lands just under the current deadline once headroom is added.
    const current = deadlineForAction('blink');
    const stats = summarize(confidentRun('blink', current - HEADROOM_MS - 100));
    expect(stats.find(s => s.action === 'blink')!.verdict).toBe('ok');
  });

  it('keeps actions independent', () => {
    const stats = summarize([
      ...confidentRun('blink', 800),
      ...confidentRun('turnLeft', 3200),
    ]);
    expect(stats.find(s => s.action === 'blink')!.p95).toBe(800);
    expect(stats.find(s => s.action === 'turnLeft')!.p95).toBe(3200);
    expect(stats.find(s => s.action === 'smile')!.n).toBe(0);
  });
});

describe('formatReport', () => {
  it('says so plainly when there is no data', () => {
    expect(formatReport(summarize([]))).toContain('No data yet');
  });

  it('warns that a small sample is not a meaningful p95', () => {
    const report = formatReport(summarize(samples('blink', [900, 1000])));
    expect(report).toContain('p95 is not');
  });

  it('emits a copy-pasteable config block', () => {
    const report = formatReport(summarize(confidentRun('blink', 1000)));
    expect(report).toContain('LIVENESS_ACTION_DEADLINE_MS');
    expect(report).toContain(`blink: ${RECOMMENDATION_FLOOR_MS},`);
  });

  it('marks low-confidence rows so they are not pasted blindly', () => {
    const report = formatReport(summarize(samples('blink', [900])));
    expect(report).toContain('low confidence');
  });

  it('reminds the operator to re-test the attack case', () => {
    // A deadline tuned only against genuine users can still admit the relay.
    expect(formatReport(summarize(confidentRun('blink', 1000)))).toContain(
      'RELAY',
    );
  });
});

/**
 * End-to-end: a real challenge driving a real recorder. The units are covered
 * above; this proves the pieces are actually wired to each other and that a
 * session produces the numbers the operator will act on.
 */
describe('challenge -> recorder -> report (integration)', () => {
  it('records a genuine session and recommends from it', () => {
    const recorder = new CalibrationRecorder(createMemoryStorage());
    const hook = (t: {
      action: LivenessActionKind;
      ms: number;
      outcome: 'confirmed' | 'expired';
    }) => recorder.record({...t, at: Date.now()});

    // 13 genuine attempts: smile confirmed at 1.2s, then blink over ~900ms.
    for (let i = 0; i < 13; i++) {
      const c = new ActiveLivenessChallenge(
        Math.random,
        ['smile', 'blink'],
        undefined,
        hook,
      );
      c.start(0);
      c.update(faceOf({smilingProbability: 0.95}), 1200);
      c.update(
        faceOf({leftEyeOpenProbability: 1, rightEyeOpenProbability: 1}),
        1500,
      );
      c.update(
        faceOf({leftEyeOpenProbability: 0, rightEyeOpenProbability: 0}),
        1800,
      );
      const done = c.update(
        faceOf({leftEyeOpenProbability: 1, rightEyeOpenProbability: 1}),
        2100,
      );
      expect(done.status).toBe('passed');
    }

    const stats = summarize(recorder.samples());
    const smile = stats.find(s => s.action === 'smile')!;
    const blink = stats.find(s => s.action === 'blink')!;

    expect(smile.n).toBe(13);
    expect(smile.p95).toBe(1200);
    // Blink is measured from ITS prompt (1200) to completion (2100) = 900ms.
    expect(blink.n).toBe(13);
    expect(blink.p95).toBe(900);
    expect(smile.expired).toBe(0);

    // Both complete far inside the 4s deadline, so both floor at the minimum
    // recommendation and are reported as reclaimable slack.
    expect(smile.recommendedMs).toBe(RECOMMENDATION_FLOOR_MS);
    expect(smile.verdict).toBe('can-tighten');

    const report = recorder.report();
    expect(report).toContain('smile: 2500,');
    expect(report).toContain('blink: 2500,');
  });

  it('records an expired action exactly once', () => {
    // A duplicate expiry sample would inflate the failure rate and trip the
    // "TOO TIGHT" warning on a deadline that is actually fine.
    const recorder = new CalibrationRecorder(createMemoryStorage());
    const c = new ActiveLivenessChallenge(
      Math.random,
      ['blink'],
      undefined,
      t => recorder.record({...t, at: 0}),
    );
    c.start(0);
    const past = deadlineForAction('blink') + 1;
    c.update(faceOf({}), past);
    // Keep polling well past the deadline, as the real tick loop would.
    c.update(faceOf({}), past + 500);
    c.update(faceOf({}), past + 1000);

    const mine = recorder.samples();
    expect(mine).toHaveLength(1);
    expect(mine[0].outcome).toBe('expired');
  });
});

describe('CalibrationRecorder', () => {
  it('round-trips samples through storage', () => {
    const r = new CalibrationRecorder(createMemoryStorage());
    r.record({action: 'blink', ms: 900, outcome: 'confirmed', at: 1});
    r.record({action: 'smile', ms: 1400, outcome: 'confirmed', at: 2});
    expect(r.samples()).toHaveLength(2);
    expect(r.samples()[1].action).toBe('smile');
  });

  it('survives corrupt stored data instead of crashing verify', () => {
    const storage = createMemoryStorage();
    storage.set('dfa.liveness.calibration.v1', 'not json');
    const r = new CalibrationRecorder(storage);
    expect(r.samples()).toEqual([]);
    expect(() =>
      r.record({action: 'blink', ms: 900, outcome: 'confirmed', at: 1}),
    ).not.toThrow();
  });

  it('never throws when storage itself fails', () => {
    // Diagnostics must not be able to break an authentication attempt.
    const broken = {
      getString: () => {
        throw new Error('mmkv down');
      },
      set: () => {
        throw new Error('mmkv down');
      },
      delete: () => {
        throw new Error('mmkv down');
      },
    };
    const r = new CalibrationRecorder(broken);
    expect(() =>
      r.record({action: 'blink', ms: 900, outcome: 'confirmed', at: 1}),
    ).not.toThrow();
    expect(() => r.clear()).not.toThrow();
    expect(r.samples()).toEqual([]);
  });

  it('caps retained samples so storage cannot grow without bound', () => {
    const r = new CalibrationRecorder(createMemoryStorage());
    for (let i = 0; i < 620; i++) {
      r.record({action: 'blink', ms: i, outcome: 'confirmed', at: i});
    }
    const kept = r.samples();
    expect(kept).toHaveLength(500);
    // The most RECENT window is kept — old passes reflect old deadlines.
    expect(kept[kept.length - 1].ms).toBe(619);
    expect(kept[0].ms).toBe(120);
  });

  it('clears a pass', () => {
    const r = new CalibrationRecorder(createMemoryStorage());
    r.record({action: 'blink', ms: 900, outcome: 'confirmed', at: 1});
    r.clear();
    expect(r.samples()).toEqual([]);
  });
});
