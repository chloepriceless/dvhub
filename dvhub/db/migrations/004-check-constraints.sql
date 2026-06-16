-- Migration 004: CHECK constraints on semantically-bounded columns.
--
-- REPOLENS database/data-integrity flagged several columns that allow values
-- which are physically/semantically impossible. The constraints below close
-- those gaps for tables that exist in the current public-schema.
--
-- Multi-schema CHECK constraints (live_snapshots.soc_pct, tariff_sets +
-- dv.rules valid_to>valid_from, asset_constraints SoC bounds, etc.) are
-- deferred to Phase 8.1 (Multi-Schema Genesis) — those tables/schemas do
-- not yet exist in this codebase.
--
-- ORDERING + IDEMPOTENCY (2026-06-16, T-0224 fresh-install finding):
-- pv_forecasts and forecast_accuracy are created LAZILY by
-- services/forecast/forecast-store.js (CREATE TABLE IF NOT EXISTS) — which
-- already carries these exact constraints INLINE since Plan 08-08. On a FRESH
-- install the migration runner reaches 004 BEFORE the forecast service creates
-- those tables, so the old raw `ALTER TABLE pv_forecasts …` threw
-- 42P01 (relation does not exist) and aborted the whole 004 transaction →
-- v4 was a permanent no-show in schema_migrations on every fresh box, AND the
-- tesla_snapshots block below never ran (004 died at the first ALTER). Phase 23's
-- per-migration try/catch caught the crash, but the migration was effectively dead.
-- Fix: EVERY ALTER is now guarded by an information_schema table-existence +
-- a pg_constraint constraint-existence check (DO-block), exactly like the
-- tesla_snapshots block and migration 018's pg_extension guard. 004 is now
-- order-independent and idempotent — a no-op when a table is absent or already
-- constrained, a safe retrofit otherwise. The constraints' AUTHORITATIVE source
-- is forecast-store.js (fresh installs get them at table creation); 004 only
-- retrofits pre-existing tables (e.g. prod) and now always registers v4.
BEGIN;

-- pv_forecasts.confidence: probability scalar, must be in [0, 1].
-- A value outside this range means the producer is broken; reject at write time
-- so downstream merge logic can trust the field as a weight.
DO $$
BEGIN
  IF EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_name = 'pv_forecasts'
     )
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pv_forecasts_confidence_range') THEN
    EXECUTE 'ALTER TABLE pv_forecasts '
         || 'ADD CONSTRAINT pv_forecasts_confidence_range '
         || 'CHECK (confidence IS NULL OR (confidence >= 0.0 AND confidence <= 1.0))';
  END IF;
END
$$;

-- forecast_accuracy: error metrics are non-negative by definition.
-- mae / rmse / mape cannot be negative; sample_count cannot be negative.
DO $$
BEGIN
  IF EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_name = 'forecast_accuracy'
     ) THEN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'forecast_accuracy_mae_nonneg') THEN
      EXECUTE 'ALTER TABLE forecast_accuracy ADD CONSTRAINT forecast_accuracy_mae_nonneg CHECK (mae IS NULL OR mae >= 0)';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'forecast_accuracy_rmse_nonneg') THEN
      EXECUTE 'ALTER TABLE forecast_accuracy ADD CONSTRAINT forecast_accuracy_rmse_nonneg CHECK (rmse IS NULL OR rmse >= 0)';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'forecast_accuracy_mape_nonneg') THEN
      EXECUTE 'ALTER TABLE forecast_accuracy ADD CONSTRAINT forecast_accuracy_mape_nonneg CHECK (mape IS NULL OR mape >= 0)';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'forecast_accuracy_sample_count_nonneg') THEN
      EXECUTE 'ALTER TABLE forecast_accuracy ADD CONSTRAINT forecast_accuracy_sample_count_nonneg CHECK (sample_count IS NULL OR sample_count >= 0)';
    END IF;
  END IF;
END
$$;

-- tesla_snapshots: SoC percentages bounded to [0, 100], state enums match
-- Tesla API canonical values. A SoC of 110% almost always indicates a
-- unit-mix-up (fraction vs percent) and downstream charge logic must not
-- silently accept it. No-op on deployments where tesla_snapshots was never
-- created (e.g. prod installations without Tesla integration).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'tesla_snapshots'
  ) THEN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tesla_snapshots_battery_level_range') THEN
      EXECUTE 'ALTER TABLE tesla_snapshots '
           || 'ADD CONSTRAINT tesla_snapshots_battery_level_range '
           || 'CHECK (battery_level IS NULL OR (battery_level >= 0 AND battery_level <= 100))';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tesla_snapshots_usable_battery_range') THEN
      EXECUTE 'ALTER TABLE tesla_snapshots '
           || 'ADD CONSTRAINT tesla_snapshots_usable_battery_range '
           || 'CHECK (usable_battery_level IS NULL OR (usable_battery_level >= 0 AND usable_battery_level <= 100))';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tesla_snapshots_charge_limit_range') THEN
      EXECUTE 'ALTER TABLE tesla_snapshots '
           || 'ADD CONSTRAINT tesla_snapshots_charge_limit_range '
           || 'CHECK (charge_limit_soc IS NULL OR (charge_limit_soc >= 0 AND charge_limit_soc <= 100))';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tesla_snapshots_state_enum') THEN
      EXECUTE 'ALTER TABLE tesla_snapshots '
           || 'ADD CONSTRAINT tesla_snapshots_state_enum '
           || 'CHECK (state IS NULL OR state IN (''asleep'', ''online'', ''offline'', ''charging'', ''driving''))';
    END IF;
    -- charging_state values from Tesla owner API: Disconnected, Charging, Complete,
    -- Stopped, Starting, NoPower. Unknown values should fail loudly so we notice
    -- API drift, not silently accept new strings.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tesla_snapshots_charging_state_enum') THEN
      EXECUTE 'ALTER TABLE tesla_snapshots '
           || 'ADD CONSTRAINT tesla_snapshots_charging_state_enum '
           || 'CHECK (charging_state IS NULL OR charging_state IN (''Disconnected'', ''Charging'', ''Complete'', ''Stopped'', ''Starting'', ''NoPower''))';
    END IF;
  END IF;
END
$$;

INSERT INTO schema_migrations (version, description, applied_at)
VALUES (4, 'CHECK constraints: pv_forecasts.confidence, forecast_accuracy non-neg metrics, tesla_snapshots SoC/state', NOW())
ON CONFLICT (version) DO NOTHING;

COMMIT;
