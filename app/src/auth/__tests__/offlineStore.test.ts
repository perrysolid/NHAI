import {OfflineAuthStore, createMemoryStorage} from '../offlineStore';

describe('OfflineAuthStore', () => {
  it('enrolls, verifies, queues, and purges records', () => {
    const store = new OfflineAuthStore(createMemoryStorage());
    const sample = new Float32Array([1, 0, 0]);

    store.saveEnrollment('inspector_01', [sample, sample], 100);

    const ok = store.verify(new Float32Array([1, 0, 0]));
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
