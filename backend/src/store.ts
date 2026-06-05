/**
 * store — attendance record persistence.
 *
 * Uses Postgres when DATABASE_URL is set (recommended on Render for durability),
 * otherwise an in-memory store so the service deploys and runs instantly for a
 * demo. Both dedupe on (userId, timestamp, deviceId).
 */
import {Pool} from 'pg';

export interface AttendanceRecord {
  userId: string;
  timestamp: number;
  livenessPassed: boolean;
  matchDistance: number;
  deviceId: string;
}

export interface Store {
  init(): Promise<void>;
  add(records: AttendanceRecord[]): Promise<number>;
  list(limit: number, since?: number): Promise<AttendanceRecord[]>;
  kind: 'postgres' | 'memory';
}

function keyOf(r: AttendanceRecord): string {
  return `${r.userId}|${r.timestamp}|${r.deviceId}`;
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
    matchDistance: Number(o.matchDistance) || 0,
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

  async add(records: AttendanceRecord[]): Promise<number> {
    let accepted = 0;
    for (const r of records) {
      const k = keyOf(r);
      if (!this.seen.has(k)) {
        this.seen.add(k);
        this.rows.push(r);
        accepted++;
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
        created_at     TIMESTAMPTZ DEFAULT now(),
        PRIMARY KEY (user_id, ts, device_id)
      );
    `);
  }

  async add(records: AttendanceRecord[]): Promise<number> {
    let accepted = 0;
    for (const r of records) {
      const res = await this.pool.query(
        `INSERT INTO attendance (user_id, ts, device_id, liveness_passed, match_distance)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (user_id, ts, device_id) DO NOTHING`,
        [r.userId, r.timestamp, r.deviceId, r.livenessPassed, r.matchDistance],
      );
      accepted += res.rowCount ?? 0;
    }
    return accepted;
  }

  async list(limit: number, since = 0): Promise<AttendanceRecord[]> {
    const res = await this.pool.query(
      `SELECT user_id, ts, device_id, liveness_passed, match_distance
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
    }));
  }
}

export function createStore(): Store {
  const url = process.env.DATABASE_URL;
  return url ? new PostgresStore(url) : new MemoryStore();
}
