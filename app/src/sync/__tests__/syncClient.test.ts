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
    expect(payload.records[0].matchDistance).toBeCloseTo(0.1, 6);
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

  it('purges only records acknowledged by the backend', async () => {
    const store = new OfflineAuthStore(createMemoryStorage());
    const first = store.queueAttendance({
      userId: 'u1',
      livenessScore: 0.8,
      matchScore: 0.9,
      timestamp: 1,
    });
    store.queueAttendance({
      userId: 'u2',
      livenessScore: 0.8,
      matchScore: 0.9,
      timestamp: 2,
    });

    const out = await syncPending(store, {
      mock: false,
      fetchImpl: async () =>
        ({
          ok: true,
          json: async () => ({
            accepted: 1,
            acceptedRecords: [
              {
                userId: first.userId,
                timestamp: first.timestamp,
                deviceId: first.deviceId,
              },
            ],
          }),
        } as any),
    });

    expect(out.ok).toBe(true);
    expect(out.accepted).toBe(1);
    expect(out.purged).toBe(1);
    expect(store.getPendingQueue()).toHaveLength(1);
    expect(store.getPendingQueue()[0].userId).toBe('u2');
  });
});
