-- Migration 017 — Phase 9 plan 09-10: schema polish
--
-- Filename per CONTEXT.md D-14: numbers 010-016 are claimed by Phase 8.1.
-- This is the first free numeric slot after 016-control-events-actor-columns.sql.
--
-- Scope (per CONTEXT.md D-10..D-14):
--   D-10: Convert TIMESTAMP (without time zone) → TIMESTAMPTZ on the 7 actively-written
--         tables. All in ONE atomic BEGIN..COMMIT block. Application serializes UTC,
--         so AT TIME ZONE 'UTC' is loss-free.
--   D-11: Historic-index DROPs are COMMENTED OUT. Operator confirms idx_scan=0 over
--         a 7-day prod window, then uncomments manually.
--   D-12: VARCHAR tightening uses pre-check DO-blocks (fail-fast if any row exceeds
--         the new limit). Targets: event_type 255→64, control_events.target 255→32,
--         series_key 255→64.
--   D-13: Every statement guarded by a DO-block + information_schema.columns data_type
--         check — re-running this file on a fully-converted DB is a no-op.
--         Belt-and-suspenders on top of the schema_migrations tracker for Pi
--         partial-failure replay.
--
-- Tables / columns covered (9 columns × 7 tables per D-10):
--   public.control_events.ts_utc
--   public.pv_forecasts.ts_utc
--   public.live_snapshots.ts_utc       (legacy public.* — shared.live_snapshots is multi-schema)
--   public.optimizer_runs.run_started_at
--   public.optimizer_runs.run_finished_at
--   public.import_jobs.started_at
--   public.import_jobs.finished_at
--   public.tesla_snapshots.ts_utc
--   public.device_readings.ts_utc
--
-- Schema-existence guards (D-13): every DO-block first probes
-- information_schema.columns. If the column does not exist in the public schema
-- (e.g. live_snapshots only lives in the shared.* schema after Phase 8.1), the
-- DO-block exits silently. This makes the migration safe on every deploy variant
-- (fresh install, legacy Pi, multi-schema-migrated DB).

BEGIN;

-- ============================================================
-- D-10 + D-13: TIMESTAMPTZ conversions, idempotent per-column.
-- Each conversion is wrapped in a DO-block that checks
-- information_schema.columns.data_type — runs only if the column
-- is still 'timestamp without time zone'.
-- ============================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='control_events'
      AND column_name='ts_utc' AND data_type='timestamp without time zone'
  ) THEN
    ALTER TABLE public.control_events
      ALTER COLUMN ts_utc TYPE TIMESTAMPTZ USING ts_utc AT TIME ZONE 'UTC';
    RAISE NOTICE 'control_events.ts_utc → TIMESTAMPTZ';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='pv_forecasts'
      AND column_name='ts_utc' AND data_type='timestamp without time zone'
  ) THEN
    ALTER TABLE public.pv_forecasts
      ALTER COLUMN ts_utc TYPE TIMESTAMPTZ USING ts_utc AT TIME ZONE 'UTC';
    RAISE NOTICE 'pv_forecasts.ts_utc → TIMESTAMPTZ';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='live_snapshots'
      AND column_name='ts_utc' AND data_type='timestamp without time zone'
  ) THEN
    ALTER TABLE public.live_snapshots
      ALTER COLUMN ts_utc TYPE TIMESTAMPTZ USING ts_utc AT TIME ZONE 'UTC';
    RAISE NOTICE 'live_snapshots.ts_utc → TIMESTAMPTZ';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='optimizer_runs'
      AND column_name='run_started_at' AND data_type='timestamp without time zone'
  ) THEN
    ALTER TABLE public.optimizer_runs
      ALTER COLUMN run_started_at TYPE TIMESTAMPTZ USING run_started_at AT TIME ZONE 'UTC';
    RAISE NOTICE 'optimizer_runs.run_started_at → TIMESTAMPTZ';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='optimizer_runs'
      AND column_name='run_finished_at' AND data_type='timestamp without time zone'
  ) THEN
    ALTER TABLE public.optimizer_runs
      ALTER COLUMN run_finished_at TYPE TIMESTAMPTZ USING run_finished_at AT TIME ZONE 'UTC';
    RAISE NOTICE 'optimizer_runs.run_finished_at → TIMESTAMPTZ';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='import_jobs'
      AND column_name='started_at' AND data_type='timestamp without time zone'
  ) THEN
    ALTER TABLE public.import_jobs
      ALTER COLUMN started_at TYPE TIMESTAMPTZ USING started_at AT TIME ZONE 'UTC';
    RAISE NOTICE 'import_jobs.started_at → TIMESTAMPTZ';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='import_jobs'
      AND column_name='finished_at' AND data_type='timestamp without time zone'
  ) THEN
    ALTER TABLE public.import_jobs
      ALTER COLUMN finished_at TYPE TIMESTAMPTZ USING finished_at AT TIME ZONE 'UTC';
    RAISE NOTICE 'import_jobs.finished_at → TIMESTAMPTZ';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='tesla_snapshots'
      AND column_name='ts_utc' AND data_type='timestamp without time zone'
  ) THEN
    ALTER TABLE public.tesla_snapshots
      ALTER COLUMN ts_utc TYPE TIMESTAMPTZ USING ts_utc AT TIME ZONE 'UTC';
    RAISE NOTICE 'tesla_snapshots.ts_utc → TIMESTAMPTZ';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='device_readings'
      AND column_name='ts_utc' AND data_type='timestamp without time zone'
  ) THEN
    ALTER TABLE public.device_readings
      ALTER COLUMN ts_utc TYPE TIMESTAMPTZ USING ts_utc AT TIME ZONE 'UTC';
    RAISE NOTICE 'device_readings.ts_utc → TIMESTAMPTZ';
  END IF;
END $$;

-- ============================================================
-- D-12 + D-13: VARCHAR tightening with PRE-CHECK guards.
-- Each ALTER is preceded by a DO-block that RAISES EXCEPTION
-- if any existing row would exceed the new limit — fail-fast,
-- never silently truncate historic data.
-- Idempotency: ALTER fires only when character_maximum_length is
-- still > target (D-13).
-- ============================================================

-- control_events.event_type: 255 → 64
DO $$
DECLARE
  max_len INTEGER;
  current_limit INTEGER;
BEGIN
  SELECT character_maximum_length INTO current_limit
    FROM information_schema.columns
   WHERE table_schema='public' AND table_name='control_events' AND column_name='event_type';
  IF current_limit IS NOT NULL AND current_limit > 64 THEN
    SELECT COALESCE(MAX(LENGTH(event_type)), 0) INTO max_len
      FROM public.control_events WHERE event_type IS NOT NULL;
    IF max_len > 64 THEN
      RAISE EXCEPTION 'control_events.event_type max length is % which exceeds new limit 64. Aborting migration 017 — investigate the offending rows before retrying.', max_len;
    END IF;
    ALTER TABLE public.control_events ALTER COLUMN event_type TYPE VARCHAR(64);
    RAISE NOTICE 'control_events.event_type tightened to VARCHAR(64) (observed max=%)', max_len;
  END IF;
END $$;

-- control_events.target: 255 → 32
DO $$
DECLARE
  max_len INTEGER;
  current_limit INTEGER;
BEGIN
  SELECT character_maximum_length INTO current_limit
    FROM information_schema.columns
   WHERE table_schema='public' AND table_name='control_events' AND column_name='target';
  IF current_limit IS NOT NULL AND current_limit > 32 THEN
    SELECT COALESCE(MAX(LENGTH(target)), 0) INTO max_len
      FROM public.control_events WHERE target IS NOT NULL;
    IF max_len > 32 THEN
      RAISE EXCEPTION 'control_events.target max length is % which exceeds new limit 32. Aborting migration 017.', max_len;
    END IF;
    ALTER TABLE public.control_events ALTER COLUMN target TYPE VARCHAR(32);
    RAISE NOTICE 'control_events.target tightened to VARCHAR(32) (observed max=%)', max_len;
  END IF;
END $$;

-- series_key: 255 → 64 — probe to find which table holds it. In the current
-- public schema series_key is declared as TEXT (no length limit) on
-- timeseries_samples, optimizer_run_series, energy_slots_15m, optimizer_runs
-- input. character_maximum_length is therefore NULL for those columns, so the
-- DO-block exits cleanly without altering anything. If a legacy deploy has
-- VARCHAR(255) on series_key, the probe picks it up and tightens it.
DO $$
DECLARE
  max_len INTEGER;
  current_limit INTEGER;
  target_table TEXT;
  target_record RECORD;
BEGIN
  -- Iterate over every public.* column named series_key whose
  -- character_maximum_length still exceeds 64. character_maximum_length is
  -- NULL for TEXT columns, so the WHERE clause naturally skips them.
  FOR target_record IN
    SELECT table_name, character_maximum_length
      FROM information_schema.columns
     WHERE table_schema='public'
       AND column_name='series_key'
       AND character_maximum_length IS NOT NULL
       AND character_maximum_length > 64
     ORDER BY table_name
  LOOP
    target_table := target_record.table_name;
    EXECUTE format('SELECT COALESCE(MAX(LENGTH(series_key)), 0) FROM public.%I WHERE series_key IS NOT NULL', target_table) INTO max_len;
    IF max_len > 64 THEN
      RAISE EXCEPTION 'series_key on table % max length is % which exceeds new limit 64. Aborting migration 017.', target_table, max_len;
    END IF;
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN series_key TYPE VARCHAR(64)', target_table);
    RAISE NOTICE 'series_key on % tightened to VARCHAR(64) (observed max=%)', target_table, max_len;
  END LOOP;
END $$;

-- ============================================================
-- D-11: Historic-index DROP block — COMMENTED OUT.
-- ============================================================
-- BEFORE uncommenting any DROP below, the operator MUST run the following
-- query on PROD and confirm idx_scan = 0 PERSISTENTLY over a 7-day window
-- (sample on day 1 + day 4 + day 7 — values must stay 0 across all three samples):
--
--   SELECT schemaname, relname AS table_name, indexrelname, idx_scan
--   FROM pg_stat_user_indexes
--   WHERE idx_scan = 0 AND schemaname IN ('public', 'exec')
--   ORDER BY schemaname, indexrelname;
--
-- Candidate list (sourced from RepoLens 2026-04-17 snapshot
-- `.planning/REPOLENS-2026-04-17/database/database/index-strategy/`,
-- findings 005, 008, 009, 010, 011). Each candidate is paired with the
-- finding ID + one-line rationale so the operator can cross-reference.
-- Uncomment one line at a time after the 7-day idx_scan=0 confirmation.
--
-- Finding 005 — forecast_snapshots duplicate-prefix & low-cardinality:
-- DROP INDEX IF EXISTS public.idx_forecast_snapshots_target_date;        -- redundant PK-prefix (PK is (target_date, slot_utc, layer))
-- DROP INDEX IF EXISTS public.idx_forecast_snapshots_layer;              -- low-cardinality leading column (~5 distinct values)
-- DROP INDEX IF EXISTS public.idx_forecast_snapshots_forecast_date;      -- replace with composite (forecast_date, layer) per finding 005
--
-- Finding 008 — vrm_forecasts redundant ts-only index:
-- DROP INDEX IF EXISTS public.idx_vrm_forecasts_ts;                       -- ts_utc-only; queries all filter forecast_type+ts_utc (covered by UNIQUE)
--
-- Finding 009 — timeseries_samples scope-leading index:
-- DROP INDEX IF EXISTS public.idx_timeseries_scope_ts;                    -- ≤5 scope values; planner picks (series_key, ts_utc) instead
--
-- Finding 011 — tesla_snapshots write-only index:
-- DROP INDEX IF EXISTS public.idx_tesla_snapshots_car_ts;                 -- no read path; table is archival-only today
--
-- Finding 010 — exec.effective_plan_slots duplicate-prefix index:
-- DROP INDEX IF EXISTS exec.effective_plan_slots_plan_start_idx;          -- strict prefix of UNIQUE(effective_plan_id, slot_start, target_key)
--
-- Each DROP is on its own line so the operator can uncomment them one at a
-- time after confirming the 7-day observation per candidate. DO NOT batch
-- uncomment — each index gets its own 7-day window.

-- ============================================================
-- schema_migrations self-registration (D-13 belt-and-suspenders)
-- ============================================================
INSERT INTO schema_migrations (version, description, applied_at)
VALUES (17, 'Phase 9 plan 09-10 schema polish: TIMESTAMPTZ conversions (9 columns × 7 tables) + VARCHAR tightening (event_type/target/series_key) + historic-index drop runbook (D-10..D-14)', NOW())
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ============================================================
-- Post-migration verification (run manually after success):
-- ============================================================
--
-- 1. Verify TIMESTAMPTZ conversion (expect 0 rows):
--   SELECT table_name, column_name
--   FROM information_schema.columns
--   WHERE table_schema='public'
--     AND data_type='timestamp without time zone'
--     AND (table_name, column_name) IN (
--       ('control_events','ts_utc'),
--       ('pv_forecasts','ts_utc'),
--       ('live_snapshots','ts_utc'),
--       ('optimizer_runs','run_started_at'),
--       ('optimizer_runs','run_finished_at'),
--       ('import_jobs','started_at'),
--       ('import_jobs','finished_at'),
--       ('tesla_snapshots','ts_utc'),
--       ('device_readings','ts_utc')
--     );
--
-- 2. Verify VARCHAR tightening (expected: event_type=64, target=32; series_key=64 only if any public.* column actually had a VARCHAR limit):
--   SELECT table_name, column_name, character_maximum_length
--   FROM information_schema.columns
--   WHERE table_schema='public'
--     AND ((table_name='control_events' AND column_name='event_type')
--      OR  (table_name='control_events' AND column_name='target')
--      OR  (column_name='series_key' AND character_maximum_length IS NOT NULL));
--
-- 3. Operator runbook for historic-index drops (D-11):
--   - Day 1: snapshot pg_stat_user_indexes WHERE idx_scan=0 — record candidates
--   - Day 4: snapshot again — drop any candidate that left the list (it's now in use)
--   - Day 7: snapshot again — confirm remaining candidates are stable at idx_scan=0
--   - Uncomment the corresponding DROP line in this file, restart dvhub to
--     trigger runPendingMigrations (or run psql -f manually with the
--     understanding that schema_migrations will not record a re-run of
--     version 17).
