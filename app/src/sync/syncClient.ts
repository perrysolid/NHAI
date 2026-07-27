import {FLAGS, SYNC, THRESHOLDS} from '../config';
import type {AttendanceRecord, OfflineAuthStore} from '../auth/offlineStore';

interface SyncAckRecord {
  userId: string;
  timestamp: number;
  deviceId: string;
}

export interface SyncOutcome {
  ok: boolean;
  accepted: number;
  purged: number;
  mocked: boolean;
  error?: string;
}

export interface SyncRecord {
  userId: string;
  timestamp: number;
  livenessPassed: boolean;
  livenessScore: number;
  matchScore: number;
  matchDistance: number;
  deviceId: string;
  confidence?: number;
  score?: number;
  latencyMs?: number;
  /** On-device geofence summary — omitted when no GPS fix was available. */
  lat?: number;
  lon?: number;
  accuracyM?: number;
  mocked?: boolean;
  geofencePassed?: boolean;
  siteId?: string;
  distanceM?: number;
}

export function toSyncPayload(records: AttendanceRecord[]): {
  records: SyncRecord[];
} {
  return {
    records: records.map(r => ({
      userId: r.userId,
      timestamp: r.timestamp,
      livenessPassed:
        r.livenessPassed ?? r.livenessScore >= THRESHOLDS.livenessSyncPass,
      livenessScore: r.livenessScore,
      matchScore: r.matchScore,
      matchDistance: 1 - r.matchScore,
      deviceId: r.deviceId,
      ...(r.confidence !== undefined ? {confidence: r.confidence} : {}),
      ...(r.score !== undefined ? {score: r.score} : {}),
      ...(r.latencyMs !== undefined ? {latencyMs: r.latencyMs} : {}),
      ...(r.location
        ? {
            lat: r.location.lat,
            lon: r.location.lon,
            accuracyM: r.location.accuracyM,
            mocked: r.location.mocked,
            geofencePassed: r.location.geofencePassed,
            siteId: r.location.siteId,
            distanceM: r.location.distanceM,
          }
        : {}),
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
    const data = (await res.json().catch(() => ({}))) as {
      accepted?: number;
      acceptedRecords?: SyncAckRecord[];
    };
    const acceptedRecords = Array.isArray(data.acceptedRecords)
      ? data.acceptedRecords
      : [];
    if (acceptedRecords.length > 0) {
      store.purge(acceptedRecords as AttendanceRecord[]);
    }
    return {
      ok: true,
      accepted: data.accepted ?? pending.length,
      purged: acceptedRecords.length,
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
