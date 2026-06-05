import {OfflineAuthStore, createMemoryStorage} from '../../auth/offlineStore';
import {syncPending, toSyncPayload} from '../syncClient';

describe('syncClient', () => {
  it('maps native records to backend payload fields', () => {
    const payload = toSyncPayload([
      {
        userId: 'u1',
        timestamp: 1,
        livenessScore: 0.8,
        matchScore: 0.9,
        deviceId: 'd1',
        synced: false,
      },
    ]);
    expect(payload.records[0]).toMatchObject({
      userId: 'u1',
      livenessPassed: true,
      matchScore: 0.9,
    });
  });

  it('mock sync purges pending queue', async () => {
    const store = new OfflineAuthStore(createMemoryStorage());
    store.queueAttendance({
      userId: 'u1',
      livenessScore: 0.8,
      matchScore: 0.9,
      timestamp: 1,
    });
    const out = await syncPending(store, {mock: true});
    expect(out.ok).toBe(true);
    expect(out.purged).toBe(1);
    expect(store.getPendingQueue()).toHaveLength(0);
  });
});
