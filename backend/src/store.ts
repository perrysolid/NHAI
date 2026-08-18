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
import {evaluatePresence} from './presence.js';

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
  /** DERIVED SERVER-SIDE by presence.ts — never trusted from the device.
   *  The attendance register column: was this inspector marked present? */
  present?: boolean;
  /** Why `present` holds that value, e.g. 'outside_assigned_site'. */
  presenceReason?: string;
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

/**
 * Stamp the derived attendance mark onto a record before it is stored.
 * Always recomputed server-side — a `present` value arriving from a device is
 * ignored, because the whole point is that the register is not device-decided.
 */
function withPresence(r: AttendanceRecord): AttendanceRecord {
  const {status, reason} = evaluatePresence(r);
  return {...r, present: status === 'present', presenceReason: reason};
}

/**
 * A missing column, in every shape this stack reports one.
 *
 * There are TWO distinct errors, and matching only the obvious one is what made
 * the first version of this guard useless in production:
 *
 *   reads   Postgres 42703  "column attendance.present does not exist"
 *   writes  PostgREST 204   "Could not find the 'presence_reason' column of
 *                            'attendance' in the schema cache"
 *
 * The write path never returns 42703. PostgREST builds the statement from its
 * cached schema, so an unknown column is rejected client-side before Postgres
 * is ever asked — a different code AND a message with no "does not exist" in
 * it. The observed failure on the deployed instance was the second form.
 *
 * Codes are checked first; the message patterns are the fallback for client
 * versions that omit `code`.
 */
export function isMissingColumnError(e: {code?: string; message?: string}): boolean {
  if (e.code === '42703' || e.code === 'PGRST204') {
    return true;
  }
  // Deliberately column-scoped. A missing TABLE reports through the same two
  // channels ("relation ... does not exist", PGRST205 "Could not find the table
  // ... in the schema cache") and is a real outage — retrying it with two fields
  // removed would just fail again while hiding the cause.
  const m = e.message ?? '';
  return (
    /column .* does not exist/i.test(m) || /could not find the .* column/i.test(m)
  );
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

/**
 * Thrown when a device is over its submission budget. Signals BACKPRESSURE, not
 * invalid data — the caller must answer 429 so the device retries later.
 *
 * WHY THIS IS AN ERROR AND NOT A FILTER. Being over the rate limit used to drop
 * the offending records inside guard(). Because the device only purges records
 * the server ACKNOWLEDGES, every dropped record stayed in the local queue and
 * was resubmitted forever — and since the count comes from rows already
 * persisted in the last 60s, any device returning from an outage with a backlog
 * tripped it immediately. That silently and permanently destroyed genuine
 * attendance data in precisely the offline-first scenario this system exists
 * for. Rate limiting is a transport concern: refuse the REQUEST, keep the data.
 */
export class RateLimitExceededError extends Error {
  constructor(public readonly deviceId: string) {
    super(`device ${deviceId} exceeded ${RATE_LIMIT_PER_DEVICE} records/min`);
    this.name = 'RateLimitExceededError';
  }
}

/** Score sanity bounds — anything outside is definitively tampered. */
function scoreSanity(r: AttendanceRecord): boolean {
  if (r.matchDistance < 0 || r.matchDistance > 1) return false;
  if (r.confidence !== undefined && (r.confidence < 0 || r.confidence > 1)) return false;
  if (r.score !== undefined && (r.score < 0 || r.score > 100)) return false;
  if (r.latencyMs !== undefined && r.latencyMs < 0) return false;
  return true;
}

/**
 * Submission counter keyed on SERVER RECEIPT TIME.
 *
 * The window used to be derived from each record's `ts` field — a value the
 * device supplies. Backdating the timestamps therefore skipped the limiter
 * completely (verified: 35 records with 1970-era timestamps sailed through
 * while 35 with current ones were correctly refused at 31), and keeping the
 * timestamps increasing still satisfied the monotonic check. A limiter an
 * attacker can switch off is worse than none, because it reads as protection.
 *
 * Owned by each Store instance rather than kept module-global: the budget is
 * part of a store's state, so two stores (a test's and the app's, or two in one
 * process) must not silently share or leak one counter.
 *
 * Deliberately in-process, so it is per-instance and resets on restart. That is
 * an honest backstop, not the real control: distributed enforcement belongs at
 * the edge, keyed by deviceId (CLAUDE.md §8).
 */
class DeviceRateTracker {
  private hits = new Map<string, number[]>();

  count(deviceId: string, now: number): number {
    const cutoff = now - 60_000;
    const recent = (this.hits.get(deviceId) ?? []).filter(t => t > cutoff);
    if (recent.length > 0) {
      this.hits.set(deviceId, recent);
    } else {
      this.hits.delete(deviceId); // keep the map from growing with dead devices
    }
    return recent.length;
  }

  add(deviceId: string, now: number, n: number): void {
    const recent = this.hits.get(deviceId) ?? [];
    for (let i = 0; i < n; i++) {
      recent.push(now);
    }
    this.hits.set(deviceId, recent);
  }
}

/**
 * Reject the whole REQUEST when a device is over its per-minute budget, so the
 * device can retry with its data intact. See RateLimitExceededError for why
 * this must not be a per-record filter.
 */
function assertWithinRate(
  tracker: DeviceRateTracker,
  records: AttendanceRecord[],
  now = Date.now(),
): void {
  for (const deviceId of new Set(records.map(r => r.deviceId))) {
    if (tracker.count(deviceId, now) >= RATE_LIMIT_PER_DEVICE) {
      throw new RateLimitExceededError(deviceId);
    }
  }
}

/** Charge admitted records against the submitting device's budget. */
function chargeRate(
  tracker: DeviceRateTracker,
  records: AttendanceRecord[],
  now = Date.now(),
): void {
  const perDevice = new Map<string, number>();
  for (const r of records) {
    perDevice.set(r.deviceId, (perDevice.get(r.deviceId) ?? 0) + 1);
  }
  for (const [deviceId, n] of perDevice) {
    tracker.add(deviceId, now, n);
  }
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
  private rate = new DeviceRateTracker();
  private seen = new Set<string>();
  private rows: AttendanceRecord[] = [];

  async init(): Promise<void> {}

  async add(input: AttendanceRecord[]): Promise<AttendanceRecord[]> {
    const records = input.map(withPresence);
    for (const r of records) {
      const k = keyOf(r);
      if (!this.seen.has(k)) {
        this.seen.add(k);
        this.rows.push(r);
      }
    }
    // Acknowledge every record that is now durably stored, INCLUDING ones that
    // were already present. The device purges only what the server
    // acknowledges, so withholding the ack for a duplicate left it queued for
    // good after any lost response.
    return records;
  }

  async guard(records: AttendanceRecord[]): Promise<AttendanceRecord[]> {
    // Index existing data: max timestamp per (userId, deviceId) and the known
    // deviceId set per userId. Submission rate is tracked separately, on the
    // server clock (see DeviceRateTracker).
    const lastTs = new Map<string, number>();
    const userIdDevices = new Map<string, Set<string>>();
    for (const row of this.rows) {
      const pair = `${row.userId}|${row.deviceId}`;
      const prev = lastTs.get(pair) ?? 0;
      if (row.timestamp > prev) lastTs.set(pair, row.timestamp);
      let devices = userIdDevices.get(row.userId);
      if (!devices) {
        devices = new Set();
        userIdDevices.set(row.userId, devices);
      }
      devices.add(row.deviceId);
    }
    assertWithinRate(this.rate, records);
    const kept = records.filter(r => {
      if (!scoreSanity(r)) return false;
      // Monotonic timestamp: reject if a newer record exists for this pair.
      const pair = `${r.userId}|${r.deviceId}`;
      const max = lastTs.get(pair);
      // STRICTLY older is a replay; EQUAL is the same record arriving twice,
      // which is a lost acknowledgement, not an attack. Rejecting equality
      // wedged the device forever: the ack never reached it, so it resubmitted
      // a record the server now refused, and it could never purge what the
      // server would not acknowledge. The (userId, ts, deviceId) primary key
      // makes re-sends idempotent, so let them through and re-acknowledge.
      if (max !== undefined && r.timestamp < max) return false;
      // Rate limit per device in rolling 60s window.
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
    chargeRate(this.rate, kept);
    return kept;
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
  private rate = new DeviceRateTracker();
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
        present        BOOLEAN,
        presence_reason TEXT,
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
      'present BOOLEAN',
      'presence_reason TEXT',
    ]) {
      await this.pool.query(
        `ALTER TABLE attendance ADD COLUMN IF NOT EXISTS ${col};`,
      );
    }
  }

  async add(input: AttendanceRecord[]): Promise<AttendanceRecord[]> {
    const records = input.map(withPresence);
    for (const r of records) {
      await this.pool.query(
        `INSERT INTO attendance (user_id, ts, device_id, liveness_passed, match_distance, confidence, score, latency_ms, metrics, location, present, presence_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
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
          evaluatePresence(r).status === 'present',
          evaluatePresence(r).reason,
        ],
      );
    }
    // Every record is now stored (inserted, or already present via ON CONFLICT
    // DO NOTHING). Acknowledge them all so a re-send after a lost response can
    // finally be purged from the device queue.
    return records;
  }

  async guard(records: AttendanceRecord[]): Promise<AttendanceRecord[]> {
    const userIds = [...new Set(records.map(r => r.userId))];
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
    assertWithinRate(this.rate, records);
    const kept = records.filter(r => {
      if (!scoreSanity(r)) return false;
      const pair = `${r.userId}|${r.deviceId}`;
      const max = lastTs.get(pair);
      // STRICTLY older is a replay; EQUAL is the same record arriving twice,
      // which is a lost acknowledgement, not an attack. Rejecting equality
      // wedged the device forever: the ack never reached it, so it resubmitted
      // a record the server now refused, and it could never purge what the
      // server would not acknowledge. The (userId, ts, deviceId) primary key
      // makes re-sends idempotent, so let them through and re-acknowledge.
      if (max !== undefined && r.timestamp < max) return false;
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
    chargeRate(this.rate, kept);
    return kept;
  }

  async list(limit: number, since = 0): Promise<AttendanceRecord[]> {
    const res = await this.pool.query(
      `SELECT user_id, ts, device_id, liveness_passed, match_distance, confidence, score, latency_ms, metrics, location, present, presence_reason
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
      present: row.present ?? undefined,
      presenceReason: row.presence_reason ?? undefined,
    }));
  }
}

// ── Supabase (service_role via supabase-js) ──
// Table `attendance` (see docs/SUPABASE.md). Dedupes on (user_id, ts, device_id).
class SupabaseStore implements Store {
  kind = 'postgres' as const;
  private rate = new DeviceRateTracker();
  private get db() {
    const c = getSupabase();
    if (!c) {
      throw new Error('Supabase not configured');
    }
    return c;
  }
  /**
   * Whether the table actually has the derived presence columns.
   *
   * Unlike PostgresStore, this store CANNOT self-migrate — PostgREST exposes no
   * DDL, so `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` has no equivalent here.
   * A column added to the code but not to the database therefore made every
   * upsert fail with 42703, which turned a derived, entirely optional field
   * into a total outage of attendance sync. Presence is computed from the
   * record and recomputed at render time, so losing the persisted copy must
   * never cost a real attendance record. Probed at init, and re-checked if a
   * write ever disagrees.
   */
  private hasPresenceColumns = true;

  async init(): Promise<void> {
    const {error} = await this.db.from('attendance').select('user_id').limit(1);
    if (error && !/permission|row-level/i.test(error.message)) {
      // eslint-disable-next-line no-console
      console.warn(`[store] Supabase probe: ${error.message} — run docs/SUPABASE.md schema.`);
    }
    const probe = await this.db.from('attendance').select('present').limit(1);
    if (probe.error && isMissingColumnError(probe.error)) {
      this.hasPresenceColumns = false;
      // eslint-disable-next-line no-console
      console.warn(
        '[store] attendance.present / presence_reason missing — syncing without ' +
          'them. Run the ALTER TABLE in docs/SUPABASE.md to persist the register.',
      );
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
      ...(this.hasPresenceColumns
        ? {
            present: evaluatePresence(r).status === 'present',
            presence_reason: evaluatePresence(r).reason,
          }
        : {}),
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
      present: (row.present as boolean | null) ?? undefined,
      presenceReason: (row.presence_reason as string | null) ?? undefined,
    };
  }
  async add(input: AttendanceRecord[]): Promise<AttendanceRecord[]> {
    const records = input.map(withPresence);
    let {error} = await this.db
      .from('attendance')
      .upsert(records.map(r => this.toRow(r)), {
        onConflict: 'user_id,ts,device_id',
        ignoreDuplicates: true,
      });
    // The columns can go missing between init and now (a store pointed at a
    // fresh project, a rolled-back migration). Drop the derived fields and
    // retry once: attendance is the record that matters, presence is not.
    if (error && isMissingColumnError(error) && this.hasPresenceColumns) {
      this.hasPresenceColumns = false;
      // eslint-disable-next-line no-console
      console.warn(
        '[store] presence columns absent — retrying sync without them. ' +
          'Run the ALTER TABLE in docs/SUPABASE.md.',
      );
      ({error} = await this.db
        .from('attendance')
        .upsert(records.map(r => this.toRow(r)), {
          onConflict: 'user_id,ts,device_id',
          ignoreDuplicates: true,
        }));
    }
    if (error) {
      throw new Error(error.message);
    }
    // Upsert guarantees presence, so acknowledge the full set rather than only
    // the rows this call happened to insert — otherwise a duplicate arriving
    // after a lost response could never be purged from the device queue.
    return records;
  }

  async guard(records: AttendanceRecord[]): Promise<AttendanceRecord[]> {
    const userIds = [...new Set(records.map(r => r.userId))];
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
    assertWithinRate(this.rate, records);
    const kept = records.filter(r => {
      if (!scoreSanity(r)) return false;
      const pair = `${r.userId}|${r.deviceId}`;
      const max = lastMap.get(pair);
      // STRICTLY older is a replay; EQUAL is the same record arriving twice,
      // which is a lost acknowledgement, not an attack. Rejecting equality
      // wedged the device forever: the ack never reached it, so it resubmitted
      // a record the server now refused, and it could never purge what the
      // server would not acknowledge. The (userId, ts, deviceId) primary key
      // makes re-sends idempotent, so let them through and re-acknowledge.
      if (max !== undefined && r.timestamp < max) return false;
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
    chargeRate(this.rate, kept);
    return kept;
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
