-- Migration 014 (OPTIONAL): TimescaleDB hypertable + (Community-only) compression
-- + continuous aggregates.
--
-- Source: docs/plans/2026-03-10-dvhub-postgres-schema-blueprint.md
-- CONTEXT decision: D-09 (default OFF; gated by cfg.telemetry.database.timescaledb
-- at the runner level, telemetry-store-pg.js runPendingMigrations).
--
-- EXECUTION MODEL (important): runPendingMigrations applies this file with a
-- single `pool.query(sql)` — i.e. the WHOLE file runs as ONE implicit
-- transaction. Any un-caught error rolls back EVERYTHING (not just the failing
-- statement). The older "statement-level atomicity is sufficient" note was wrong
-- and caused a real failure: see the edition split below.
--
-- EDITION SPLIT (2026-07-02): the extension ships in two builds.
--   * Debian's `postgresql-<ver>-timescaledb` is the APACHE build
--     (timescaledb.license = 'apache'). It supports hypertables but NOT
--     compression or continuous aggregates — those raise
--       ERROR 0A000: functionality not supported under the current "apache" license
--   * Timescale's own packages are the Community/TSL build ('timescale') and
--     support everything (this is what prod runs).
-- Because the whole file is one transaction, a 0A000 on the compression/CAgg
-- statements used to roll back the hypertable conversion too, so 014 NEVER
-- registered on an Apache box (every fresh Debian install) — timeseries_samples
-- stayed a plain table and schema_migrations never got version 14. This is fixed
-- below by doing the hypertable conversion at top level (Apache-supported) and
-- guarding the TSL-only optimizations behind a license check that skips them on
-- an Apache build. The app depends on NEITHER: it reads energy_slots_15m (a
-- PLAIN table it writes directly), never the *_cagg views, and does not rely on
-- compression — so skipping them on Apache is functionally free. prod already
-- has version 14 registered and never re-runs this file, so its Community-built
-- compression + CAggs are untouched.

-- 1. Enable the TimescaleDB extension (idempotent)
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- 1a. Drop the surrogate id primary key before converting to a hypertable (TS103).
-- ensurePgSchema() (telemetry-store-pg.js) creates timeseries_samples with
-- `id BIGSERIAL PRIMARY KEY` — a UNIQUE index that does NOT contain the
-- partitioning column ts_utc. TimescaleDB rejects that with
--   ERROR: cannot create a unique index without the column "ts_utc" (TS103)
-- so create_hypertable() below fails on any box that already holds the id PK
-- (every FRESH install; prod's older table pre-dates the id column and has no
-- such PK, which is why 014 has always succeeded there). The id column is a pure
-- surrogate: it is NEVER read, joined, RETURNed, or referenced (upserts use
-- ON CONFLICT on the natural UNIQUE(series_key,scope,source,quality,ts_utc,
-- resolution_seconds), which already includes ts_utc and is left untouched). So
-- we simply drop the PK; id stays a BIGSERIAL column (still auto-unique via its
-- sequence). Whatever the PK is named, drop it; no-op when absent (idempotent).
-- Plain-Postgres boxes never run this migration, so they keep the id PK.
DO $$
DECLARE pk_name text;
BEGIN
  SELECT conname INTO pk_name
  FROM pg_constraint
  WHERE conrelid = 'timeseries_samples'::regclass AND contype = 'p';
  IF pk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE timeseries_samples DROP CONSTRAINT %I', pk_name);
  END IF;
END $$;

-- 2. Convert public.timeseries_samples to a hypertable (Apache-supported).
-- migrate_data => TRUE moves any pre-existing rows into chunks (a RETROFIT box
-- may already hold data; on a fresh install the table is empty → no-op).
SELECT create_hypertable(
  'timeseries_samples',
  'ts_utc',
  chunk_time_interval => INTERVAL '7 days',
  migrate_data => TRUE,
  if_not_exists => TRUE
);

-- 3./5./6. TSL-only optimizations: compression + 15m/1h continuous aggregates.
-- Skipped on an Apache build (see EDITION SPLIT above); attempted best-effort on
-- Community, where even an unexpected failure in an OPTIONAL optimization must
-- not abort the core hypertable conversion already done above.
-- (4. Retention policy INTENTIONALLY OMITTED — T-0078: never auto-drop chunks.)
DO $mig$
DECLARE
  lic text := 'apache';
BEGIN
  BEGIN
    lic := current_setting('timescaledb.license');
  EXCEPTION WHEN OTHERS THEN
    lic := 'apache';  -- GUC absent → treat as Apache and skip the TSL parts
  END;

  IF lic = 'apache' THEN
    RAISE NOTICE '014-timescaledb: Apache build — hypertable only; skipping compression + continuous aggregates (not used by the app).';
    RETURN;
  END IF;

  BEGIN
    -- 3. Compression: compress chunks older than 7 days.
    ALTER TABLE timeseries_samples SET (
      timescaledb.compress,
      timescaledb.compress_segmentby = 'series_key,scope,source',
      timescaledb.compress_orderby = 'ts_utc desc'
    );
    PERFORM add_compression_policy('timeseries_samples', compress_after => INTERVAL '7 days', if_not_exists => TRUE);

    -- 5. 15-minute continuous aggregate.
    EXECUTE $cagg$
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
      WHERE quality != 'invalid' AND value_num IS NOT NULL AND scope IN ('live', 'history')
      GROUP BY time_bucket('15 minutes', ts_utc), series_key
      WITH NO DATA
    $cagg$;
    PERFORM add_continuous_aggregate_policy(
      'energy_slots_15m_cagg',
      start_offset => INTERVAL '1 hour',
      end_offset => INTERVAL '15 minutes',
      schedule_interval => INTERVAL '15 minutes',
      if_not_exists => TRUE);

    -- 6. 1-hour continuous aggregate.
    EXECUTE $cagg$
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
      WHERE quality != 'invalid' AND value_num IS NOT NULL AND scope IN ('live', 'history')
      GROUP BY time_bucket('1 hour', ts_utc), series_key
      WITH NO DATA
    $cagg$;
    PERFORM add_continuous_aggregate_policy(
      'energy_slots_1h_cagg',
      start_offset => INTERVAL '3 hours',
      end_offset => INTERVAL '1 hour',
      schedule_interval => INTERVAL '1 hour',
      if_not_exists => TRUE);
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '014-timescaledb: optional TSL optimizations skipped (%): %', SQLSTATE, SQLERRM;
  END;
END
$mig$;

-- 7. Register migration (last statement — only reached if all preceding ops in
-- this single-transaction file succeeded).
INSERT INTO schema_migrations (version, description, applied_at)
VALUES (14, 'TimescaleDB: hypertable on timeseries_samples (+ Community-only 7d compression + 15m/1h CAggs; no retention: T-0078)', NOW())
ON CONFLICT (version) DO NOTHING;
