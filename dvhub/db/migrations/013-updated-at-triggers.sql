-- Migration 013: updated_at triggers for multi-schema tables.
--
-- Source: docs/plans/2026-03-10-dvhub-postgres-schema-blueprint.md
-- Worktree template: .claude/worktrees/agent-aa7bdf66/db/postgres/migrations/0006_updated_at_triggers.sql
-- CONTEXT decisions: D-06, D-07 (file naming 013), D-16 (Plan 8.1-04 mandate).
--
-- Wires shared.set_updated_at() (created by Migration 008) to every table
-- with an updated_at column. Postgres lacks CREATE TRIGGER IF NOT EXISTS,
-- so each trigger is wrapped in a DO $$ ... pg_trigger guard for idempotency
-- (mirrors the pg_constraint guard pattern in dvhub/db/migrations/001-vrm-forecasts-unique.sql:53-65).
--
-- Coverage (8 tables, identical to worktree 0006):
--   shared.sites, shared.assets, shared.asset_bindings, shared.meter_devices, shared.tariff_sets,
--   dv.provider_connections, dv.rules, dv.operating_state.
--
-- Tables NOT included here have only created_at (no updated_at column) per worktree 0002/0003/0004/0005.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'set_shared_sites_updated_at'
      AND tgrelid = 'shared.sites'::regclass
  ) THEN
    CREATE TRIGGER set_shared_sites_updated_at
    BEFORE UPDATE ON shared.sites
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'set_shared_assets_updated_at'
      AND tgrelid = 'shared.assets'::regclass
  ) THEN
    CREATE TRIGGER set_shared_assets_updated_at
    BEFORE UPDATE ON shared.assets
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'set_shared_asset_bindings_updated_at'
      AND tgrelid = 'shared.asset_bindings'::regclass
  ) THEN
    CREATE TRIGGER set_shared_asset_bindings_updated_at
    BEFORE UPDATE ON shared.asset_bindings
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'set_shared_meter_devices_updated_at'
      AND tgrelid = 'shared.meter_devices'::regclass
  ) THEN
    CREATE TRIGGER set_shared_meter_devices_updated_at
    BEFORE UPDATE ON shared.meter_devices
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'set_shared_tariff_sets_updated_at'
      AND tgrelid = 'shared.tariff_sets'::regclass
  ) THEN
    CREATE TRIGGER set_shared_tariff_sets_updated_at
    BEFORE UPDATE ON shared.tariff_sets
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'set_dv_provider_connections_updated_at'
      AND tgrelid = 'dv.provider_connections'::regclass
  ) THEN
    CREATE TRIGGER set_dv_provider_connections_updated_at
    BEFORE UPDATE ON dv.provider_connections
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'set_dv_rules_updated_at'
      AND tgrelid = 'dv.rules'::regclass
  ) THEN
    CREATE TRIGGER set_dv_rules_updated_at
    BEFORE UPDATE ON dv.rules
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'set_dv_operating_state_updated_at'
      AND tgrelid = 'dv.operating_state'::regclass
  ) THEN
    CREATE TRIGGER set_dv_operating_state_updated_at
    BEFORE UPDATE ON dv.operating_state
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();
  END IF;
END $$;

INSERT INTO schema_migrations (version, description, applied_at)
VALUES (13, 'updated_at triggers on shared/dv tables (idempotent via pg_trigger guards)', NOW())
ON CONFLICT (version) DO NOTHING;

COMMIT;
