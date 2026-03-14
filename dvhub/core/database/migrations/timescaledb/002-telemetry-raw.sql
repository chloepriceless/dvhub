-- 002-telemetry-raw.sql
-- Raw telemetry hypertable with automatic time-based partitioning.

CREATE TABLE IF NOT EXISTS telemetry_raw (
  ts TIMESTAMPTZ NOT NULL,
  series_key TEXT NOT NULL,
  value_num DOUBLE PRECISION,
  unit TEXT,
  source TEXT NOT NULL DEFAULT 'local_poll',
  quality TEXT NOT NULL DEFAULT 'raw',
  meta_json JSONB DEFAULT '{}'::jsonb
);

SELECT create_hypertable('telemetry_raw', 'ts', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_telemetry_raw_series_ts
  ON telemetry_raw(series_key, ts DESC);
