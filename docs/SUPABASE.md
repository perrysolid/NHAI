# Supabase setup (admin dashboard database)

The backend uses Supabase as its durable store when `SUPABASE_URL` +
`SUPABASE_SERVICE_KEY` are set — no raw Postgres connection string needed. The
**service_role key is server-side only** (Render env / gitignored `backend/.env`);
never put it in the web bundle. The browser uses only the **publishable** key.

Store selection order (backend): **Supabase** → Postgres (`DATABASE_URL`) →
in-memory.

## 1. Create the tables (once)

Supabase dashboard → **SQL Editor** → run:

```sql
-- Geofence zones assigned to inspectors (admin-provisioned).
create table if not exists public.sites (
  id               text primary key,
  name             text not null,
  assigned_user_id text not null,
  role             text not null,
  shape            jsonb not null,
  updated_at       bigint not null
);
create index if not exists sites_user_idx on public.sites (assigned_user_id);

-- Verified attendance / inspection records synced from devices.
create table if not exists public.attendance (
  user_id         text not null,
  ts              bigint not null,
  device_id       text not null,
  liveness_passed boolean not null,
  match_distance  real not null,
  confidence      real,
  score           real,
  latency_ms      integer,
  metrics         jsonb,
  location        jsonb,
  created_at      timestamptz default now(),
  primary key (user_id, ts, device_id)
);
```

RLS: leave Row-Level Security **enabled** on both tables. The backend uses the
service_role key, which bypasses RLS, so no client policies are needed while all
access goes through the Express API.

## 2. Set the env vars

`backend/.env` (local) and Render service env:

```
SUPABASE_URL=https://rmfpzkpltoeeajtoddek.supabase.co
SUPABASE_SERVICE_KEY=sb_secret_...      # service_role / secret key, server-side only
```

## 3. Verify

```bash
curl -H 'x-api-key: <API_KEY>' https://<render-url>/api/sites   # -> {"ok":true,"sites":[...]}
```
Then provision a zone in the admin dashboard and confirm the row appears in the
Supabase **Table editor → sites**.

> Security: the service_role key was shared during setup — rotate it in
> **Project Settings → API** after the hackathon if this channel isn't trusted.
