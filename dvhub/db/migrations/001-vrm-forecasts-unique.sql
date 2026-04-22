-- Migration 001: Align vrm_forecasts UNIQUE constraint with ON CONFLICT target
-- Phase 8 CRITICAL #6 (REPOLENS database/schema-design/001)
--
-- Problem: CREATE TABLE declares UNIQUE(forecast_type, ts_utc) but every
--          INSERT in telemetry-store-pg.js uses
--          ON CONFLICT (forecast_type, ts_utc, forecast_for_date).
--          Postgres rejects this with
--          "no unique or exclusion constraint matching the ON CONFLICT
--           specification" — so every forecast upsert throws at runtime.
--
-- Fix:  Drop the old 2-column UNIQUE constraint (whatever its auto-generated
--       name is), de-duplicate rows that would violate the new 3-column
--       UNIQUE (keeping the most recent fetched_at per bucket), then add the
--       3-column UNIQUE constraint matching the insert.
--
-- Note: `forecast_for_date` is currently TEXT in production, not DATE. The
--       DELETE ... USING clause uses IS NOT DISTINCT FROM which handles NULL
--       and any comparable type correctly, so this migration is safe as-is.

BEGIN;

-- Drop whichever auto-named UNIQUE constraint currently covers only
-- (forecast_type, ts_utc). If the constraint was ever renamed we still
-- catch it via pg_constraint introspection.
DO $$
DECLARE
  cname TEXT;
BEGIN
  SELECT conname INTO cname
  FROM pg_constraint
  WHERE conrelid = 'vrm_forecasts'::regclass
    AND contype = 'u'
    AND pg_get_constraintdef(oid) LIKE '%(forecast_type, ts_utc)%'
    AND pg_get_constraintdef(oid) NOT LIKE '%forecast_for_date%';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE vrm_forecasts DROP CONSTRAINT %I', cname);
  END IF;
END $$;

-- De-duplicate existing rows that would violate the new 3-column UNIQUE.
-- Keeps the row with the most recent fetched_at per (forecast_type, ts_utc,
-- forecast_for_date) bucket.
DELETE FROM vrm_forecasts a
USING vrm_forecasts b
WHERE a.forecast_type = b.forecast_type
  AND a.ts_utc = b.ts_utc
  AND a.forecast_for_date IS NOT DISTINCT FROM b.forecast_for_date
  AND a.fetched_at < b.fetched_at;

-- Add the new 3-column UNIQUE matching the ON CONFLICT target.
-- Guard with a DO block so re-running the migration on a DB where the
-- constraint already exists (e.g. repeated dry-run) is a no-op.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'vrm_forecasts'::regclass
      AND contype = 'u'
      AND conname = 'vrm_forecasts_unique'
  ) THEN
    ALTER TABLE vrm_forecasts
      ADD CONSTRAINT vrm_forecasts_unique
      UNIQUE (forecast_type, ts_utc, forecast_for_date);
  END IF;
END $$;

-- Record the migration (schema_migrations is created in ensurePgSchema, so
-- it must already exist by the time the runner invokes this file).
INSERT INTO schema_migrations (version, description, applied_at)
VALUES (1, 'Align vrm_forecasts UNIQUE with 3-column ON CONFLICT target', NOW())
ON CONFLICT (version) DO NOTHING;

COMMIT;
