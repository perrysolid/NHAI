/**
 * sites — geofence provisioning store.
 *
 * An admin draws a circular zone on the satellite map, assigns it to an
 * inspector (userId) with a Datalake role, and saves it here. A device pulls its
 * assigned site(s) when online (GET /api/sites/for/:userId) and caches them
 * locally so the on-device geofence check then runs fully offline.
 *
 * Persistence mirrors the attendance store: Postgres when DATABASE_URL is set,
 * otherwise in-memory for an instant demo.
 */
import {Pool} from 'pg';
import {getSupabase, isSupabaseConfigured} from './supabase.js';

/** Datalake 3.0 field roles (AE/IE, contractor, PIU team, regional officer). */
export const ROLES = [
  'authority-engineer',
  'contractor',
  'piu',
  'regional-officer',
  'consultant',
] as const;
export type Role = (typeof ROLES)[number];

export interface CircleShape {
  kind: 'circle';
  center: {lat: number; lon: number};
  radiusM: number;
}

export interface Site {
  id: string;
  name: string;
  /** Inspector this zone is assigned to (device pulls by this). */
  assignedUserId: string;
  /** Datalake role of the assignee. */
  role: Role;
  shape: CircleShape;
  updatedAt: number;
}

export interface SitesStore {
  init(): Promise<void>;
  upsert(site: Site): Promise<Site>;
  list(): Promise<Site[]>;
  forUser(userId: string): Promise<Site[]>;
  remove(id: string): Promise<boolean>;
  kind: 'postgres' | 'memory';
}

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function isRole(v: unknown): v is Role {
  return typeof v === 'string' && (ROLES as readonly string[]).includes(v);
}

/** Validate + normalize an untrusted site payload; null if unusable. */
export function sanitizeSite(raw: unknown): Site | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const o = raw as Record<string, unknown>;
  const shape = o.shape as Record<string, unknown> | undefined;
  const center = shape?.center as Record<string, unknown> | undefined;
  if (!shape || shape.kind !== 'circle' || !center) {
    return null;
  }
  const lat = Number(center.lat);
  const lon = Number(center.lon);
  const radiusM = Number(shape.radiusM);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !(radiusM > 0)) {
    return null;
  }
  const assignedUserId =
    typeof o.assignedUserId === 'string' ? o.assignedUserId.trim().slice(0, 128) : '';
  if (!assignedUserId) {
    return null;
  }
  const id =
    typeof o.id === 'string' && o.id.trim()
      ? o.id.trim().slice(0, 128)
      : `site_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  return {
    id,
    name:
      typeof o.name === 'string' && o.name.trim()
        ? o.name.trim().slice(0, 200)
        : 'Unnamed site',
    assignedUserId,
    role: isRole(o.role) ? o.role : 'authority-engineer',
    shape: {kind: 'circle', center: {lat, lon}, radiusM: num(radiusM)},
    updatedAt: Date.now(),
  };
}

// ── In-memory ──
class MemorySitesStore implements SitesStore {
  kind = 'memory' as const;
  private byId = new Map<string, Site>();
  async init(): Promise<void> {}
  async upsert(site: Site): Promise<Site> {
    this.byId.set(site.id, site);
    return site;
  }
  async list(): Promise<Site[]> {
    return [...this.byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async forUser(userId: string): Promise<Site[]> {
    return (await this.list()).filter(s => s.assignedUserId === userId);
  }
  async remove(id: string): Promise<boolean> {
    return this.byId.delete(id);
  }
}

// ── Postgres ──
class PostgresSitesStore implements SitesStore {
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
      CREATE TABLE IF NOT EXISTS sites (
        id               TEXT PRIMARY KEY,
        name             TEXT NOT NULL,
        assigned_user_id TEXT NOT NULL,
        role             TEXT NOT NULL,
        shape            JSONB NOT NULL,
        updated_at       BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sites_user_idx ON sites (assigned_user_id);
    `);
  }
  async upsert(site: Site): Promise<Site> {
    await this.pool.query(
      `INSERT INTO sites (id, name, assigned_user_id, role, shape, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO UPDATE SET
         name=$2, assigned_user_id=$3, role=$4, shape=$5, updated_at=$6`,
      [site.id, site.name, site.assignedUserId, site.role, JSON.stringify(site.shape), site.updatedAt],
    );
    return site;
  }
  private mapRow(row: Record<string, unknown>): Site {
    return {
      id: String(row.id),
      name: String(row.name),
      assignedUserId: String(row.assigned_user_id),
      role: row.role as Role,
      shape:
        typeof row.shape === 'string'
          ? (JSON.parse(row.shape) as CircleShape)
          : (row.shape as CircleShape),
      updatedAt: Number(row.updated_at),
    };
  }
  async list(): Promise<Site[]> {
    const res = await this.pool.query('SELECT * FROM sites ORDER BY updated_at DESC');
    return res.rows.map(r => this.mapRow(r));
  }
  async forUser(userId: string): Promise<Site[]> {
    const res = await this.pool.query(
      'SELECT * FROM sites WHERE assigned_user_id=$1 ORDER BY updated_at DESC',
      [userId],
    );
    return res.rows.map(r => this.mapRow(r));
  }
  async remove(id: string): Promise<boolean> {
    const res = await this.pool.query('DELETE FROM sites WHERE id=$1', [id]);
    return (res.rowCount ?? 0) > 0;
  }
}

// ── Supabase (service_role via supabase-js; no raw DB connection needed) ──
// Table `sites`: id text pk, name text, assigned_user_id text, role text,
// shape jsonb, updated_at bigint. Create it once via the Supabase SQL editor
// (see docs/SUPABASE.md).
class SupabaseSitesStore implements SitesStore {
  kind = 'postgres' as const; // durable, Supabase-hosted Postgres
  private get db() {
    const c = getSupabase();
    if (!c) {
      throw new Error('Supabase not configured');
    }
    return c;
  }
  async init(): Promise<void> {
    // Schema is provisioned once via the SQL editor; a light probe surfaces a
    // missing table early instead of on first write.
    const {error} = await this.db.from('sites').select('id').limit(1);
    if (error && !/permission|row-level/i.test(error.message)) {
      // eslint-disable-next-line no-console
      console.warn(`[sites] Supabase probe: ${error.message} — run docs/SUPABASE.md schema.`);
    }
  }
  private toRow(s: Site) {
    return {
      id: s.id,
      name: s.name,
      assigned_user_id: s.assignedUserId,
      role: s.role,
      shape: s.shape,
      updated_at: s.updatedAt,
    };
  }
  private fromRow(r: Record<string, unknown>): Site {
    return {
      id: String(r.id),
      name: String(r.name),
      assignedUserId: String(r.assigned_user_id),
      role: r.role as Role,
      shape: r.shape as CircleShape,
      updatedAt: Number(r.updated_at),
    };
  }
  async upsert(site: Site): Promise<Site> {
    const {error} = await this.db.from('sites').upsert(this.toRow(site));
    if (error) {
      throw new Error(error.message);
    }
    return site;
  }
  async list(): Promise<Site[]> {
    const {data, error} = await this.db
      .from('sites')
      .select('*')
      .order('updated_at', {ascending: false});
    if (error) {
      throw new Error(error.message);
    }
    return (data ?? []).map(r => this.fromRow(r));
  }
  async forUser(userId: string): Promise<Site[]> {
    const {data, error} = await this.db
      .from('sites')
      .select('*')
      .eq('assigned_user_id', userId)
      .order('updated_at', {ascending: false});
    if (error) {
      throw new Error(error.message);
    }
    return (data ?? []).map(r => this.fromRow(r));
  }
  async remove(id: string): Promise<boolean> {
    const {error} = await this.db.from('sites').delete().eq('id', id);
    return !error;
  }
}

export function createSitesStore(): SitesStore {
  if (isSupabaseConfigured()) {
    return new SupabaseSitesStore();
  }
  const url = process.env.DATABASE_URL;
  return url ? new PostgresSitesStore(url) : new MemorySitesStore();
}
