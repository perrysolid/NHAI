import {
  MAX_QUEUE_RECORDS,
  OfflineAuthStore,
  createMemoryStorage,
} from '../offlineStore';
import {RECOGNITION_MODELS, ACTIVE_RECOGNITION} from '../../config';

/**
 * Regression: the offline queue had no upper bound. Records are only removed
 * when the backend ACKNOWLEDGES them, so anything the server permanently
 * refuses — or any device that simply never regains connectivity — grew the
 * queue forever inside encrypted MMKV on a 3 GB field phone.
 */
describe('offline queue is bounded', () => {
  it('caps retained records and keeps the most recent', () => {
    const store = new OfflineAuthStore(createMemoryStorage());
    const overflow = 25;
    for (let i = 0; i < MAX_QUEUE_RECORDS + overflow; i++) {
      store.queueAttendance({
        userId: 'u1',
        livenessScore: 0.8,
        matchScore: 0.9,
        timestamp: i + 1,
      });
    }
    const queue = store.getQueue();
    expect(queue).toHaveLength(MAX_QUEUE_RECORDS);
    // Oldest dropped, newest kept: a stuck record at the head must never be
    // able to block newer attendance from being retained.
    expect(queue[queue.length - 1].timestamp).toBe(
      MAX_QUEUE_RECORDS + overflow,
    );
    expect(queue[0].timestamp).toBe(overflow + 1);
  });
});

/**
 * One inspector per device. Attendance is per-person, so a device holding
 * several templates would verify whoever matched best — turning a shared phone
 * into a way for one inspector to mark another present.
 */
describe('single enrollment per device', () => {
  const len = RECOGNITION_MODELS[ACTIVE_RECOGNITION].embeddingLength;
  const sampleFor = (seed: number) => {
    const v = new Float32Array(len);
    v[seed % len] = 1;
    return v;
  };

  it('reports no owner on a fresh device', () => {
    const store = new OfflineAuthStore(createMemoryStorage());
    expect(store.enrolledUserId()).toBeNull();
  });

  it('refuses a second, different inspector', () => {
    const store = new OfflineAuthStore(createMemoryStorage());
    store.saveEnrollment('inspector_a', [sampleFor(1)]);
    expect(() => store.saveEnrollment('inspector_b', [sampleFor(2)])).toThrow(
      /already enrolled to inspector_a/,
    );
    expect(store.listEnrollments()).toHaveLength(1);
    expect(store.enrolledUserId()).toBe('inspector_a');
  });

  it('allows the same inspector to re-enrol, replacing the template', () => {
    // Re-capturing after a poor enrolment must stay possible.
    const store = new OfflineAuthStore(createMemoryStorage());
    store.saveEnrollment('inspector_a', [sampleFor(1)], 100);
    store.saveEnrollment('inspector_a', [sampleFor(2)], 200);
    const all = store.listEnrollments();
    expect(all).toHaveLength(1);
    expect(all[0].createdAt).toBe(200);
  });

  it('frees the device after a reset', () => {
    const store = new OfflineAuthStore(createMemoryStorage());
    store.saveEnrollment('inspector_a', [sampleFor(1)]);
    store.clearAll();
    expect(store.enrolledUserId()).toBeNull();
    expect(() =>
      store.saveEnrollment('inspector_b', [sampleFor(2)]),
    ).not.toThrow();
  });

  it('collapses legacy multi-enrollment data to the most recent', () => {
    // A build before this rule could have stored several templates. Leaving
    // them readable would let the extra identities still verify.
    const storage = createMemoryStorage();
    storage.set(
      'dfa.enrollments.v1',
      JSON.stringify([
        {
          userId: 'old_a',
          embedding: Array.from(sampleFor(1)),
          createdAt: 100,
          samples: 1,
        },
        {
          userId: 'old_b',
          embedding: Array.from(sampleFor(2)),
          createdAt: 200,
          samples: 1,
        },
      ]),
    );
    const store = new OfflineAuthStore(storage);
    expect(store.listEnrollments()).toHaveLength(1);
    expect(store.enrolledUserId()).toBe('old_b');
  });
});

describe('OfflineAuthStore', () => {
  it('enrolls, verifies, queues, and purges records', () => {
    const store = new OfflineAuthStore(createMemoryStorage());
    const expectedLen = RECOGNITION_MODELS[ACTIVE_RECOGNITION].embeddingLength;
    const sample = new Float32Array(expectedLen);
    sample[0] = 1;

    store.saveEnrollment('inspector_01', [sample, sample], 100);

    const ok = store.verify(sample);
    expect(ok.ok).toBe(true);
    expect(ok.userId).toBe('inspector_01');

    const record = store.queueAttendance({
      userId: 'inspector_01',
      livenessScore: 0.9,
      matchScore: ok.matchScore,
      timestamp: 200,
    });
    expect(store.getPendingQueue()).toHaveLength(1);

    store.purge([record]);
    expect(store.getPendingQueue()).toHaveLength(0);
  });

  describe('liveness escalation lockout', () => {
    const T = 1_700_000_000_000; // fixed "now" so the window math is deterministic
    let nowSpy: jest.SpyInstance;

    beforeEach(() => {
      nowSpy = jest.spyOn(Date, 'now').mockReturnValue(T);
    });
    afterEach(() => nowSpy.mockRestore());

    it('locks out only after maxAttempts consecutive failures', () => {
      const store = new OfflineAuthStore(createMemoryStorage());
      for (let i = 0; i < 4; i++) {
        store.recordLivenessAttempt(false);
      }
      expect(store.getLivenessLockoutRemainingMs()).toBe(0); // 4 < 5, still open
      store.recordLivenessAttempt(false); // 5th failure trips the lockout
      expect(store.getLivenessLockoutRemainingMs()).toBe(60_000); // baseDuration
    });

    it('a success clears the failure streak and any lockout', () => {
      const store = new OfflineAuthStore(createMemoryStorage());
      for (let i = 0; i < 5; i++) {
        store.recordLivenessAttempt(false);
      }
      expect(store.getLivenessLockoutRemainingMs()).toBeGreaterThan(0);
      store.recordLivenessAttempt(true);
      expect(store.getLivenessLockoutRemainingMs()).toBe(0);
    });

    it('escalates the cooldown on a repeat lockout', () => {
      const store = new OfflineAuthStore(createMemoryStorage());
      for (let i = 0; i < 5; i++) {
        store.recordLivenessAttempt(false);
      }
      expect(store.getLivenessLockoutRemainingMs()).toBe(60_000);
      // Jump past the first cooldown, then fail 5 more times.
      nowSpy.mockReturnValue(T + 60_000);
      for (let i = 0; i < 5; i++) {
        store.recordLivenessAttempt(false);
      }
      expect(store.getLivenessLockoutRemainingMs()).toBe(120_000); // 60s * 2
    });
  });
});
