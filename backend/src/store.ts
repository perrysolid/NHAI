/**
 * store — attendance record persistence.
 *
 * Uses Postgres when DATABASE_URL is set (recommended on AWS/Render for
 * durability), otherwise an in-memory store so the service deploys and runs
 * instantly for a demo. Both dedupe on (userId, timestamp, deviceId).
 *
 * Each record carries an optional frame-inspection snapshot (drowsiness, pose,
 * lighting) captured on-device at verification time.
 */
import {Pool} from 'pg';

export interface InspectionMetrics {
  ear: number;
  perclos: number;
  blinkRate: number;
  drowsy: boolean;
  lookingAway: boolean;
  yawDeg: number;
  pitchDeg: number;
  brightness: number;
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
  livenessPassed: boolean;
  matchDistance: number;
  deviceId: string;
  confidence?: number;
  score?: number;
  latencyMs?: number;
  inspection?: InspectionMetrics;
  /** On-device geofence summary — present when the device had a GPS fix. */
  location?: RecordLocation;
}

function optNum(v: unknown): number | undefined {
  if (v === undefined || v === null) {
    return undefined;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export interface Store {
  init(): Promise<void>;
  add(records: AttendanceRecord[]): Promise<AttendanceRecord[]>;
  list(limit: number, since?: number): Promise<AttendanceRecord[]>;
  kind: 'postgres' | 'memory';
}

function keyOf(r: AttendanceRecord): string {
  return `${r.userId}|${r.timestamp}|${r.deviceId}`;
}

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function sanitizeInspection(raw: unknown): InspectionMetrics | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const o = raw as Record<string, unknown>;
  return {
    ear: num(o.ear),
    perclos: num(o.perclos),
    blinkRate: num(o.blinkRate),
    drowsy: Boolean(o.drowsy),
    lookingAway: Boolean(o.lookingAway),
    yawDeg: num(o.yawDeg),
    pitchDeg: num(o.pitchDeg),
    brightness: num(o.brightness),
  };
}

function sanitizeLocation(o: Record<string, unknown>): RecordLocation | undefined {
  const lat = optNum(o.lat);
  const lon = optNum(o.lon);
  if (lat === undefined || lon === undefined) {
    return undefined;
  }
  return {
    lat,
    lon,
    accuracyM: num(o.accuracyM),
    mocked: Boolean(o.mocked),
    geofencePassed: Boolean(o.geofencePassed),
    siteId: typeof o.siteId === 'string' ? o.siteId.slice(0, 128) : undefined,
    distanceM: num(o.distanceM),
  };
}

function sanitize(r: unknown): AttendanceRecord | null {
  if (typeof r !== 'object' || r === null) {
    return null;
  }
  const o = r as Record<string, unknown>;
  if (typeof o.userId !== 'string' || typeof o.deviceId !== 'string') {
    return null;
  }
  const timestamp = Number(o.timestamp);
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  return {
    userId: o.userId.slice(0, 128),
    timestamp,
    deviceId: o.deviceId.slice(0, 128),
    livenessPassed: Boolean(o.livenessPassed),
    matchDistance: num(o.matchDistance),
    confidence: optNum(o.confidence),
    score: optNum(o.score),
    latencyMs: optNum(o.latencyMs),
    inspection: sanitizeInspection(o.inspection),
    location: sanitizeLocation(o),
  };
}

export function sanitizeMany(input: unknown): AttendanceRecord[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return input
    .map(sanitize)
    .filter((r): r is AttendanceRecord => r !== null);
}

// ── In-memory ──
class MemoryStore implements Store {
  kind = 'memory' as const;
  private seen = new Set<string>();
  private rows: AttendanceRecord[] = [];

  async init(): Promise<void> {}

  async add(records: AttendanceRecord[]): Promise<AttendanceRecord[]> {
    const accepted: AttendanceRecord[] = [];
    for (const r of records) {
      const k = keyOf(r);
      if (!this.seen.has(k)) {
        this.seen.add(k);
        this.rows.push(r);
        accepted.push(r);
      }
    }
    return accepted;
  }

  async list(limit: number, since = 0): Promise<AttendanceRecord[]> {
    return this.rows
      .filter(r => r.timestamp >= since)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }
}

// ── Postgres ──
class PostgresStore implements Store {
  kind = 'postgres' as const;
  private pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      ssl: connectionString.includes('localhost')
        ? undefined
        : {rejectUnauthorized: false},
    });
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS attendance (
        user_id        TEXT   NOT NULL,
        ts             BIGINT NOT NULL,
        device_id      TEXT   NOT NULL,
        liveness_passed BOOLEAN NOT NULL,
        match_distance REAL   NOT NULL,
        confidence     REAL,
        score          REAL,
        latency_ms     INTEGER,
        metrics        JSONB,
        location       JSONB,
        created_at     TIMESTAMPTZ DEFAULT now(),
        PRIMARY KEY (user_id, ts, device_id)
      );
    `);
    // tolerate pre-existing tables without the newer columns
    for (const col of [
      'confidence REAL',
      'score REAL',
      'latency_ms INTEGER',
      'metrics JSONB',
      'location JSONB',
    ]) {
      await this.pool.query(
        `ALTER TABLE attendance ADD COLUMN IF NOT EXISTS ${col};`,
      );
    }
  }

  async add(records: AttendanceRecord[]): Promise<AttendanceRecord[]> {
    const accepted: AttendanceRecord[] = [];
    for (const r of records) {
      const res = await this.pool.query(
        `INSERT INTO attendance (user_id, ts, device_id, liveness_passed, match_distance, confidence, score, latency_ms, metrics, location)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (user_id, ts, device_id) DO NOTHING`,
        [
          r.userId,
          r.timestamp,
          r.deviceId,
          r.livenessPassed,
          r.matchDistance,
          r.confidence ?? null,
          r.score ?? null,
          r.latencyMs ?? null,
          r.inspection ? JSON.stringify(r.inspection) : null,
          r.location ? JSON.stringify(r.location) : null,
        ],
      );
      if ((res.rowCount ?? 0) > 0) {
        accepted.push(r);
      }
    }
    return accepted;
  }

  async list(limit: number, since = 0): Promise<AttendanceRecord[]> {
    const res = await this.pool.query(
      `SELECT user_id, ts, device_id, liveness_passed, match_distance, confidence, score, latency_ms, metrics, location
         FROM attendance WHERE ts >= $1
        ORDER BY ts DESC LIMIT $2`,
      [since, limit],
    );
    return res.rows.map(row => ({
      userId: row.user_id,
      timestamp: Number(row.ts),
      deviceId: row.device_id,
      livenessPassed: row.liveness_passed,
      matchDistance: row.match_distance,
      confidence: optNum(row.confidence),
      score: optNum(row.score),
      latencyMs: optNum(row.latency_ms),
      inspection: sanitizeInspection(row.metrics),
      location:
        row.location != null
          ? sanitizeLocation(
              typeof row.location === 'string'
                ? JSON.parse(row.location)
                : row.location,
            )
          : undefined,
    }));
  }
}

export function createStore(): Store {
  const url = process.env.DATABASE_URL;
  return url ? new PostgresStore(url) : new MemoryStore();
}
