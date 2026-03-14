-- 003-continuous-aggs.sql
-- Hierarchical Continuous Aggregates: 5min -> 15min -> daily.
-- Requires TimescaleDB >= 2.9 for hierarchical stacking.

-- 5-minute continuous aggregate (base layer from raw)
CREATE MATERIALIZED VIEW IF NOT EXISTS telemetry_5min
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('5 minutes', ts) AS bucket,
  series_key,
  AVG(value_num) AS avg_value,
  MIN(value_num) AS min_value,
  MAX(value_num) AS max_value,
  COUNT(*) AS sample_count
FROM telemetry_raw
GROUP BY bucket, series_key
WITH NO DATA;

-- 15-minute continuous aggregate (stacked on 5min)
CREATE MATERIALIZED VIEW IF NOT EXISTS telemetry_15min
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('15 minutes', bucket) AS bucket,
  series_key,
  AVG(avg_value) AS avg_value,
  MIN(min_value) AS min_value,
  MAX(max_value) AS max_value,
  SUM(sample_count) AS sample_count
FROM telemetry_5min
GROUP BY 1, series_key
WITH NO DATA;

-- Daily continuous aggregate (stacked on 15min)
CREATE MATERIALIZED VIEW IF NOT EXISTS telemetry_daily
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 day', bucket) AS bucket,
  series_key,
  AVG(avg_value) AS avg_value,
  MIN(min_value) AS min_value,
  MAX(max_value) AS max_value,
  SUM(sample_count) AS sample_count
FROM telemetry_15min
GROUP BY 1, series_key
WITH NO DATA;
