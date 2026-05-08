-- Migration 014 (OPTIONAL): TimescaleDB hypertable + policies + continuous aggregates.
--
-- Source: docs/plans/2026-03-10-dvhub-postgres-schema-blueprint.md
-- Worktree template: .claude/worktrees/agent-aa7bdf66/db/postgres/migrations/0007_timescaledb.sql
--   IMPORTANT: only lines 14, 37-47, 188-267 of the worktree are ported. Lines 19-184
--   contain public-schema CREATE TABLE statements (timeseries_samples, control_events,
--   optimizer_runs, etc.) that are ALREADY created by ensurePgSchema() in
--   dvhub/telemetry-store-pg.js:149-298. Including them here would be redundant or
--   conflicting.
-- CONTEXT decision: D-09 (default OFF; gated by cfg.database.timescaledb at the runner level).
--
-- Skip mechanism (Option A from PATTERNS.md): runPendingMigrations() in
-- dvhub/telemetry-store-pg.js skips this file unless cfg.database.timescaledb === true.
--
-- Scope of operations:
--   1. CREATE EXTENSION IF NOT EXISTS timescaledb
--   2. Convert public.timeseries_samples to a hypertable (chunk_time_interval = 7 days)
--   3. Compression policy (compress chunks older than 7 days)
--   4. Retention policy (drop chunks older than 45 days)
--   5. 15-minute continuous aggregate (energy_slots_15m_cagg) + policy
--   6. 1-hour continuous aggregate (energy_slots_1h_cagg) + policy
--
-- NOT wrapped in BEGIN/COMMIT — some timescaledb operations historically failed inside
-- an outer transaction. Statement-level atomicity is sufficient for this migration.
-- If the apply fails partway through, the runner will NOT register schema_migrations
-- (the INSERT below is the last statement); re-apply on next start is safe because
-- every Timescale operation uses if_not_exists => TRUE.

-- 1. Enable the TimescaleDB extension (idempotent)
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- 2. Convert public.timeseries_samples to a hypertable.
-- The table itself is owned by ensurePgSchema() (telemetry-store-pg.js:149-298) —
-- this migration only converts it; it does NOT (re)create it.
SELECT create_hypertable(
  'timeseries_samples',
  'ts_utc',
  chunk_time_interval => INTERVAL '7 days',
  if_not_exists => TRUE
);

-- 3. Compression policy: compress chunks older than 7 days.
ALTER TABLE timeseries_samples
  SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'series_key,scope,source',
    timescaledb.compress_orderby = 'ts_utc desc'
  );

SELECT add_compression_policy(
  'timeseries_samples',
  compress_after => INTERVAL '7 days',
  if_not_exists => TRUE
);

-- 4. Retention policy: drop chunks older than 45 days.
SELECT add_retention_policy(
  'timeseries_samples',
  drop_after => INTERVAL '45 days',
  if_not_exists => TRUE
);

-- 5. 15-minute continuous aggregate (energy_slots_15m_cagg).
CREATE MATERIALIZED VIEW IF NOT EXISTS energy_slots_15m_cagg
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('15 minutes', ts_utc) AS slot_start,
  series_key,
  avg(value_num) AS avg_value,
  min(value_num) AS min_value,
  max(value_num) AS max_value,
  count(*) AS sample_count
FROM timeseries_samples
WHERE quality != 'invalid'
  AND value_num IS NOT NULL
  AND scope IN ('live', 'history')
GROUP BY time_bucket('15 minutes', ts_utc), series_key
WITH NO DATA;

SELECT add_continuous_aggregate_policy(
  'energy_slots_15m_cagg',
  start_offset => INTERVAL '1 hour',
  end_offset => INTERVAL '15 minutes',
  schedule_interval => INTERVAL '15 minutes',
  if_not_exists => TRUE
);

-- 6. 1-hour continuous aggregate (energy_slots_1h_cagg).
CREATE MATERIALIZED VIEW IF NOT EXISTS energy_slots_1h_cagg
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 hour', ts_utc) AS slot_start,
  series_key,
  avg(value_num) AS avg_value,
  min(value_num) AS min_value,
  max(value_num) AS max_value,
  count(*) AS sample_count
FROM timeseries_samples
WHERE quality != 'invalid'
  AND value_num IS NOT NULL
  AND scope IN ('live', 'history')
GROUP BY time_bucket('1 hour', ts_utc), series_key
WITH NO DATA;

SELECT add_continuous_aggregate_policy(
  'energy_slots_1h_cagg',
  start_offset => INTERVAL '3 hours',
  end_offset => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour',
  if_not_exists => TRUE
);

-- 7. Register migration (last statement — only inserted if all preceding ops succeeded).
INSERT INTO schema_migrations (version, description, applied_at)
VALUES (14, 'TimescaleDB: hypertable on timeseries_samples + 7d compression + 45d retention + 15m/1h CAggs', NOW())
ON CONFLICT (version) DO NOTHING;
