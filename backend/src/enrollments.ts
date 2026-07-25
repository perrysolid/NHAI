/**
 * enrollments — central inspector registry.
 *
 * Enrollment is ONLINE and one-time: the phone computes the face embedding
 * on-device and posts {userId, name, role, embedding, deviceId} here. The
 * embedding (not the image, and not reversible to a face) is stored so the admin
 * can see every enrolled inspector and any device can pull a template to verify
 * that inspector OFFLINE later.
 *
 * Persistence: Supabase → Postgres(DATABASE_URL) → in-memory (same as the other
 * stores). Admin list responses omit the embedding to stay light.
 */
import {Pool} from 'pg';
import {getSupabase, isSupabaseConfigured} from './supabase.js';
import {ROLES, type Role} from './sites.js';

export interface Enrollment {
  userId: string;
  name: string;
  role: Role;
  /** L2-normalized face template (192-d MobileFaceNet / 512-d EdgeFace). */
  embedding: number[];
  deviceId: string;
  samples: number;
  enrolledAt: number;
}

/** Admin-facing view without the raw template. */
export type EnrollmentSummary = Omit<Enrollment, 'embedding'> & {
  embeddingLength: number;
};

export interface EnrollmentsStore {
  init(): Promise<void>;
  upsert(e: Enrollment): Promise<Enrollment>;
  list(): Promise<EnrollmentSummary[]>;
  get(userId: string): Promise<Enrollment | null>;
  remove(userId: string): Promise<boolean>;
  kind: 'postgres' | 'memory';
}

function isRole(v: unknown): v is Role {
  return typeof v === 'string' && (ROLES as readonly string[]).includes(v);
}

export function sanitizeEnrollment(raw: unknown): Enrollment | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const o = raw as Record<string, unknown>;
  const userId = typeof o.userId === 'string' ? o.userId.trim().slice(0, 128) : '';
  const embedding = Array.isArray(o.embedding)
    ? o.embedding.map(Number).filter(n => Number.isFinite(n))
    : [];
  if (!userId || embedding.length === 0) {
    return null;
  }
  return {
    userId,
    name: typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 200) : userId,
    role: isRole(o.role) ? o.role : 'authority-engineer',
    embedding,
    deviceId: typeof o.deviceId === 'string' ? o.deviceId.slice(0, 128) : 'unknown',
    samples: Number.isFinite(Number(o.samples)) ? Number(o.samples) : 1,
    enrolledAt: Date.now(),
  };
}

const summarize = (e: Enrollment): EnrollmentSummary => {
  const {embedding, ...rest} = e;
  return {...rest, embeddingLength: embedding.length};
};

// ── In-memory ──
class MemoryEnrollmentsStore implements EnrollmentsStore {
  kind = 'memory' as const;
  private byId = new Map<string, Enrollment>();
  async init(): Promise<void> {}
  async upsert(e: Enrollment): Promise<Enrollment> {
    this.byId.set(e.userId, e);
    return e;
  }
  async list(): Promise<EnrollmentSummary[]> {
    return [...this.byId.values()]
      .sort((a, b) => b.enrolledAt - a.enrolledAt)
      .map(summarize);
  }
  async get(userId: string): Promise<Enrollment | null> {
    return this.byId.get(userId) ?? null;
  }
  async remove(userId: string): Promise<boolean> {
    return this.byId.delete(userId);
  }
}

// ── Postgres ──
class PostgresEnrollmentsStore implements EnrollmentsStore {
  kind = 'postgres' as const;
  private pool: Pool;
  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      ssl: connectionString.includes('localhost') ? undefined : {rejectUnauthorized: false},
    });
  }
  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS enrollments (
        user_id    TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        role       TEXT NOT NULL,
        embedding  JSONB NOT NULL,
        device_id  TEXT NOT NULL,
        samples    INTEGER NOT NULL,
        enrolled_at BIGINT NOT NULL
      );
    `);
  }
  private map(row: Record<string, unknown>): Enrollment {
    return {
      userId: String(row.user_id),
      name: String(row.name),
      role: row.role as Role,
      embedding: (typeof row.embedding === 'string'
        ? JSON.parse(row.embedding)
        : row.embedding) as number[],
      deviceId: String(row.device_id),
      samples: Number(row.samples),
      enrolledAt: Number(row.enrolled_at),
    };
  }
  async upsert(e: Enrollment): Promise<Enrollment> {
    await this.pool.query(
      `INSERT INTO enrollments (user_id, name, role, embedding, device_id, samples, enrolled_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (user_id) DO UPDATE SET
         name=$2, role=$3, embedding=$4, device_id=$5, samples=$6, enrolled_at=$7`,
      [e.userId, e.name, e.role, JSON.stringify(e.embedding), e.deviceId, e.samples, e.enrolledAt],
    );
    return e;
  }
  async list(): Promise<EnrollmentSummary[]> {
    const res = await this.pool.query(
      'SELECT user_id, name, role, device_id, samples, enrolled_at, jsonb_array_length(embedding) AS len FROM enrollments ORDER BY enrolled_at DESC',
    );
    return res.rows.map(r => ({
      userId: String(r.user_id),
      name: String(r.name),
      role: r.role as Role,
      deviceId: String(r.device_id),
      samples: Number(r.samples),
      enrolledAt: Number(r.enrolled_at),
      embeddingLength: Number(r.len),
    }));
  }
  async get(userId: string): Promise<Enrollment | null> {
    const res = await this.pool.query('SELECT * FROM enrollments WHERE user_id=$1', [userId]);
    return res.rows[0] ? this.map(res.rows[0]) : null;
  }
  async remove(userId: string): Promise<boolean> {
    const res = await this.pool.query('DELETE FROM enrollments WHERE user_id=$1', [userId]);
    return (res.rowCount ?? 0) > 0;
  }
}

// ── Supabase ──
class SupabaseEnrollmentsStore implements EnrollmentsStore {
  kind = 'postgres' as const;
  private get db() {
    const c = getSupabase();
    if (!c) {
      throw new Error('Supabase not configured');
    }
    return c;
  }
  async init(): Promise<void> {
    const {error} = await this.db.from('enrollments').select('user_id').limit(1);
    if (error && !/permission|row-level/i.test(error.message)) {
      // eslint-disable-next-line no-console
      console.warn(`[enrollments] Supabase probe: ${error.message} — run docs/SUPABASE.md schema.`);
    }
  }
  private map(row: Record<string, unknown>): Enrollment {
    return {
      userId: String(row.user_id),
      name: String(row.name),
      role: row.role as Role,
      embedding: row.embedding as number[],
      deviceId: String(row.device_id),
      samples: Number(row.samples),
      enrolledAt: Number(row.enrolled_at),
    };
  }
  async upsert(e: Enrollment): Promise<Enrollment> {
    const {error} = await this.db.from('enrollments').upsert({
      user_id: e.userId,
      name: e.name,
      role: e.role,
      embedding: e.embedding,
      device_id: e.deviceId,
      samples: e.samples,
      enrolled_at: e.enrolledAt,
    });
    if (error) {
      throw new Error(error.message);
    }
    return e;
  }
  async list(): Promise<EnrollmentSummary[]> {
    const {data, error} = await this.db
      .from('enrollments')
      .select('user_id, name, role, device_id, samples, enrolled_at, embedding')
      .order('enrolled_at', {ascending: false});
    if (error) {
      throw new Error(error.message);
    }
    return (data ?? []).map(r => summarize(this.map(r)));
  }
  async get(userId: string): Promise<Enrollment | null> {
    const {data, error} = await this.db
      .from('enrollments')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) {
      throw new Error(error.message);
    }
    return data ? this.map(data) : null;
  }
  async remove(userId: string): Promise<boolean> {
    const {error} = await this.db.from('enrollments').delete().eq('user_id', userId);
    return !error;
  }
}

export function createEnrollmentsStore(): EnrollmentsStore {
  if (isSupabaseConfigured()) {
    return new SupabaseEnrollmentsStore();
  }
  const url = process.env.DATABASE_URL;
  return url ? new PostgresEnrollmentsStore(url) : new MemoryEnrollmentsStore();
}
