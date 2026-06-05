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
});
