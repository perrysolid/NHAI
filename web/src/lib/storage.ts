/**
 * storage — browser-local persistence (localStorage), mirroring the native app's
 * encrypted MMKV store. We persist ONLY face descriptors (never images) plus the
 * pending attendance queue. The queue is purged after a successful sync.
 *
 * Note: localStorage is not encrypted — this is a demo. The native app uses
 * encrypted MMKV. Descriptors are not reversible to a face image.
 */
const ENROLL_KEY = 'dfa.enrollments.v1';
const QUEUE_KEY = 'dfa.queue.v1';

export interface Enrollment {
  userId: string;
  /** 128-d template, stored as a plain number[] for JSON. */
  descriptor: number[];
  createdAt: number;
  samples: number;
}

export interface AttendanceRecord {
  userId: string;
  timestamp: number;
  livenessPassed: boolean;
  matchDistance: number;
  deviceId: string;
  synced: boolean;
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write<T>(key: string, value: T): void {
  localStorage.setItem(key, JSON.stringify(value));
}

// ── Enrollments ──
export function getEnrollments(): Enrollment[] {
  return read<Enrollment[]>(ENROLL_KEY, []);
}

export function saveEnrollment(e: Enrollment): void {
  const all = getEnrollments().filter(x => x.userId !== e.userId);
  all.push(e);
  write(ENROLL_KEY, all);
}

export function findEnrollment(userId: string): Enrollment | undefined {
  return getEnrollments().find(e => e.userId === userId);
}

export function clearEnrollments(): void {
  localStorage.removeItem(ENROLL_KEY);
}

// ── Attendance queue ──
export function getQueue(): AttendanceRecord[] {
  return read<AttendanceRecord[]>(QUEUE_KEY, []);
}

export function enqueueRecord(r: AttendanceRecord): void {
  const q = getQueue();
  q.push(r);
  write(QUEUE_KEY, q);
}

/** Remove the given (now-synced) records from the local queue = "purge". */
export function purgeSynced(records: AttendanceRecord[]): void {
  const keys = new Set(
    records.map(r => `${r.userId}|${r.timestamp}|${r.deviceId}`),
  );
  const remaining = getQueue().filter(
    r => !keys.has(`${r.userId}|${r.timestamp}|${r.deviceId}`),
  );
  write(QUEUE_KEY, remaining);
}

export function clearQueue(): void {
  localStorage.removeItem(QUEUE_KEY);
}

/** Stable-ish per-browser device id. */
export function getDeviceId(): string {
  const k = 'dfa.deviceId';
  let id = localStorage.getItem(k);
  if (!id) {
    id = 'web-' + Math.random().toString(36).slice(2, 10);
    localStorage.setItem(k, id);
  }
  return id;
}
