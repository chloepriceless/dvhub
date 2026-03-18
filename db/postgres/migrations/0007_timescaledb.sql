begin;

-- ============================================================
-- 0007: TimescaleDB extension + local telemetry tables
--
-- This migration adds:
--   1. TimescaleDB extension
--   2. Local telemetry tables (migrated from SQLite schema)
--   3. Hypertable conversion for timeseries_samples
--   4. Compression + retention policies
--   5. Continuous aggregates (replace manual rollups)
-- ============================================================

create extension if not exists timescaledb;

-- -----------------------------------------------------------
-- 1. Core timeseries table (mirrors SQLite timeseries_samples)
-- -----------------------------------------------------------

create table if not exists timeseries_samples (
  id bigint generated always as identity,
  series_key text not null,
  scope text not null,
  source text not null,
  quality text not null,
  ts_utc timestamptz not null,
  resolution_seconds integer not null,
  value_num double precision,
  value_text text,
  unit text,
  meta_json jsonb,
  created_at timestamptz not null default now(),
  primary key (id, ts_utc),
  unique (series_key, scope, source, quality, ts_utc, resolution_seconds)
);

select create_hypertable(
  'timeseries_samples',
  'ts_utc',
  chunk_time_interval => interval '7 days',
  if_not_exists => true
);

create index if not exists idx_timeseries_series_ts
  on timeseries_samples (series_key, ts_utc desc);
create index if not exists idx_timeseries_scope_ts
  on timeseries_samples (scope, ts_utc desc);

-- -----------------------------------------------------------
-- 2. Materialized energy slots (for VRM import compatibility)
-- -----------------------------------------------------------

create table if not exists energy_slots_15m (
  id bigint generated always as identity primary key,
  slot_start_utc timestamptz not null,
  series_key text not null,
  source_kind text not null,
  quality text not null,
  value_num double precision,
  unit text,
  meta_json jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (slot_start_utc, series_key, source_kind)
);

create index if not exists idx_energy_slots_15m_slot_start
  on energy_slots_15m (slot_start_utc);

-- -----------------------------------------------------------
-- 3. Control events
-- -----------------------------------------------------------

create table if not exists control_events (
  id bigint generated always as identity primary key,
  event_type text not null,
  target text,
  value_num double precision,
  value_text text,
  reason text,
  source text not null,
  ts_utc timestamptz not null,
  meta_json jsonb
);

-- -----------------------------------------------------------
-- 4. Schedule snapshots
-- -----------------------------------------------------------

create table if not exists schedule_snapshots (
  id bigint generated always as identity primary key,
  ts_utc timestamptz not null,
  rules_json jsonb not null,
  default_grid_setpoint_w double precision,
  default_charge_current_a double precision,
  source text not null
);

-- -----------------------------------------------------------
-- 5. Optimizer runs + series
-- -----------------------------------------------------------

create table if not exists optimizer_runs (
  id bigint generated always as identity primary key,
  optimizer text not null,
  run_started_at timestamptz not null,
  run_finished_at timestamptz,
  status text not null,
  input_json jsonb,
  result_json jsonb,
  source text not null,
  external_run_id text
);

create table if not exists optimizer_run_series (
  id bigint generated always as identity primary key,
  optimizer_run_id bigint not null references optimizer_runs(id) on delete cascade,
  series_key text not null,
  scope text not null,
  ts_utc timestamptz not null,
  resolution_seconds integer not null,
  value_num double precision,
  unit text
);

-- -----------------------------------------------------------
-- 6. Import jobs
-- -----------------------------------------------------------

create table if not exists import_jobs (
  id bigint generated always as identity primary key,
  job_type text not null,
  started_at timestamptz not null,
  finished_at timestamptz,
  status text not null,
  requested_from timestamptz,
  requested_to timestamptz,
  imported_rows integer not null default 0,
  source_account text,
  meta_json jsonb
);

-- -----------------------------------------------------------
-- 7. Data gaps
-- -----------------------------------------------------------

create table if not exists data_gaps (
  id bigint generated always as identity primary key,
  series_key text not null,
  gap_start timestamptz not null,
  gap_end timestamptz not null,
  detected_at timestamptz not null,
  status text not null,
  fill_source text
);

-- -----------------------------------------------------------
-- 8. Solar market values
-- -----------------------------------------------------------

create table if not exists solar_market_values (
  id bigint generated always as identity primary key,
  scope text not null,
  key text not null,
  ct_kwh double precision not null,
  source text not null,
  fetched_at timestamptz not null,
  last_attempt_at timestamptz,
  cooldown_until timestamptz,
  status text not null default 'ready',
  error text,
  unique (scope, key)
);

create index if not exists idx_solar_market_values_scope_key
  on solar_market_values (scope, key);

create table if not exists solar_market_value_year_attempts (
  year integer primary key,
  last_attempt_at timestamptz not null,
  cooldown_until timestamptz,
  status text not null,
  error text
);

-- -----------------------------------------------------------
-- 9. Compression policy for timeseries_samples
-- -----------------------------------------------------------

alter table timeseries_samples
  set (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'series_key,scope,source',
    timescaledb.compress_orderby = 'ts_utc desc'
  );

select add_compression_policy(
  'timeseries_samples',
  compress_after => interval '7 days',
  if_not_exists => true
);

-- -----------------------------------------------------------
-- 10. Retention policy (45 days for raw non-rollup data)
-- -----------------------------------------------------------

select add_retention_policy(
  'timeseries_samples',
  drop_after => interval '45 days',
  if_not_exists => true
);

-- -----------------------------------------------------------
-- 11. Continuous aggregate: 15-minute energy buckets
-- -----------------------------------------------------------

create materialized view if not exists energy_slots_15m_cagg
with (timescaledb.continuous) as
select
  time_bucket('15 minutes', ts_utc) as slot_start,
  series_key,
  avg(value_num) as avg_value,
  min(value_num) as min_value,
  max(value_num) as max_value,
  count(*) as sample_count
from timeseries_samples
where quality != 'invalid'
  and value_num is not null
  and scope in ('live', 'history')
group by time_bucket('15 minutes', ts_utc), series_key
with no data;

select add_continuous_aggregate_policy(
  'energy_slots_15m_cagg',
  start_offset    => interval '1 hour',
  end_offset      => interval '15 minutes',
  schedule_interval => interval '15 minutes',
  if_not_exists   => true
);

-- -----------------------------------------------------------
-- 12. Continuous aggregate: 1-hour energy buckets
-- -----------------------------------------------------------

create materialized view if not exists energy_slots_1h_cagg
with (timescaledb.continuous) as
select
  time_bucket('1 hour', ts_utc) as slot_start,
  series_key,
  avg(value_num) as avg_value,
  min(value_num) as min_value,
  max(value_num) as max_value,
  count(*) as sample_count
from timeseries_samples
where quality != 'invalid'
  and value_num is not null
  and scope in ('live', 'history')
group by time_bucket('1 hour', ts_utc), series_key
with no data;

select add_continuous_aggregate_policy(
  'energy_slots_1h_cagg',
  start_offset    => interval '3 hours',
  end_offset      => interval '1 hour',
  schedule_interval => interval '1 hour',
  if_not_exists   => true
);

commit;
