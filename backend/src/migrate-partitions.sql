-- Migration: Shard the attendance table by hash of user_id (8 partitions).
-- Run once via Supabase SQL Editor or psql.
-- WARNING: requires a new table + backfill; schedule during low traffic.

BEGIN;

-- 1. Rename the existing table so we can backfill.
ALTER TABLE attendance RENAME TO attendance_old;

-- 2. Create the partitioned table with the same columns.
CREATE TABLE attendance (
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
  created_at     TIMESTAMPTZ DEFAULT now()
) PARTITION BY HASH (user_id);

-- 3. Create 8 partitions (modulus 8). Adjust the count based on expected
--    scale — 8 is a safe starting point for a hackathon. Each partition
--    gets its own physical storage so queries against one user_id hit only
--    one shard.
CREATE TABLE attendance_p0 PARTITION OF attendance
  FOR VALUES WITH (MODULUS 8, REMAINDER 0);
CREATE TABLE attendance_p1 PARTITION OF attendance
  FOR VALUES WITH (MODULUS 8, REMAINDER 1);
CREATE TABLE attendance_p2 PARTITION OF attendance
  FOR VALUES WITH (MODULUS 8, REMAINDER 2);
CREATE TABLE attendance_p3 PARTITION OF attendance
  FOR VALUES WITH (MODULUS 8, REMAINDER 3);
CREATE TABLE attendance_p4 PARTITION OF attendance
  FOR VALUES WITH (MODULUS 8, REMAINDER 4);
CREATE TABLE attendance_p5 PARTITION OF attendance
  FOR VALUES WITH (MODULUS 8, REMAINDER 5);
CREATE TABLE attendance_p6 PARTITION OF attendance
  FOR VALUES WITH (MODULUS 8, REMAINDER 6);
CREATE TABLE attendance_p7 PARTITION OF attendance
  FOR VALUES WITH (MODULUS 8, REMAINDER 7);

-- 4. Add the primary key constraint on each partition (Postgres requires
--    the PK on each partition individually, not on the parent).
ALTER TABLE attendance_p0 ADD PRIMARY KEY (user_id, ts, device_id);
ALTER TABLE attendance_p1 ADD PRIMARY KEY (user_id, ts, device_id);
ALTER TABLE attendance_p2 ADD PRIMARY KEY (user_id, ts, device_id);
ALTER TABLE attendance_p3 ADD PRIMARY KEY (user_id, ts, device_id);
ALTER TABLE attendance_p4 ADD PRIMARY KEY (user_id, ts, device_id);
ALTER TABLE attendance_p5 ADD PRIMARY KEY (user_id, ts, device_id);
ALTER TABLE attendance_p6 ADD PRIMARY KEY (user_id, ts, device_id);
ALTER TABLE attendance_p7 ADD PRIMARY KEY (user_id, ts, device_id);

-- 5. Backfill existing data (runs as a single transaction; for very large
--    tables, use pg_batch or a scheduled job instead).
INSERT INTO attendance
  SELECT * FROM attendance_old;

-- 6. Drop the old table after verifying row counts match.
-- DROP TABLE attendance_old;

COMMIT;
