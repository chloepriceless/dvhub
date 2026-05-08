-- Migration 009: shared.* tables (Multi-Vendor foundation).
--
-- Source: docs/plans/2026-03-10-dvhub-postgres-schema-blueprint.md
-- Worktree template: .claude/worktrees/agent-aa7bdf66/db/postgres/migrations/0002_shared.sql
-- CONTEXT decisions: D-06 (table list), D-10 (schema-prefix hardcoded), D-11 (JSONB only in new multi-schema tables), D-16 (inline constraints).
--
-- This is the LARGEST migration in Phase 8.1 — it creates the multi-vendor data
-- foundation. All shared.* tables are created EMPTY (no data migration per D-01:
-- additive, lazy migration; cutover deferred to Phase 10/11/separate phase).
--
-- Closes REPOLENS findings (deferred from Plan 08-08):
--   - data-integrity/002:        shared.live_snapshots.soc_pct CHECK [0, 100]
--   - data-integrity/003-014:    shared.tariff_sets.valid_to > valid_from CHECK
--   - data-integrity/015:        shared.meter_devices partial UNIQUE on is_primary_grid_meter
--   - index-strategy/004:        FK indexes on shared.* tables (every FK has supporting index)
--   - schema-design/004:         meta_json/metadata_json/config_json columns are JSONB (not TEXT)
--   - schema-design/011:         shared.live_snapshots.grid_import_w / grid_export_w nullable (no DEFAULT 0)
--
-- Strategic intent (Multi-Vendor): shared.assets[asset_type, manufacturer, model] +
-- shared.asset_bindings[provider_code, external_ref, config_json] is the plugin
-- interface that Phase 10 (Driver Abstraction) and Phase 11 (Vendor-Packs) build on.
-- Without this migration, Phases 10 + 11 have no data model to write into.
--
-- Idempotency: every CREATE TABLE / CREATE INDEX uses IF NOT EXISTS. Re-applying
-- this migration is a no-op. The runner skips already-applied versions, but
-- IF NOT EXISTS is the safety net for partial-failure recovery and dev rebuilds.
--
-- Naming reconciliation: CONTEXT D-06 mentions `shared.live_telemetry`; the worktree
-- (and the master-plan blueprint) call this `shared.telemetry_samples_raw`. We use
-- the worktree/master-plan name. PATTERNS.md note at line 297 explicitly directs us
-- to reconcile naming with the master-plan blueprint.
BEGIN;

-- =============================================================================
-- shared.sites — site master record
-- =============================================================================
CREATE TABLE IF NOT EXISTS shared.sites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'EUR',
  operating_mode TEXT NOT NULL DEFAULT 'combined'
    CHECK (operating_mode IN ('dv_only', 'optimization_only', 'combined')),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- shared.assets — Multi-Vendor anchor (asset_type × manufacturer × model)
-- =============================================================================
CREATE TABLE IF NOT EXISTS shared.assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES shared.sites(id) ON DELETE CASCADE,
  asset_type TEXT NOT NULL
    CHECK (asset_type IN ('battery', 'inverter', 'pv_array', 'meter', 'evse', 'vehicle', 'gateway', 'controller')),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  manufacturer TEXT,
  model TEXT,
  serial_no TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (site_id, code)
);

CREATE INDEX IF NOT EXISTS assets_site_type_idx ON shared.assets(site_id, asset_type);

-- =============================================================================
-- shared.asset_bindings — Driver plugin link (provider_code = 'victron'/'sma'/...)
-- =============================================================================
CREATE TABLE IF NOT EXISTS shared.asset_bindings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id UUID NOT NULL REFERENCES shared.assets(id) ON DELETE CASCADE,
  binding_type TEXT NOT NULL
    CHECK (binding_type IN ('driver', 'external_system', 'mqtt_topic', 'modbus_map', 'rest_resource')),
  provider_code TEXT NOT NULL,
  external_ref TEXT NOT NULL,
  binding_status TEXT NOT NULL DEFAULT 'active'
    CHECK (binding_status IN ('active', 'disabled', 'error')),
  config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (asset_id, binding_type, provider_code, external_ref)
);

-- FK index on asset_id: leading column of UNIQUE (asset_id, binding_type, provider_code, external_ref)
-- — Postgres auto-creates a btree index on UNIQUE columns; no explicit index needed.

-- =============================================================================
-- shared.asset_constraints — per-asset hard limits (SoC bounds, max charge/discharge, ...)
-- =============================================================================
CREATE TABLE IF NOT EXISTS shared.asset_constraints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id UUID NOT NULL REFERENCES shared.assets(id) ON DELETE CASCADE,
  valid_from TIMESTAMPTZ NOT NULL,
  valid_to TIMESTAMPTZ,
  min_soc_pct NUMERIC(6,3),
  max_soc_pct NUMERIC(6,3),
  max_charge_w BIGINT,
  max_discharge_w BIGINT,
  max_import_w BIGINT,
  max_export_w BIGINT,
  usable_capacity_wh BIGINT,
  charge_efficiency NUMERIC(6,5),
  discharge_efficiency NUMERIC(6,5),
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (min_soc_pct IS NULL OR (min_soc_pct >= 0 AND min_soc_pct <= 100)),
  CHECK (max_soc_pct IS NULL OR (max_soc_pct >= 0 AND max_soc_pct <= 100)),
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);

CREATE INDEX IF NOT EXISTS asset_constraints_asset_from_idx ON shared.asset_constraints(asset_id, valid_from DESC);

-- =============================================================================
-- shared.meter_devices — grid/PV/battery meter declarations
-- =============================================================================
CREATE TABLE IF NOT EXISTS shared.meter_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES shared.sites(id) ON DELETE CASCADE,
  asset_id UUID REFERENCES shared.assets(id) ON DELETE SET NULL,
  meter_role TEXT NOT NULL
    CHECK (meter_role IN ('grid_interconnection', 'pv', 'battery', 'load', 'submeter')),
  source_type TEXT NOT NULL
    CHECK (source_type IN ('modbus', 'mqtt', 'rest', 'driver', 'derived')),
  driver_key TEXT NOT NULL,
  is_primary_grid_meter BOOLEAN NOT NULL DEFAULT FALSE,
  poll_interval_ms INTEGER NOT NULL DEFAULT 1000,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- FK index on site_id (leading column) + meter_role for "primary grid meter for site" lookups.
CREATE INDEX IF NOT EXISTS meter_devices_site_role_idx ON shared.meter_devices(site_id, meter_role);

-- FK index on asset_id (the second FK on this table — not covered by the (site_id, meter_role) idx).
CREATE INDEX IF NOT EXISTS meter_devices_asset_idx ON shared.meter_devices(asset_id);

-- REPOLENS data-integrity/015: partial UNIQUE INDEX enforcing
-- "max one primary grid meter per site". Without this, two rows for the same
-- site_id can both have is_primary_grid_meter = TRUE, leading to ambiguous
-- grid reads and contaminated DV decisions.
CREATE UNIQUE INDEX IF NOT EXISTS meter_devices_one_primary_per_site_uidx
  ON shared.meter_devices(site_id)
  WHERE is_primary_grid_meter = TRUE;

-- =============================================================================
-- shared.meter_channels — per-meter measurement channels
-- =============================================================================
CREATE TABLE IF NOT EXISTS shared.meter_channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meter_device_id UUID NOT NULL REFERENCES shared.meter_devices(id) ON DELETE CASCADE,
  channel_key TEXT NOT NULL,
  unit TEXT NOT NULL,
  phase TEXT
    CHECK (phase IS NULL OR phase IN ('l1', 'l2', 'l3', 'all')),
  direction TEXT
    CHECK (direction IS NULL OR direction IN ('import', 'export', 'bidirectional')),
  register_ref TEXT,
  topic_ref TEXT,
  scaling NUMERIC(14,6) NOT NULL DEFAULT 1,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Expression-based UNIQUE — Postgres does not allow expressions inside table-level
-- UNIQUE(...), so this becomes a unique index. Also serves as FK index on meter_device_id.
CREATE UNIQUE INDEX IF NOT EXISTS meter_channels_device_channel_phase_uidx
  ON shared.meter_channels(meter_device_id, channel_key, COALESCE(phase, 'all'));

-- =============================================================================
-- shared.telemetry_samples_raw — raw meter samples
-- =============================================================================
CREATE TABLE IF NOT EXISTS shared.telemetry_samples_raw (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES shared.sites(id) ON DELETE CASCADE,
  meter_device_id UUID REFERENCES shared.meter_devices(id) ON DELETE SET NULL,
  channel_id UUID REFERENCES shared.meter_channels(id) ON DELETE SET NULL,
  ts TIMESTAMPTZ NOT NULL,
  value_num NUMERIC(18,6) NOT NULL,
  quality TEXT NOT NULL DEFAULT 'raw'
    CHECK (quality IN ('raw', 'estimated', 'backfilled', 'invalid')),
  stale BOOLEAN NOT NULL DEFAULT FALSE,
  source TEXT NOT NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS telemetry_samples_raw_site_ts_idx ON shared.telemetry_samples_raw(site_id, ts DESC);
CREATE INDEX IF NOT EXISTS telemetry_samples_raw_channel_ts_idx ON shared.telemetry_samples_raw(channel_id, ts DESC);
-- FK index on meter_device_id (the third FK — not covered by the two indexes above).
CREATE INDEX IF NOT EXISTS telemetry_samples_raw_meter_device_idx ON shared.telemetry_samples_raw(meter_device_id);

-- =============================================================================
-- shared.live_snapshots — primary arbiter table between DV + Optimizer
-- =============================================================================
-- REPOLENS data-integrity/002: soc_pct CHECK [0, 100] inline.
-- REPOLENS schema-design/011: grid_import_w / grid_export_w are NULLABLE (no DEFAULT 0).
-- Rationale for nullability: NULL = "no data"; 0 = "data says zero". Default 0 silently
-- masks gaps; downstream consumers cannot distinguish "meter offline" from "no flow".
CREATE TABLE IF NOT EXISTS shared.live_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES shared.sites(id) ON DELETE CASCADE,
  captured_at TIMESTAMPTZ NOT NULL,
  grid_import_w BIGINT,
  grid_export_w BIGINT,
  grid_l1_w BIGINT,
  grid_l2_w BIGINT,
  grid_l3_w BIGINT,
  pv_power_w BIGINT,
  load_power_w BIGINT,
  battery_power_w BIGINT,
  soc_pct NUMERIC(6,3) CHECK (soc_pct IS NULL OR (soc_pct >= 0 AND soc_pct <= 100)),
  ev_charge_w BIGINT,
  grid_setpoint_w BIGINT,
  min_soc_pct NUMERIC(6,3) CHECK (min_soc_pct IS NULL OR (min_soc_pct >= 0 AND min_soc_pct <= 100)),
  data_quality TEXT NOT NULL DEFAULT 'ok'
    CHECK (data_quality IN ('ok', 'stale', 'partial', 'invalid')),
  raw_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS live_snapshots_site_captured_idx ON shared.live_snapshots(site_id, captured_at DESC);

-- =============================================================================
-- shared.market_price_runs — day-ahead price ingestions
-- =============================================================================
CREATE TABLE IF NOT EXISTS shared.market_price_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES shared.sites(id) ON DELETE CASCADE,
  provider_code TEXT NOT NULL,
  market_type TEXT NOT NULL
    CHECK (market_type IN ('day_ahead', 'import_tariff', 'export_tariff', 'balancing', 'custom')),
  version TEXT,
  fetched_at TIMESTAMPTZ NOT NULL,
  raw_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS market_price_runs_site_fetched_idx ON shared.market_price_runs(site_id, fetched_at DESC);

-- =============================================================================
-- shared.market_price_slots — per-slot prices
-- =============================================================================
CREATE TABLE IF NOT EXISTS shared.market_price_slots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES shared.market_price_runs(id) ON DELETE CASCADE,
  site_id UUID NOT NULL REFERENCES shared.sites(id) ON DELETE CASCADE,
  slot_start TIMESTAMPTZ NOT NULL,
  slot_end TIMESTAMPTZ NOT NULL,
  resolution_seconds INTEGER NOT NULL,
  price_kind TEXT NOT NULL
    CHECK (price_kind IN ('market', 'gross_import', 'export', 'opportunity')),
  price_ct_kwh NUMERIC(12,5),
  price_eur_mwh NUMERIC(12,5),
  confidence NUMERIC(6,5),
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (slot_end > slot_start),
  UNIQUE (run_id, price_kind, slot_start)
);

CREATE INDEX IF NOT EXISTS market_price_slots_site_start_idx ON shared.market_price_slots(site_id, slot_start);
-- FK index on run_id is covered by the leading column of UNIQUE (run_id, price_kind, slot_start).

-- =============================================================================
-- shared.tariff_sets — tariff configuration with valid_from/valid_to range
-- =============================================================================
-- REPOLENS data-integrity/003-014: table-level CHECK enforces valid_to > valid_from
-- (or NULL valid_to = "still active"). Prevents overlapping/contradictory tariff windows.
CREATE TABLE IF NOT EXISTS shared.tariff_sets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES shared.sites(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  tariff_type TEXT NOT NULL
    CHECK (tariff_type IN ('import', 'export', 'network', 'module3', 'custom')),
  valid_from TIMESTAMPTZ NOT NULL,
  valid_to TIMESTAMPTZ,
  config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (site_id, code, valid_from),
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);

-- FK index on site_id is covered by the leading column of UNIQUE (site_id, code, valid_from).

-- =============================================================================
-- shared.event_log — generic event log (Plan 09-05 will extend with actor columns)
-- =============================================================================
CREATE TABLE IF NOT EXISTS shared.event_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID REFERENCES shared.sites(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info'
    CHECK (severity IN ('debug', 'info', 'warn', 'error')),
  source TEXT NOT NULL,
  message TEXT NOT NULL,
  details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS event_log_site_created_idx ON shared.event_log(site_id, created_at DESC);

-- =============================================================================
-- shared.audit_log — audit trail with before/after JSONB
-- =============================================================================
CREATE TABLE IF NOT EXISTS shared.audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID REFERENCES shared.sites(id) ON DELETE CASCADE,
  actor_type TEXT NOT NULL
    CHECK (actor_type IN ('user', 'system', 'optimizer', 'dv')),
  actor_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  before_json JSONB,
  after_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_log_site_created_idx ON shared.audit_log(site_id, created_at DESC);

-- =============================================================================
-- schema_migrations self-registration
-- =============================================================================
INSERT INTO schema_migrations (version, description, applied_at)
VALUES (9, 'shared.* tables: sites, assets, asset_bindings, asset_constraints, meter_devices, meter_channels, telemetry_samples_raw, live_snapshots, market_price_runs/slots, tariff_sets, event_log, audit_log + REPOLENS-002/003/015 inline constraints', NOW())
ON CONFLICT (version) DO NOTHING;

COMMIT;
