-- 002-telemetry-tables.sql
-- Telemetry tables for the SQLite backend.
-- Raw tables are created dynamically as telemetry_raw_YYYY_MM by the adapter.
-- This file documents the schema template and creates rollup tables.

-- Template for monthly raw tables (created dynamically as telemetry_raw_YYYY_MM)
-- This documents the schema; actual tables are created by adapter code.
CREATE TABLE IF NOT EXISTS telemetry_raw_template (
  id INTEGER PRIMARY KEY,
  ts_utc TEXT NOT NULL,
  series_key TEXT NOT NULL,
  value_num REAL,
  unit TEXT,
  source TEXT NOT NULL DEFAULT 'local_poll',
  quality TEXT NOT NULL DEFAULT 'raw',
  meta_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS telemetry_5min (
  id INTEGER PRIMARY KEY,
  bucket TEXT NOT NULL,
  series_key TEXT NOT NULL,
  avg_value REAL,
  min_value REAL,
  max_value REAL,
  sample_count INTEGER NOT NULL DEFAULT 0,
  unit TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(bucket, series_key)
);
CREATE INDEX IF NOT EXISTS idx_telemetry_5min_series_bucket
  ON telemetry_5min(series_key, bucket);

CREATE TABLE IF NOT EXISTS telemetry_15min (
  id INTEGER PRIMARY KEY,
  bucket TEXT NOT NULL,
  series_key TEXT NOT NULL,
  avg_value REAL,
  min_value REAL,
  max_value REAL,
  sample_count INTEGER NOT NULL DEFAULT 0,
  unit TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(bucket, series_key)
);
CREATE INDEX IF NOT EXISTS idx_telemetry_15min_series_bucket
  ON telemetry_15min(series_key, bucket);

CREATE TABLE IF NOT EXISTS telemetry_daily (
  id INTEGER PRIMARY KEY,
  bucket TEXT NOT NULL,
  series_key TEXT NOT NULL,
  avg_value REAL,
  min_value REAL,
  max_value REAL,
  sample_count INTEGER NOT NULL DEFAULT 0,
  unit TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(bucket, series_key)
);
CREATE INDEX IF NOT EXISTS idx_telemetry_daily_series_bucket
  ON telemetry_daily(series_key, bucket);
