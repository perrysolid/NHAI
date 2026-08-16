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

/**
 * Regression: the backend's integrity guard rejects any record whose
 * matchDistance falls outside [0,1] (store.ts scoreSanity). Cosine similarity
 * is defined on [-1,1] and impostor pairs routinely score NEGATIVE, so a naive
 * `1 - matchScore` produced a distance above 1 for exactly the records a failed
 * verify queues. The server rejected them forever, and because the client only
 * purges records the server ACKNOWLEDGES, they stayed in the local queue for
 * good — a poison pill that never drains and grows without bound.
 */
describe('matchDistance stays inside the range the backend accepts', () => {
  const serverAccepts = (d: number) => d >= 0 && d <= 1;

  it('clamps a negative cosine (impostor) to a valid distance', () => {
    const payload = toSyncPayload([
      {
        userId: 'u1',
        timestamp: 1,
        livenessScore: 0.1,
        matchScore: -0.2, // a real impostor cosine
        deviceId: 'd1',
        synced: false,
      },
    ]);
    expect(serverAccepts(payload.records[0].matchDistance)).toBe(true);
  });

  it('clamps the no-match sentinel (-1) used when nothing matched', () => {
    // OfflineAuthStore.verify() seeds best = {matchScore: -1}; a liveness
    // failure queues that value verbatim.
    const payload = toSyncPayload([
      {
        userId: 'unidentified',
        timestamp: 1,
        livenessScore: 0,
        matchScore: -1,
        deviceId: 'd1',
        synced: false,
      },
    ]);
    expect(serverAccepts(payload.records[0].matchDistance)).toBe(true);
  });

  it('holds across the whole cosine domain', () => {
    for (let cosine = -1; cosine <= 1.0001; cosine += 0.1) {
      const payload = toSyncPayload([
        {
          userId: 'u1',
          timestamp: 1,
          livenessScore: 0.5,
          matchScore: cosine,
          deviceId: 'd1',
          synced: false,
        },
      ]);
      expect(serverAccepts(payload.records[0].matchDistance)).toBe(true);
    }
  });

  it('still reports a genuine match distance accurately', () => {
    const payload = toSyncPayload([
      {
        userId: 'u1',
        timestamp: 1,
        livenessScore: 0.9,
        matchScore: 0.82,
        deviceId: 'd1',
        synced: false,
      },
    ]);
    expect(payload.records[0].matchDistance).toBeCloseTo(0.18, 6);
  });
});
