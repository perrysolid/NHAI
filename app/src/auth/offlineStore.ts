import {LIVENESS_LOCKOUT, THRESHOLDS} from '../config';
import {averageEmbeddings, matchEmbedding, type Embedding} from '../face/math';
import type {Site} from '../location/types';

const ENROLLMENTS_KEY = 'dfa.enrollments.v1';
const QUEUE_KEY = 'dfa.queue.v1';
const DEVICE_KEY = 'dfa.deviceId.v1';
const SITES_KEY = 'dfa.sites.v1';
const LIVENESS_LOCKOUT_KEY = 'dfa.liveness.lockout.v1';

export interface KeyValueStorage {
  getString(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
}

export interface Enrollment {
  userId: string;
  embedding: number[];
  createdAt: number;
  samples: number;
  /** Datalake role chosen at enrollment (for the on-device welcome screen). */
  role?: string;
}

export interface RecordLocation {
  lat: number;
  lon: number;
  accuracyM: number;
  mocked: boolean;
  geofencePassed: boolean;
  siteId?: string;
  distanceM: number;
}

export interface AttendanceRecord {
  userId: string;
  timestamp: number;
  livenessScore: number;
  matchScore: number;
  deviceId: string;
  synced: boolean;
  livenessPassed?: boolean;
  confidence?: number;
  score?: number;
  latencyMs?: number;
  /** On-device geofence summary — present when a GPS fix was available. */
  location?: RecordLocation;
}

export interface VerifyOutcome {
  ok: boolean;
  userId?: string;
  matchScore: number;
}

function readJson<T>(storage: KeyValueStorage, key: string, fallback: T): T {
  const raw = storage.getString(key);
  if (!raw) {
    return fallback;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson<T>(storage: KeyValueStorage, key: string, value: T): void {
  storage.set(key, JSON.stringify(value));
}

export class OfflineAuthStore {
  constructor(private storage: KeyValueStorage) {}

  getDeviceId(): string {
    const existing = this.storage.getString(DEVICE_KEY);
    if (existing) {
      return existing;
    }
    const id = 'rn-' + Math.random().toString(36).slice(2, 10);
    this.storage.set(DEVICE_KEY, id);
    return id;
  }

  listEnrollments(): Enrollment[] {
    return readJson<Enrollment[]>(this.storage, ENROLLMENTS_KEY, []);
  }

  saveEnrollment(
    userId: string,
    samples: Embedding[],
    now = Date.now(),
    role?: string,
  ): void {
    const embedding = averageEmbeddings(samples);
    const next = this.listEnrollments().filter(e => e.userId !== userId);
    next.push({
      userId,
      embedding: Array.from(embedding),
      createdAt: now,
      samples: samples.length,
      ...(role ? {role} : {}),
    });
    writeJson(this.storage, ENROLLMENTS_KEY, next);
  }

  /** The most-recently enrolled identity on this device (for the welcome screen). */
  latestEnrollment(): Enrollment | null {
    const all = this.listEnrollments();
    return all.length
      ? all.reduce((a, b) => (b.createdAt > a.createdAt ? b : a))
      : null;
  }

  verify(probe: Embedding): VerifyOutcome {
    let best: VerifyOutcome = {ok: false, matchScore: -1};
    for (const enrollment of this.listEnrollments()) {
      const match = matchEmbedding(probe, enrollment.embedding);
      if (match.cosine > best.matchScore) {
        best = {
          ok: match.matched,
          userId: enrollment.userId,
          matchScore: match.cosine,
        };
      }
    }
    if (best.matchScore < THRESHOLDS.recognitionCosine) {
      best.ok = false;
    }
    return best;
  }

  queueAttendance(input: {
    userId: string;
    livenessScore: number;
    matchScore: number;
    timestamp?: number;
    livenessPassed?: boolean;
    confidence?: number;
    score?: number;
    latencyMs?: number;
    location?: RecordLocation;
  }): AttendanceRecord {
    const record: AttendanceRecord = {
      userId: input.userId,
      timestamp: input.timestamp ?? Date.now(),
      livenessScore: input.livenessScore,
      matchScore: input.matchScore,
      deviceId: this.getDeviceId(),
      synced: false,
      ...(input.livenessPassed !== undefined
        ? {livenessPassed: input.livenessPassed}
        : {}),
      ...(input.confidence !== undefined ? {confidence: input.confidence} : {}),
      ...(input.score !== undefined ? {score: input.score} : {}),
      ...(input.latencyMs !== undefined ? {latencyMs: input.latencyMs} : {}),
      ...(input.location ? {location: input.location} : {}),
    };
    const queue = this.getQueue();
    queue.push(record);
    writeJson(this.storage, QUEUE_KEY, queue);
    return record;
  }

  getQueue(): AttendanceRecord[] {
    return readJson<AttendanceRecord[]>(this.storage, QUEUE_KEY, []);
  }

  getPendingQueue(): AttendanceRecord[] {
    return this.getQueue().filter(r => !r.synced);
  }

  purge(records: AttendanceRecord[]): void {
    const keys = new Set(records.map(recordKey));
    writeJson(
      this.storage,
      QUEUE_KEY,
      this.getQueue().filter(r => !keys.has(recordKey(r))),
    );
  }

  /** Cache the geofence sites provisioned from the admin dashboard (offline use). */
  saveSites(sites: Site[]): void {
    writeJson(this.storage, SITES_KEY, sites);
  }

  getSites(): Site[] {
    return readJson<Site[]>(this.storage, SITES_KEY, []);
  }

  recordLivenessAttempt(passed: boolean): void {
    const state = readJson<LivenessLockoutState>(
      this.storage,
      LIVENESS_LOCKOUT_KEY,
      {
        consecutiveFailures: 0,
        windowStart: 0,
        lockoutUntil: 0,
        lockoutCount: 0,
      },
    );
    const now = Date.now();
    if (passed) {
      state.consecutiveFailures = 0;
      state.windowStart = 0;
      state.lockoutUntil = 0;
      state.lockoutCount = 0;
      writeJson(this.storage, LIVENESS_LOCKOUT_KEY, state);
      return;
    }
    if (now - state.windowStart > LIVENESS_LOCKOUT.windowMs) {
      state.consecutiveFailures = 1;
      state.windowStart = now;
    } else {
      state.consecutiveFailures += 1;
    }
    if (
      state.consecutiveFailures >= LIVENESS_LOCKOUT.maxAttempts &&
      now >= state.lockoutUntil
    ) {
      const duration =
        LIVENESS_LOCKOUT.baseDurationMs *
        LIVENESS_LOCKOUT.escalationFactor ** state.lockoutCount;
      state.lockoutUntil = now + duration;
      state.lockoutCount += 1;
      state.consecutiveFailures = 0;
    }
    writeJson(this.storage, LIVENESS_LOCKOUT_KEY, state);
  }

  getLivenessLockoutRemainingMs(): number {
    const state = readJson<LivenessLockoutState>(
      this.storage,
      LIVENESS_LOCKOUT_KEY,
      {
        consecutiveFailures: 0,
        windowStart: 0,
        lockoutUntil: 0,
        lockoutCount: 0,
      },
    );
    return Math.max(0, state.lockoutUntil - Date.now());
  }

  clearAll(): void {
    this.storage.delete(ENROLLMENTS_KEY);
    this.storage.delete(QUEUE_KEY);
    this.storage.delete(SITES_KEY);
    this.storage.delete(LIVENESS_LOCKOUT_KEY);
  }
}

interface LivenessLockoutState {
  consecutiveFailures: number;
  windowStart: number;
  lockoutUntil: number;
  lockoutCount: number;
}

export function recordKey(record: AttendanceRecord): string {
  return `${record.userId}|${record.timestamp}|${record.deviceId}`;
}

export function createMemoryStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    getString: key => map.get(key),
    set: (key, value) => {
      map.set(key, value);
    },
    delete: key => {
      map.delete(key);
    },
  };
}
