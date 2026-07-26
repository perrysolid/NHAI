/**
 * supabase — server-side Supabase client (service_role key).
 *
 * SERVER ONLY. The service key bypasses Row-Level Security, so it must never be
 * exposed to the browser. Used to persist geofence sites (and, later, enrolment)
 * without a raw Postgres connection string. Returns null when unconfigured so
 * the stores fall back to Postgres (DATABASE_URL) or in-memory.
 */
import {createClient, type SupabaseClient} from '@supabase/supabase-js';

let cached: SupabaseClient | null = null;

export function isSupabaseConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);
}

export function getSupabase(): SupabaseClient | null {
  if (!isSupabaseConfigured()) {
    return null;
  }
  if (!cached) {
    cached = createClient(
      process.env.SUPABASE_URL as string,
      process.env.SUPABASE_SERVICE_KEY as string,
      {auth: {persistSession: false, autoRefreshToken: false}},
    );
  }
  return cached;
}
