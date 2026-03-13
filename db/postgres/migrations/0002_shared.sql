begin;

create table shared.sites (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  timezone text not null,
  currency text not null default 'EUR',
  operating_mode text not null default 'combined'
    check (operating_mode in ('dv_only', 'optimization_only', 'combined')),
  enabled boolean not null default true,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table shared.assets (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references shared.sites(id) on delete cascade,
  asset_type text not null
    check (asset_type in ('battery', 'inverter', 'pv_array', 'meter', 'evse', 'vehicle', 'gateway', 'controller')),
  code text not null,
  name text not null,
  manufacturer text,
  model text,
  serial_no text,
  enabled boolean not null default true,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (site_id, code)
);

create index assets_site_type_idx on shared.assets(site_id, asset_type);

create table shared.asset_bindings (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references shared.assets(id) on delete cascade,
  binding_type text not null
    check (binding_type in ('driver', 'external_system', 'mqtt_topic', 'modbus_map', 'rest_resource')),
  provider_code text not null,
  external_ref text not null,
  binding_status text not null default 'active'
    check (binding_status in ('active', 'disabled', 'error')),
  config_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (asset_id, binding_type, provider_code, external_ref)
);

create table shared.asset_constraints (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references shared.assets(id) on delete cascade,
  valid_from timestamptz not null,
  valid_to timestamptz,
  min_soc_pct numeric(6,3),
  max_soc_pct numeric(6,3),
  max_charge_w bigint,
  max_discharge_w bigint,
  max_import_w bigint,
  max_export_w bigint,
  usable_capacity_wh bigint,
  charge_efficiency numeric(6,5),
  discharge_efficiency numeric(6,5),
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (min_soc_pct is null or (min_soc_pct >= 0 and min_soc_pct <= 100)),
  check (max_soc_pct is null or (max_soc_pct >= 0 and max_soc_pct <= 100)),
  check (valid_to is null or valid_to > valid_from)
);

create index asset_constraints_asset_from_idx on shared.asset_constraints(asset_id, valid_from desc);

create table shared.meter_devices (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references shared.sites(id) on delete cascade,
  asset_id uuid references shared.assets(id) on delete set null,
  meter_role text not null
    check (meter_role in ('grid_interconnection', 'pv', 'battery', 'load', 'submeter')),
  source_type text not null
    check (source_type in ('modbus', 'mqtt', 'rest', 'driver', 'derived')),
  driver_key text not null,
  is_primary_grid_meter boolean not null default false,
  poll_interval_ms integer not null default 1000,
  enabled boolean not null default true,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index meter_devices_site_role_idx on shared.meter_devices(site_id, meter_role);

create table shared.meter_channels (
  id uuid primary key default gen_random_uuid(),
  meter_device_id uuid not null references shared.meter_devices(id) on delete cascade,
  channel_key text not null,
  unit text not null,
  phase text
    check (phase is null or phase in ('l1', 'l2', 'l3', 'all')),
  direction text
    check (direction is null or direction in ('import', 'export', 'bidirectional')),
  register_ref text,
  topic_ref text,
  scaling numeric(14,6) not null default 1,
  enabled boolean not null default true,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create unique index meter_channels_device_channel_phase_uidx
  on shared.meter_channels(meter_device_id, channel_key, coalesce(phase, 'all'));

create table shared.telemetry_samples_raw (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references shared.sites(id) on delete cascade,
  meter_device_id uuid references shared.meter_devices(id) on delete set null,
  channel_id uuid references shared.meter_channels(id) on delete set null,
  ts timestamptz not null,
  value_num numeric(18,6) not null,
  quality text not null default 'raw'
    check (quality in ('raw', 'estimated', 'backfilled', 'invalid')),
  stale boolean not null default false,
  source text not null,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index telemetry_samples_raw_site_ts_idx on shared.telemetry_samples_raw(site_id, ts desc);
create index telemetry_samples_raw_channel_ts_idx on shared.telemetry_samples_raw(channel_id, ts desc);

create table shared.live_snapshots (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references shared.sites(id) on delete cascade,
  captured_at timestamptz not null,
  grid_import_w bigint not null default 0,
  grid_export_w bigint not null default 0,
  grid_l1_w bigint,
  grid_l2_w bigint,
  grid_l3_w bigint,
  pv_power_w bigint,
  load_power_w bigint,
  battery_power_w bigint,
  soc_pct numeric(6,3),
  ev_charge_w bigint,
  grid_setpoint_w bigint,
  min_soc_pct numeric(6,3),
  data_quality text not null default 'ok'
    check (data_quality in ('ok', 'stale', 'partial', 'invalid')),
  raw_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index live_snapshots_site_captured_idx on shared.live_snapshots(site_id, captured_at desc);

create table shared.market_price_runs (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references shared.sites(id) on delete cascade,
  provider_code text not null,
  market_type text not null
    check (market_type in ('day_ahead', 'import_tariff', 'export_tariff', 'balancing', 'custom')),
  version text,
  fetched_at timestamptz not null,
  raw_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index market_price_runs_site_fetched_idx on shared.market_price_runs(site_id, fetched_at desc);

create table shared.market_price_slots (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references shared.market_price_runs(id) on delete cascade,
  site_id uuid not null references shared.sites(id) on delete cascade,
  slot_start timestamptz not null,
  slot_end timestamptz not null,
  resolution_seconds integer not null,
  price_kind text not null
    check (price_kind in ('market', 'gross_import', 'export', 'opportunity')),
  price_ct_kwh numeric(12,5),
  price_eur_mwh numeric(12,5),
  confidence numeric(6,5),
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (slot_end > slot_start),
  unique (run_id, price_kind, slot_start)
);

create index market_price_slots_site_start_idx on shared.market_price_slots(site_id, slot_start);

create table shared.tariff_sets (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references shared.sites(id) on delete cascade,
  code text not null,
  tariff_type text not null
    check (tariff_type in ('import', 'export', 'network', 'module3', 'custom')),
  valid_from timestamptz not null,
  valid_to timestamptz,
  config_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (site_id, code, valid_from)
);

create table shared.event_log (
  id uuid primary key default gen_random_uuid(),
  site_id uuid references shared.sites(id) on delete cascade,
  event_type text not null,
  severity text not null default 'info'
    check (severity in ('debug', 'info', 'warn', 'error')),
  source text not null,
  message text not null,
  details_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index event_log_site_created_idx on shared.event_log(site_id, created_at desc);

create table shared.audit_log (
  id uuid primary key default gen_random_uuid(),
  site_id uuid references shared.sites(id) on delete cascade,
  actor_type text not null
    check (actor_type in ('user', 'system', 'optimizer', 'dv')),
  actor_id text,
  action text not null,
  entity_type text not null,
  entity_id text not null,
  before_json jsonb,
  after_json jsonb,
  created_at timestamptz not null default now()
);

create index audit_log_site_created_idx on shared.audit_log(site_id, created_at desc);

commit;
