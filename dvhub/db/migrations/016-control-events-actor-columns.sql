-- Migration 016: control_events + exec.manual_overrides actor attribution.
--
-- Plan 08-09 Task 1 + Task 2: every control_events row needs actor_ip /
-- actor_ua / actor_session so a regulator can answer "who flipped X at
-- time T". Same columns are added to exec.manual_overrides so manual
-- /api/control/write entries persist with operator attribution.
--
-- DRIFT NOTE: original plan named this migration 009. Slot 009 was claimed
-- by phase 8.1 shared.* tables. This file uses slot 016 (next free after 015).
-- Version recorded in schema_migrations is 16.
--
-- exec.manual_overrides extension: phase 8.1 created this table with site_id
-- NOT NULL FK to shared.sites and column names target_key/value_num/created_at.
-- This migration:
--   1. Adds actor_ip / actor_ua / actor_session columns.
--   2. Drops the NOT NULL on site_id so /api/control/write can persist before
--      a per-site setup wizard exists. The FK stays — once shared.sites is
--      populated, future writes can supply a site_id.
--   3. Maps plan-named columns (target/ts_utc) to existing columns
--      (target_key/created_at) at the application layer (writeManualOverride
--      in telemetry-store-pg.js) — no schema rename needed.
BEGIN;

-- public.control_events actor columns
ALTER TABLE control_events ADD COLUMN IF NOT EXISTS actor_ip TEXT;
ALTER TABLE control_events ADD COLUMN IF NOT EXISTS actor_ua TEXT;
ALTER TABLE control_events ADD COLUMN IF NOT EXISTS actor_session TEXT;

CREATE INDEX IF NOT EXISTS idx_control_events_actor_ip_ts
  ON control_events (actor_ip, ts_utc DESC);

-- exec.manual_overrides actor columns + nullable site_id (only if schema exists)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'exec' AND table_name = 'manual_overrides'
  ) THEN
    EXECUTE 'ALTER TABLE exec.manual_overrides ADD COLUMN IF NOT EXISTS actor_ip TEXT';
    EXECUTE 'ALTER TABLE exec.manual_overrides ADD COLUMN IF NOT EXISTS actor_ua TEXT';
    EXECUTE 'ALTER TABLE exec.manual_overrides ADD COLUMN IF NOT EXISTS actor_session TEXT';
    EXECUTE 'ALTER TABLE exec.manual_overrides ALTER COLUMN site_id DROP NOT NULL';
    EXECUTE 'CREATE INDEX IF NOT EXISTS manual_overrides_actor_ip_created_idx '
         || 'ON exec.manual_overrides (actor_ip, created_at DESC)';
  END IF;
END
$$;

INSERT INTO schema_migrations (version, description, applied_at)
VALUES (16, 'control_events + exec.manual_overrides actor columns (Plan 08-09 Task 1)', NOW())
ON CONFLICT (version) DO NOTHING;

COMMIT;
