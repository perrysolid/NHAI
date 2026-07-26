# Sharding · Proxy · Tamper Integrity

Three layers that strengthen the system without changing any mobile-app code.

## 1. Database sharding (Postgres hash partitioning)

The `attendance` table grows with every verified record. Sharding by `user_id` hash
distributes writes/reads across 8 physical partitions — each inspector's data lives
on exactly one shard, so queries naturally hit only the relevant partition.

### Apply

```bash
# Via Supabase SQL Editor or psql
psql "$DATABASE_URL" -f backend/src/migrate-partitions.sql
```

This re-creates the table with `PARTITION BY HASH (user_id)` and 8 sub-tables
(`attendance_p0` … `attendance_p7`). Existing data is backfilled in a single
transaction. The application sees zero difference — all SQL is unchanged because
Postgres routing is transparent.

### Partition count

8 partitions is a safe start for the hackathon scale. To add more later:
```sql
CREATE TABLE attendance_p8 PARTITION OF attendance
  FOR VALUES WITH (MODULUS 16, REMAINDER 8);
-- … repeat for 9..15, then repartition old data.
```

## 2. Proxy server (Cloudflare Worker)

A lightweight edge proxy that sits between the app and the Render backend.

### Deploy

```bash
npx wrangler deploy backend/src/proxy-worker.js
wrangler secret put BACKEND_ORIGIN
wrangler secret put API_KEY
```

### What it does

| Feature | Detail |
|---------|--------|
| API key check at edge | Validates `x-api-key` before the request reaches Render, rejecting bad keys with 401 instantly |
| Rate limit POST /api/sync | 30 requests/minute per deviceId (burst protection) |
| Cache GET /api/sites/for/:userId | Edge-cached for 300s (configurable), reducing backend load |
| Pass-through | Everything else (enroll, admin login, etc.) forwarded as-is with same headers |

The proxy is stateless (in-memory rate counters per worker instance) — sufficient
for burst protection. For production, swap to Durable Objects or KV.

## 3. Server-side tamper integrity (zero app changes)

Every `POST /api/sync` now passes through `store.guard()` before the dedupe-aware
`store.add()`. The guard rejects records that fail:

| Check | What it catches |
|-------|----------------|
| **Score sanity** | `matchDistance` outside [0,1], `confidence` outside [0,1], `score` outside [0,100], negative `latencyMs` |
| **Monotonic timestamp** | Replay attacks: if a newer record already exists for the same `(userId, deviceId)` with a higher timestamp, the older record is rejected |
| **Rate limit** | Burst injection: max 30 records/minute per deviceId |
| **Cross-device collision** | If `userId=A` was active on `deviceId=X` and suddenly a record claims `userId=A` on `deviceId=Y` with an older timestamp, the record is rejected — catches timeline-injection tampering |

All checks run on every store backend (MemoryStore, PostgresStore, SupabaseStore).
Rejected records count is returned in the sync response as `rejected`.

### Response format (updated)

```json
{
  "ok": true,
  "accepted": 3,
  "received": 4,
  "rejected": 1,
  "acceptedRecords": [ … ]
}
```

The app ignores the new `rejected` field (backward-compatible), so no mobile
update is needed.
