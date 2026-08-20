import {
  ActiveLivenessChallenge,
  deadlineForAction,
  evaluateDualLiveness,
} from '../liveness';
import {LIVENESS_ACTION_DEADLINE_MS, THRESHOLDS} from '../../config';
import {LIVENESS_ACTIONS} from '../livenessActions';
import type {Face} from '../../camera/types';

function face(overrides: Partial<Face> = {}): Face {
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
const open = face({leftEyeOpenProbability: 1, rightEyeOpenProbability: 1});
const closed = face({leftEyeOpenProbability: 0, rightEyeOpenProbability: 0});
describe('ActiveLivenessChallenge', () => {
  it('defaults to livenessActionCount (2) unique actions from the full pool', () => {
    const c = new ActiveLivenessChallenge();
    const snap = c.start(0);
    expect(snap.actions).toHaveLength(THRESHOLDS.livenessActionCount);
    for (const action of snap.actions) {
      expect(LIVENESS_ACTIONS).toContain(action);
    }
    expect(new Set(snap.actions).size).toBe(snap.actions.length);
  });

  it('passes a blink on a full open-close-open cycle', () => {
    const c = new ActiveLivenessChallenge(Math.random, ['blink']);
    c.start(0);
    expect(c.update(open, 100).status).toBe('running');
    expect(c.update(closed, 200).status).toBe('running');
    expect(c.update(open, 300).status).toBe('passed');
  });

  it('rejects a static open-eyed photo (the spoof case)', () => {
    const c = new ActiveLivenessChallenge(Math.random, ['blink']);
    c.start(0);
    for (let t = 100; t <= THRESHOLDS.activeChallengeTimeoutMs; t += 200) {
      c.update(open, t);
    }
    expect(
      c.update(open, THRESHOLDS.activeChallengeTimeoutMs + 200).status,
    ).toBe('failed');
  });

  it('completes a full blink -> turnLeft sequence in order', () => {
    const c = new ActiveLivenessChallenge(Math.random, ['blink', 'turnLeft']);
    c.start(0);
    c.update(open, 100);
    c.update(closed, 200);
    expect(c.update(open, 300).status).toBe('running');
    c.update(face({yawAngle: 0}), 400);
    expect(
      c.update(face({yawAngle: -THRESHOLDS.headTurnDeltaDeg - 5}), 500).status,
    ).toBe('passed');
  });

  it('fails when the demanded order is not followed (replay defense)', () => {
    const c = new ActiveLivenessChallenge(Math.random, ['turnLeft', 'blink']);
    c.start(0);
    c.update(closed, 100);
    expect(c.update(open, 200).status).toBe('running');
  });

  it('fails when timeout elapses', () => {
    const c = new ActiveLivenessChallenge(Math.random, ['blink']);
    c.start(0);
    expect(
      c.update(open, THRESHOLDS.activeChallengeTimeoutMs + 1000).status,
    ).toBe('failed');
  });

  it('both actions must complete for challenge to pass', () => {
    const c = new ActiveLivenessChallenge(Math.random, ['smile', 'blink']);
    c.start(0);
    expect(c.update(face({smilingProbability: 0.95}), 100).status).toBe(
      'running',
    );
    expect(c.update(open, 2000).status).toBe('running');
  });

  it('missing first action (turn) cannot skip ahead to second action (blink)', () => {
    const c = new ActiveLivenessChallenge(Math.random, ['turnLeft', 'blink']);
    c.start(0);
    c.update(closed, 100);
    expect(c.update(open, 200).status).toBe('running');
  });

  it('requires BOTH active and passive liveness to pass', () => {
    expect(
      evaluateDualLiveness({passiveScore: 0.8, activeStatus: 'passed'}).passed,
    ).toBe(true);
    expect(
      evaluateDualLiveness({passiveScore: 0.2, activeStatus: 'passed'}).passed,
    ).toBe(false);
    expect(
      evaluateDualLiveness({passiveScore: 0.8, activeStatus: 'failed'}).passed,
    ).toBe(false);
  });
});

/**
 * Per-action deadline — the anti-relay control (docs/ENGINEERING_NOTES.md §5, threat 5).
 * A live accomplice on a video call satisfies any behavioural challenge, so the
 * only thing separating them from a genuine user is the latency of the relay
 * loop. These tests pin that the deadline is enforced per action, restarts for
 * each new action, and cannot be evaded by going out of frame.
 */
describe('per-action response deadline', () => {
  const blinkDeadline = deadlineForAction('blink');

  it('fails a correct response that arrives after the deadline', () => {
    const c = new ActiveLivenessChallenge(Math.random, ['blink']);
    c.start(0);
    // A perfectly valid blink — but delivered too late to have come from
    // someone standing in front of the lens.
    c.update(open, blinkDeadline + 1);
    expect(c.update(closed, blinkDeadline + 100).status).toBe('failed');
  });

  it('accepts the same response delivered inside the deadline', () => {
    const c = new ActiveLivenessChallenge(Math.random, ['blink']);
    c.start(0);
    c.update(open, blinkDeadline - 300);
    c.update(closed, blinkDeadline - 200);
    expect(c.update(open, blinkDeadline - 100).status).toBe('passed');
  });

  it('fails well before the whole-attempt backstop', () => {
    const c = new ActiveLivenessChallenge(Math.random, ['blink']);
    c.start(0);
    const snap = c.update(open, blinkDeadline + 1);
    expect(snap.status).toBe('failed');
    // The 30s window has barely started — the per-action clock is what bound.
    expect(blinkDeadline + 1).toBeLessThan(THRESHOLDS.activeChallengeTimeoutMs);
  });

  it('restarts the clock for each new action', () => {
    const c = new ActiveLivenessChallenge(Math.random, ['smile', 'blink']);
    c.start(0);
    // Smile lands just inside its own deadline.
    const afterSmile = deadlineForAction('smile') - 100;
    expect(c.update(face({smilingProbability: 0.95}), afterSmile).status).toBe(
      'running',
    );
    // The blink now gets a FRESH budget measured from the smile, not from
    // start() — otherwise the second action would be born already expired.
    c.update(open, afterSmile + 100);
    c.update(closed, afterSmile + 200);
    expect(c.update(open, afterSmile + 300).status).toBe('passed');
  });

  it('does not pause while the face is out of frame', () => {
    const c = new ActiveLivenessChallenge(Math.random, ['blink']);
    c.start(0);
    // Stepping out of frame must not buy extra time — wall-clock from the
    // prompt is the entire security property.
    for (let t = 200; t < blinkDeadline; t += 200) {
      expect(c.update(null, t).status).toBe('running');
    }
    expect(c.update(null, blinkDeadline + 1).status).toBe('failed');
  });

  it('gives head turns a longer budget than blink/smile', () => {
    // Turning and holding past the yaw delta is slower than a blink; a single
    // shared number would false-reject real users on the turn actions.
    expect(deadlineForAction('turnLeft')).toBeGreaterThan(
      deadlineForAction('blink'),
    );
    expect(deadlineForAction('turnRight')).toBeGreaterThan(
      deadlineForAction('smile'),
    );
  });

  it('exposes the binding deadline as actionMsLeft', () => {
    const c = new ActiveLivenessChallenge(Math.random, ['blink']);
    const snap = c.start(0);
    expect(snap.actionMsLeft).toBe(blinkDeadline);
    // The per-action clock is always the tighter of the two, so it is what the
    // UI counts down.
    expect(snap.actionMsLeft).toBeLessThan(snap.msLeft);
    expect(c.update(open, 1000).actionMsLeft).toBe(blinkDeadline - 1000);
  });

  it('every action in the pool has an explicit deadline', () => {
    for (const action of LIVENESS_ACTIONS) {
      expect(LIVENESS_ACTION_DEADLINE_MS[action]).toBeGreaterThan(0);
    }
  });

  it('emits a confirmed timing sample measured from the prompt', () => {
    const seen: Array<{action: string; ms: number; outcome: string}> = [];
    const c = new ActiveLivenessChallenge(
      Math.random,
      ['blink'],
      undefined,
      t => seen.push(t),
    );
    c.start(0);
    c.update(open, 400);
    c.update(closed, 700);
    c.update(open, 900);
    expect(seen).toEqual([{action: 'blink', ms: 900, outcome: 'confirmed'}]);
  });

  it('emits an expired sample when the deadline is missed', () => {
    const seen: Array<{outcome: string}> = [];
    const c = new ActiveLivenessChallenge(
      Math.random,
      ['blink'],
      undefined,
      t => seen.push(t),
    );
    c.start(0);
    c.update(open, blinkDeadline + 1);
    expect(seen).toHaveLength(1);
    expect(seen[0].outcome).toBe('expired');
  });

  it('measures each action from its own prompt, not from the attempt start', () => {
    const seen: Array<{action: string; ms: number}> = [];
    const c = new ActiveLivenessChallenge(
      Math.random,
      ['smile', 'blink'],
      undefined,
      t => seen.push(t),
    );
    c.start(0);
    c.update(face({smilingProbability: 0.95}), 1000);
    c.update(open, 1300);
    c.update(closed, 1500);
    c.update(open, 1800);
    // Smile took 1000ms; the blink took 800ms from ITS prompt, not 1800ms from
    // the start — reporting elapsed-since-start would inflate every later
    // action and push its recommended deadline far too high.
    expect(seen.map(s => s.ms)).toEqual([1000, 800]);
  });

  it('a throwing timing hook cannot fail a genuine verify', () => {
    // Diagnostics must never be able to reject a real user.
    const c = new ActiveLivenessChallenge(
      Math.random,
      ['blink'],
      undefined,
      () => {
        throw new Error('storage down');
      },
    );
    c.start(0);
    c.update(open, 100);
    c.update(closed, 200);
    expect(c.update(open, 300).status).toBe('passed');
  });

  it('blocks a SLOW looping video that the 30s window used to let through', () => {
    // A looping recording cycling blink -> smile -> turnLeft -> turnRight will
    // eventually present whatever is demanded. Under the old shared 30s window
    // that was enough to pass. The per-action deadline means each gesture must
    // reappear within 4-5s of being asked for, so a slow loop now runs out.
    //
    // HONEST LIMIT: this defeats slow loops, NOT tight ones. A loop that cycles
    // all four gestures in under ~4s still passes at close to 100% (measured),
    // because every gesture is then guaranteed to appear inside every deadline.
    // Stopping that needs medium detection (passive PAD / moiré / flash), not a
    // behavioural challenge — see docs/ENGINEERING_NOTES.md §5.
    const period = 20000;
    const loopFrame = (t: number): Face => {
      const seg = Math.floor(((t % period) / period) * 4);
      const within = (((t % period) / period) * 4) % 1;
      const eye = seg === 0 && within > 0.33 && within < 0.66 ? 0.05 : 0.95;
      return face({
        yawAngle: seg === 2 ? -30 : seg === 3 ? 30 : 0,
        leftEyeOpenProbability: eye,
        rightEyeOpenProbability: eye,
        smilingProbability: seg === 1 ? 0.95 : 0,
      });
    };
    // Seeded RNG so the action draw is deterministic. With Math.random this
    // assertion was genuinely flaky: the pass rate is ~4%, and over 40 trials
    // ordinary variance crossed a 10% threshold often enough to fail in a full
    // suite run while passing in isolation. A probabilistic security assertion
    // needs a fixed seed, not a looser bound.
    let seed = 0x2f6e2b1;
    const rng = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    let passed = 0;
    const trials = 40;
    for (let i = 0; i < trials; i++) {
      const c = new ActiveLivenessChallenge(rng);
      c.start(0);
      const offset = (i * 977) % period;
      for (let t = 0; t < 40000; t += 160) {
        const s = c.update(loopFrame(t + offset), t);
        if (s.status === 'passed') {
          passed++;
          break;
        }
        if (s.status === 'failed') {
          break;
        }
      }
    }
    // Measured ~4% for a 20s loop; assert well under a tenth to catch a
    // regression that removes or badly loosens the per-action deadline.
    expect(passed / trials).toBeLessThan(0.1);
  });

  it('deadlines stay generous enough to cover a spoken prompt', () => {
    // Prompts are SPOKEN (speech/tts.ts at rate 0.5) and users wait for the
    // voice line before acting. Anything under ~2.5s here is a false-reject
    // machine in the field, however good it looks against a relay.
    for (const action of LIVENESS_ACTIONS) {
      expect(deadlineForAction(action)).toBeGreaterThanOrEqual(2500);
    }
  });
});
