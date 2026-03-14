-- 004-policies.sql
-- Refresh, compression, and retention policies for TimescaleDB.

-- Continuous aggregate refresh policies
SELECT add_continuous_aggregate_policy('telemetry_5min',
  start_offset => INTERVAL '1 hour',
  end_offset   => INTERVAL '5 minutes',
  schedule_interval => INTERVAL '5 minutes',
  if_not_exists => TRUE);

SELECT add_continuous_aggregate_policy('telemetry_15min',
  start_offset => INTERVAL '3 hours',
  end_offset   => INTERVAL '15 minutes',
  schedule_interval => INTERVAL '15 minutes',
  if_not_exists => TRUE);

SELECT add_continuous_aggregate_policy('telemetry_daily',
  start_offset => INTERVAL '3 days',
  end_offset   => INTERVAL '1 day',
  schedule_interval => INTERVAL '1 day',
  if_not_exists => TRUE);

-- Compression on raw telemetry (after 7 days)
ALTER TABLE telemetry_raw SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'series_key',
  timescaledb.compress_orderby = 'ts DESC'
);
SELECT add_compression_policy('telemetry_raw',
  compress_after => INTERVAL '7 days',
  if_not_exists => TRUE);

-- Retention policies
-- Raw data: 7 days (compressed data is dropped after rollup to 5min)
SELECT add_retention_policy('telemetry_raw',
  drop_after => INTERVAL '7 days',
  if_not_exists => TRUE);

-- 5-minute aggregates: 90 days
SELECT add_retention_policy('telemetry_5min',
  drop_after => INTERVAL '90 days',
  if_not_exists => TRUE);

-- 15-minute aggregates: 2 years (730 days)
SELECT add_retention_policy('telemetry_15min',
  drop_after => INTERVAL '730 days',
  if_not_exists => TRUE);

-- Daily aggregates: no retention (kept forever)
