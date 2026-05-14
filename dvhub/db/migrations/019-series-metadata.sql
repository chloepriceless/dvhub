-- Migration 019: Telemetry source-tagging via series_metadata lookup table.
--
-- User request 2026-05-14 (Phase 09.2 D-06..D-10): enable Explorer source-chip
-- filter without rewriting 22M rows on the timeseries_samples hypertable.
-- JOIN over a ~57-row lookup table is O(60) per query — negligible cost,
-- chunk-pruning still works because the WHERE clause on ts_utc is unaffected.
--
-- Strategy:
--   - CREATE TABLE IF NOT EXISTS series_metadata with CHECK on source enum (10 values).
--   - Seed known series_keys (sourced from telemetry-store-pg.js
--     MATERIALIZED_ENERGY_SERIES, telemetry-runtime.js EXTRA_SERIES_MAP,
--     services/optimizer/index.js writeSamples calls, history-import.js writes,
--     dv-bids/dv-control polling and prod observation).
--   - ON CONFLICT (series_key) DO NOTHING for idempotent re-runs.
--   - writeSamples gains a defensive INSERT (Phase 09.2 D-09, plan task 3) so
--     previously-unknown series_keys land with source='unknown'.
--
-- Why CHECK constraint instead of PG ENUM:
--   D-06 deferred-list item — adding new sources later requires only a
--   migration that drops + re-adds the CHECK; an ENUM TYPE would need
--   ALTER TYPE ADD VALUE which is not transactional in older PG versions
--   and forces additional tooling. 10 values is small enough that CHECK is
--   the simpler contract.
--
-- Reversal:
--   DROP TABLE IF EXISTS series_metadata;
--   DELETE FROM schema_migrations WHERE version = 19;

BEGIN;

CREATE TABLE IF NOT EXISTS series_metadata (
  series_key TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('victron','mid','luox','epex','optimizer','tibber','ha','loxone','tesla','unknown')),
  unit TEXT,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO series_metadata (series_key, source, unit, description) VALUES
  -- Victron (PV + battery + load + ESS) ---------------------------------
  ('pv_total_w',                'victron', 'W',  'Photovoltaic total power'),
  ('pv_ac_w',                   'victron', 'W',  'AC PV power (Multiplus AC-coupled)'),
  ('pv_dc_w',                   'victron', 'W',  'DC PV power (MPPT)'),
  ('pv_power_w',                'victron', 'W',  'PV power (alias used by optimizer)'),
  ('battery_power_w',           'victron', 'W',  'Battery power (+ charge, - discharge)'),
  ('battery_charge_w',          'victron', 'W',  'Battery charge component'),
  ('battery_discharge_w',       'victron', 'W',  'Battery discharge component'),
  ('battery_soc_pct',           'victron', '%',  'Battery state of charge'),
  ('battery_voltage_v',         'victron', 'V',  'Battery voltage'),
  ('battery_current_a',         'victron', 'A',  'Battery current'),
  ('battery_temperature_c',     'victron', 'C',  'Battery temperature'),
  ('temperature_c',             'victron', 'C',  'Generic temperature reading (legacy import)'),
  ('load_power_w',              'victron', 'W',  'Load (house consumption) power'),
  ('self_consumption_w',        'victron', 'W',  'Self-consumption power'),
  ('inverter_power_w',          'victron', 'W',  'Inverter AC output power'),
  ('inverter_temperature_c',    'victron', 'C',  'Inverter temperature'),
  ('ess_setpoint_w',            'victron', 'W',  'ESS grid setpoint (commanded)'),
  ('ess_mode',                  'victron', '',   'ESS operating mode'),
  ('grid_setpoint_w',           'victron', 'W',  'Grid setpoint reflected by inverter'),
  ('charge_current_a',          'victron', 'A',  'Charge current limit'),
  ('min_soc_pct',               'victron', '%',  'Minimum SOC threshold'),
  ('vrm_solar_yield_w',         'victron', 'W',  'VRM solar yield reference'),
  ('vrm_site_consumption_w',    'victron', 'W',  'VRM site consumption reference'),
  ('vrm_grid_import_ref_w',     'victron', 'W',  'VRM grid import reference'),
  ('vrm_grid_export_ref_w',     'victron', 'W',  'VRM grid export reference'),
  ('vrm_consumption_input_w',   'victron', 'W',  'VRM consumption input reference'),
  ('vrm_consumption_output_w',  'victron', 'W',  'VRM consumption output reference'),
  ('solar_direct_use_w',        'victron', 'W',  'Solar power consumed locally without battery'),
  ('solar_to_battery_w',        'victron', 'W',  'Solar power routed to battery charge'),
  ('solar_to_grid_w',           'victron', 'W',  'Solar power exported to grid'),
  ('grid_direct_use_w',         'victron', 'W',  'Grid power consumed directly by load'),
  ('grid_to_battery_w',         'victron', 'W',  'Grid power used to charge battery'),
  ('battery_direct_use_w',      'victron', 'W',  'Battery power consumed locally'),
  ('battery_to_grid_w',         'victron', 'W',  'Battery power exported to grid'),
  -- MID-meter (grid power flow) ---------------------------------------
  ('grid_import_w',             'mid',     'W',  'Grid import power (MID meter)'),
  ('grid_export_w',             'mid',     'W',  'Grid export power (MID meter)'),
  ('grid_total_w',              'mid',     'W',  'Grid total net power (import - export)'),
  ('grid_voltage_l1_v',         'mid',     'V',  'Grid voltage L1'),
  ('grid_voltage_l2_v',         'mid',     'V',  'Grid voltage L2'),
  ('grid_voltage_l3_v',         'mid',     'V',  'Grid voltage L3'),
  ('grid_current_l1_a',         'mid',     'A',  'Grid current L1'),
  ('grid_current_l2_a',         'mid',     'A',  'Grid current L2'),
  ('grid_current_l3_a',         'mid',     'A',  'Grid current L3'),
  ('grid_frequency_hz',         'mid',     'Hz', 'Grid frequency'),
  ('mid_energy_import_kwh',     'mid',     'kWh','MID meter energy import total'),
  ('mid_energy_export_kwh',     'mid',     'kWh','MID meter energy export total'),
  -- EPEX (spot prices) ------------------------------------------------
  ('spot_price_ct_kwh',         'epex',    'ct/kWh', 'EPEX spot price (ct/kWh)'),
  ('spot_price_eur_mwh',        'epex',    'EUR/MWh','EPEX spot price (EUR/MWh)'),
  ('spot_price_import_ct_kwh',  'epex',    'ct/kWh', 'Effective import price with surcharges'),
  ('spot_price_export_ct_kwh',  'epex',    'ct/kWh', 'Effective export price'),
  ('price_ct_kwh',              'epex',    'ct/kWh', 'Price (alias used by optimizer/history-import)'),
  ('price_eur_mwh',             'epex',    'EUR/MWh','Price (alias EUR/MWh)'),
  ('price_import_ct_kwh',       'epex',    'ct/kWh', 'Import price (alias used by optimizer)'),
  ('epex_volume_mwh',           'epex',    'MWh',    'EPEX hourly traded volume'),
  -- Optimizer (planning outputs) --------------------------------------
  ('optim_target_w',            'optimizer','W', 'Optimizer target battery power'),
  ('optim_target_soc_pct',      'optimizer','%', 'Optimizer target SOC'),
  ('optim_grid_setpoint_w',     'optimizer','W', 'Optimizer grid setpoint'),
  ('optim_allow_grid_charge',   'optimizer','',  'Optimizer allow grid charge flag'),
  ('optim_allow_grid_discharge','optimizer','',  'Optimizer allow grid discharge flag'),
  ('optim_schedule_source',     'optimizer','',  'Schedule source (heuristic / milp / eos)'),
  ('optimizer_target_w',        'optimizer','W', 'Optimizer target power (alias)'),
  -- LUOX (Direktvermarkter — operational stats only; no revenue table) -
  ('luox_link_up',              'luox',    '',  'LUOX VPN link state'),
  ('luox_setpoint_w',           'luox',    'W', 'LUOX commanded setpoint'),
  ('luox_last_update_age_s',    'luox',    's', 'LUOX seconds since last update')
ON CONFLICT (series_key) DO NOTHING;

INSERT INTO schema_migrations (version, description, applied_at)
VALUES (19, 'series_metadata lookup + initial source mapping (Phase 09.2 D-06..D-10)', NOW())
ON CONFLICT (version) DO NOTHING;

COMMIT;
