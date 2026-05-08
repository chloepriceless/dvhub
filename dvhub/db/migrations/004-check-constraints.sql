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
-- All constraints use `NOT VALID` would be cleaner for live data, but the
-- HEMS prod tables are small enough (< 10M rows) that a synchronous validate
-- scan during migration is acceptable. Rollback is documented in the
-- ROLLBACK PROCEDURE section of plan 08-08.
BEGIN;

-- pv_forecasts.confidence: probability scalar, must be in [0, 1].
-- A value outside this range means the producer is broken; reject at write time
-- so downstream merge logic can trust the field as a weight.
ALTER TABLE pv_forecasts
  ADD CONSTRAINT pv_forecasts_confidence_range
  CHECK (confidence IS NULL OR (confidence >= 0.0 AND confidence <= 1.0));

-- forecast_accuracy: error metrics are non-negative by definition.
-- mae / rmse / mape cannot be negative; sample_count cannot be negative.
ALTER TABLE forecast_accuracy
  ADD CONSTRAINT forecast_accuracy_mae_nonneg
  CHECK (mae IS NULL OR mae >= 0);
ALTER TABLE forecast_accuracy
  ADD CONSTRAINT forecast_accuracy_rmse_nonneg
  CHECK (rmse IS NULL OR rmse >= 0);
ALTER TABLE forecast_accuracy
  ADD CONSTRAINT forecast_accuracy_mape_nonneg
  CHECK (mape IS NULL OR mape >= 0);
ALTER TABLE forecast_accuracy
  ADD CONSTRAINT forecast_accuracy_sample_count_nonneg
  CHECK (sample_count IS NULL OR sample_count >= 0);

-- tesla_snapshots: SoC percentages bounded to [0, 100], state enums match
-- Tesla API canonical values. A SoC of 110% almost always indicates a
-- unit-mix-up (fraction vs percent) and downstream charge logic must not
-- silently accept it.
ALTER TABLE tesla_snapshots
  ADD CONSTRAINT tesla_snapshots_battery_level_range
  CHECK (battery_level IS NULL OR (battery_level >= 0 AND battery_level <= 100));
ALTER TABLE tesla_snapshots
  ADD CONSTRAINT tesla_snapshots_usable_battery_range
  CHECK (usable_battery_level IS NULL OR (usable_battery_level >= 0 AND usable_battery_level <= 100));
ALTER TABLE tesla_snapshots
  ADD CONSTRAINT tesla_snapshots_charge_limit_range
  CHECK (charge_limit_soc IS NULL OR (charge_limit_soc >= 0 AND charge_limit_soc <= 100));
ALTER TABLE tesla_snapshots
  ADD CONSTRAINT tesla_snapshots_state_enum
  CHECK (state IS NULL OR state IN ('asleep', 'online', 'offline', 'charging', 'driving'));
-- charging_state values from Tesla owner API: Disconnected, Charging, Complete,
-- Stopped, Starting, NoPower. Unknown values should fail loudly so we notice
-- API drift, not silently accept new strings.
ALTER TABLE tesla_snapshots
  ADD CONSTRAINT tesla_snapshots_charging_state_enum
  CHECK (charging_state IS NULL OR charging_state IN ('Disconnected', 'Charging', 'Complete', 'Stopped', 'Starting', 'NoPower'));

INSERT INTO schema_migrations (version, description, applied_at)
VALUES (4, 'CHECK constraints: pv_forecasts.confidence, forecast_accuracy non-neg metrics, tesla_snapshots SoC/state', NOW())
ON CONFLICT (version) DO NOTHING;

COMMIT;
