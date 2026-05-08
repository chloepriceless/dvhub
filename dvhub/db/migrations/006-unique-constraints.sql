-- Migration 006: UNIQUE constraints to prevent duplicate/conflicting rows
-- (REPOLENS database/data-integrity).
--
-- tesla_snapshots had no UNIQUE constraint at all — duplicate (vin/car_id, ts_utc)
-- pairs are accepted today, polluting accuracy joins and confusing the
-- "latest snapshot" lookup. The current non-unique idx_tesla_snapshots_car_ts
-- index gets superseded by the UNIQUE constraint's auto-created index, so we
-- drop the redundant non-unique one.
--
-- Pre-add de-duplication: keep the row with the highest id (= last-inserted)
-- per (car_id, ts_utc) tuple. The choice between max(id) vs max(ingested_at)
-- is moot because car_id+ts_utc are typed in nanosecond-resolution-equivalent
-- timestamps and id is monotonic — same outcome.
--
-- Multi-schema UNIQUE work (device_readings (device_id, ts_utc, metric_key) —
-- the metric_key column does not yet exist in the public-schema device_readings
-- table; shared.meter_devices partial UNIQUE on is_primary_grid_meter — that
-- table does not exist yet) is deferred to Phase 8.1 (Multi-Schema Genesis).
BEGIN;

-- De-dup before constraint add. CTE keeps the last row per (car_id, ts_utc).
DELETE FROM tesla_snapshots a
USING tesla_snapshots b
WHERE a.car_id = b.car_id
  AND a.ts_utc = b.ts_utc
  AND a.id < b.id;

ALTER TABLE tesla_snapshots
  ADD CONSTRAINT tesla_snapshots_unique_car_ts UNIQUE (car_id, ts_utc);

-- The UNIQUE constraint creates its own implicit btree index on (car_id, ts_utc).
-- The previous non-unique idx_tesla_snapshots_car_ts is now redundant.
DROP INDEX IF EXISTS idx_tesla_snapshots_car_ts;

INSERT INTO schema_migrations (version, description, applied_at)
VALUES (6, 'UNIQUE constraint: tesla_snapshots(car_id, ts_utc) + drop redundant non-unique index', NOW())
ON CONFLICT (version) DO NOTHING;

COMMIT;
