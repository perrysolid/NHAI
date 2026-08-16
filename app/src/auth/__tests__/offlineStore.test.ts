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
