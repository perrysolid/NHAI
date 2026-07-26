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
import {getSupabase, isSupabaseConfigured} from './supabase.js';

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
  /**
   * Integrity guard — rejects records that fail tamper checks before they
   * reach persistent storage. Runs inside the same store so it can query
   * existing data (monotonic timestamps, cross-device collisions, rate
   * gates) without exposing internal state to the HTTP layer.
   */
  guard(records: AttendanceRecord[]): Promise<AttendanceRecord[]>;
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

// ── Integrity checks (tamper prevention, no app changes) ──

/** Maximum attendance records a single device may submit per rolling minute. */
const RATE_LIMIT_PER_DEVICE = 30;

/** Score sanity bounds — anything outside is definitively tampered. */
function scoreSanity(r: AttendanceRecord): boolean {
  if (r.matchDistance < 0 || r.matchDistance > 1) return false;
  if (r.confidence !== undefined && (r.confidence < 0 || r.confidence > 1)) return false;
  if (r.score !== undefined && (r.score < 0 || r.score > 100)) return false;
  if (r.latencyMs !== undefined && r.latencyMs < 0) return false;
  return true;
}

/** Build a map of {userId → {deviceId, maxTimestamp}} from a record set. */
function deviceMaxTs(
  recs: AttendanceRecord[],
): Map<string, Map<string, number>> {
  const m = new Map<string, Map<string, number>>();
  for (const r of recs) {
    let byDevice = m.get(r.userId);
    if (!byDevice) {
      byDevice = new Map();
      m.set(r.userId, byDevice);
    }
    const prev = byDevice.get(r.deviceId) ?? 0;
    if (r.timestamp > prev) byDevice.set(r.deviceId, r.timestamp);
  }
  return m;
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

  async guard(records: AttendanceRecord[]): Promise<AttendanceRecord[]> {
    const now = Date.now();
    // Index existing data: max timestamp per (userId, deviceId), rate
    // counts per deviceId, and known deviceId sets per userId.
    const lastTs = new Map<string, number>();
    const devCount = new Map<string, number>();
    const userIdDevices = new Map<string, Set<string>>();
    for (const row of this.rows) {
      const pair = `${row.userId}|${row.deviceId}`;
      const prev = lastTs.get(pair) ?? 0;
      if (row.timestamp > prev) lastTs.set(pair, row.timestamp);
      if (row.timestamp > now - 60_000) {
        devCount.set(row.deviceId, (devCount.get(row.deviceId) ?? 0) + 1);
      }
      let devices = userIdDevices.get(row.userId);
      if (!devices) {
        devices = new Set();
        userIdDevices.set(row.userId, devices);
      }
      devices.add(row.deviceId);
    }
    return records.filter(r => {
      if (!scoreSanity(r)) return false;
      // Monotonic timestamp: reject if a newer record exists for this pair.
      const pair = `${r.userId}|${r.deviceId}`;
      const max = lastTs.get(pair);
      if (max !== undefined && r.timestamp <= max) return false;
      // Rate limit per device in rolling 60s window.
      const cnt = devCount.get(r.deviceId) ?? 0;
      if (cnt >= RATE_LIMIT_PER_DEVICE) return false;
      // Cross-device timeline check: if another device was active for this
      // userId AFTER this record's timestamp, reject (likely injection).
      const knownDevices = userIdDevices.get(r.userId);
      if (knownDevices) {
        for (const otherDev of knownDevices) {
          if (otherDev === r.deviceId) continue;
          const otherPair = `${r.userId}|${otherDev}`;
          const otherLast = lastTs.get(otherPair) ?? 0;
          if (otherLast > r.timestamp) return false;
        }
      }
      return true;
    });
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

  async guard(records: AttendanceRecord[]): Promise<AttendanceRecord[]> {
    const now = Date.now();
    const userIds = [...new Set(records.map(r => r.userId))];
    const deviceIds = [...new Set(records.map(r => r.deviceId))];
    // Fetch last timestamp per (userId, deviceId).
    const {rows: lastRows} = await this.pool.query(
      `SELECT user_id, device_id, MAX(ts) as last_ts
         FROM attendance
        WHERE user_id = ANY($1::text[])
        GROUP BY user_id, device_id`,
      [userIds],
    );
    const lastTs = new Map<string, number>();
    for (const row of lastRows) {
      lastTs.set(`${row.user_id}|${row.device_id}`, Number(row.last_ts));
    }
    // Fetch rate counts per device in the last 60s.
    const {rows: countRows} = await this.pool.query(
      `SELECT device_id, COUNT(*) as cnt
         FROM attendance
        WHERE device_id = ANY($1::text[]) AND ts > $2
        GROUP BY device_id`,
      [deviceIds, now - 60_000],
    );
    const devCount = new Map<string, number>();
    for (const row of countRows) {
      devCount.set(row.device_id, Number(row.cnt));
    }
    // Fetch cross-device scope.
    const {rows: devRows} = await this.pool.query(
      `SELECT user_id, ARRAY_AGG(DISTINCT device_id) as devices
         FROM attendance
        WHERE user_id = ANY($1::text[])
        GROUP BY user_id`,
      [userIds],
    );
    const userIdDevices = new Map<string, Set<string>>();
    for (const row of devRows) {
      userIdDevices.set(row.user_id, new Set(row.devices));
    }
    return records.filter(r => {
      if (!scoreSanity(r)) return false;
      const pair = `${r.userId}|${r.deviceId}`;
      const max = lastTs.get(pair);
      if (max !== undefined && r.timestamp <= max) return false;
      const cnt = devCount.get(r.deviceId) ?? 0;
      if (cnt >= RATE_LIMIT_PER_DEVICE) return false;
      const knownDevices = userIdDevices.get(r.userId);
      if (knownDevices) {
        for (const otherDev of knownDevices) {
          if (otherDev === r.deviceId) continue;
          const otherPair = `${r.userId}|${otherDev}`;
          const otherLast = lastTs.get(otherPair) ?? 0;
          if (otherLast > r.timestamp) return false;
        }
      }
      return true;
    });
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

// ── Supabase (service_role via supabase-js) ──
// Table `attendance` (see docs/SUPABASE.md). Dedupes on (user_id, ts, device_id).
class SupabaseStore implements Store {
  kind = 'postgres' as const;
  private get db() {
    const c = getSupabase();
    if (!c) {
      throw new Error('Supabase not configured');
    }
    return c;
  }
  async init(): Promise<void> {
    const {error} = await this.db.from('attendance').select('user_id').limit(1);
    if (error && !/permission|row-level/i.test(error.message)) {
      // eslint-disable-next-line no-console
      console.warn(`[store] Supabase probe: ${error.message} — run docs/SUPABASE.md schema.`);
    }
  }
  private toRow(r: AttendanceRecord) {
    return {
      user_id: r.userId,
      ts: r.timestamp,
      device_id: r.deviceId,
      liveness_passed: r.livenessPassed,
      match_distance: r.matchDistance,
      confidence: r.confidence ?? null,
      score: r.score ?? null,
      latency_ms: r.latencyMs ?? null,
      metrics: r.inspection ?? null,
      location: r.location ?? null,
    };
  }
  private fromRow(row: Record<string, unknown>): AttendanceRecord {
    return {
      userId: String(row.user_id),
      timestamp: Number(row.ts),
      deviceId: String(row.device_id),
      livenessPassed: Boolean(row.liveness_passed),
      matchDistance: num(row.match_distance),
      confidence: optNum(row.confidence),
      score: optNum(row.score),
      latencyMs: optNum(row.latency_ms),
      inspection: sanitizeInspection(row.metrics),
      location:
        row.location != null
          ? sanitizeLocation(row.location as Record<string, unknown>)
          : undefined,
    };
  }
  async add(records: AttendanceRecord[]): Promise<AttendanceRecord[]> {
    const {data, error} = await this.db
      .from('attendance')
      .upsert(records.map(r => this.toRow(r)), {
        onConflict: 'user_id,ts,device_id',
        ignoreDuplicates: true,
      })
      .select();
    if (error) {
      throw new Error(error.message);
    }
    return (data ?? []).map(r => this.fromRow(r));
  }

  async guard(records: AttendanceRecord[]): Promise<AttendanceRecord[]> {
    const now = Date.now();
    const userIds = [...new Set(records.map(r => r.userId))];
    const deviceIds = [...new Set(records.map(r => r.deviceId))];
    // Fetch last timestamp per (userId, deviceId). Supabase doesn't expose
    // GROUP BY in the JS client, so we fetch all records for these users and
    // aggregate in JS. This is acceptable at hackathon scale; for production
    // use a Postgres RPC function with the GROUP BY query instead.
    const lastMap = new Map<string, number>();
    for (const uid of userIds) {
      const {data} = await this.db
        .from('attendance')
        .select('user_id, device_id, ts')
        .eq('user_id', uid);
      if (data) {
        for (const row of data) {
          const pair = `${row.user_id}|${row.device_id}`;
          const prev = lastMap.get(pair) ?? 0;
          if (row.ts > prev) lastMap.set(pair, row.ts);
        }
      }
    }
    // Fetch rate counts per device in the last 60s.
    const devCount = new Map<string, number>();
    for (const did of deviceIds) {
      const {count, error} = await this.db
        .from('attendance')
        .select('*', {count: 'exact', head: true})
        .eq('device_id', did)
        .gte('ts', now - 60_000);
      if (!error && typeof count === 'number') {
        devCount.set(did, count);
      }
    }
    // Fetch cross-device scope per user.
    const userIdDevices = new Map<string, Set<string>>();
    for (const uid of userIds) {
      const {data} = await this.db
        .from('attendance')
        .select('device_id')
        .eq('user_id', uid);
      if (data) {
        userIdDevices.set(uid, new Set(data.map(d => d.device_id)));
      }
    }
    return records.filter(r => {
      if (!scoreSanity(r)) return false;
      const pair = `${r.userId}|${r.deviceId}`;
      const max = lastMap.get(pair);
      if (max !== undefined && r.timestamp <= max) return false;
      const cnt = devCount.get(r.deviceId) ?? 0;
      if (cnt >= RATE_LIMIT_PER_DEVICE) return false;
      const knownDevices = userIdDevices.get(r.userId);
      if (knownDevices) {
        for (const otherDev of knownDevices) {
          if (otherDev === r.deviceId) continue;
          const otherPair = `${r.userId}|${otherDev}`;
          const otherLast = lastMap.get(otherPair) ?? 0;
          if (otherLast > r.timestamp) return false;
        }
      }
      return true;
    });
  }

  async list(limit: number, since = 0): Promise<AttendanceRecord[]> {
    const {data, error} = await this.db
      .from('attendance')
      .select('*')
      .gte('ts', since)
      .order('ts', {ascending: false})
      .limit(limit);
    if (error) {
      throw new Error(error.message);
    }
    return (data ?? []).map(r => this.fromRow(r));
  }
}

export function createStore(): Store {
  if (isSupabaseConfigured()) {
    return new SupabaseStore();
  }
  const url = process.env.DATABASE_URL;
  return url ? new PostgresStore(url) : new MemoryStore();
}
