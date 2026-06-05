import {FLAGS, SYNC} from '../config';
import type {AttendanceRecord, OfflineAuthStore} from '../auth/offlineStore';

export interface SyncOutcome {
  ok: boolean;
  accepted: number;
  purged: number;
  mocked: boolean;
  error?: string;
}

export function toSyncPayload(records: AttendanceRecord[]): {
  records: Array<{
    userId: string;
    timestamp: number;
    livenessPassed: boolean;
    livenessScore: number;
    matchScore: number;
    matchDistance: number;
    deviceId: string;
  }>;
} {
  return {
    records: records.map(r => ({
      userId: r.userId,
      timestamp: r.timestamp,
      livenessPassed: r.livenessScore >= 0.7,
      livenessScore: r.livenessScore,
      matchScore: r.matchScore,
      matchDistance: r.matchScore,
      deviceId: r.deviceId,
    })),
  };
}

export async function syncPending(
  store: OfflineAuthStore,
  opts: {
    mock?: boolean;
    url?: string;
    apiKey?: string;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<SyncOutcome> {
  const pending = store.getPendingQueue().slice(0, SYNC.batchSize);
  const mocked = opts.mock ?? FLAGS.MOCK_MODE;
  if (pending.length === 0) {
    return {ok: true, accepted: 0, purged: 0, mocked};
  }
  if (mocked) {
    store.purge(pending);
    return {
      ok: true,
      accepted: pending.length,
      purged: pending.length,
      mocked: true,
    };
  }
  const fetcher = opts.fetchImpl ?? fetch;
  try {
    const res = await fetcher(opts.url ?? SYNC.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': opts.apiKey ?? SYNC.apiKey,
      },
      body: JSON.stringify(toSyncPayload(pending)),
    });
    if (!res.ok) {
      return {
        ok: false,
        accepted: 0,
        purged: 0,
        mocked: false,
        error: `HTTP ${res.status}`,
      };
    }
    const data = (await res.json().catch(() => ({}))) as {accepted?: number};
    store.purge(pending);
    return {
      ok: true,
      accepted: data.accepted ?? pending.length,
      purged: pending.length,
      mocked: false,
    };
  } catch (e) {
    return {
      ok: false,
      accepted: 0,
      purged: 0,
      mocked: false,
      error: e instanceof Error ? e.message : 'network error',
    };
  }
}
