-- Migration 020: Per-system health-tracker snapshot persistence.
--
-- User request 2026-05-14 (Phase 09.2 D-02, D-26): the in-memory
-- integrations-health-tracker (Plan 09.2-03) needs to survive process
-- restarts. On graceful shutdown the tracker UPSERTs one row per system;
-- on boot the factory hydrates state from these rows.
--
-- Schema:
--   system PRIMARY KEY -- at most ~9 distinct values (victron, mid, luox,
--                        mqtt, tibber, ha, loxone, tesla, devices). Bounded
--                        row count by design; UPSERT, never INSERT.
--   snapshot_jsonb     -- full state snapshot. Tracker writes
--                        { version: 1, latencyMs, uptimeSec, errors24h,
--                          lastSampleAt, sampleIntervalHistogramMs,
--                          firmware, status,
--                          _internalLatencyMs, _internalErrors24h }
--   taken_at           -- for operator inspection ("when was this written?")
--
-- Threat mitigations (per Plan 09.2-02 threat register):
--   T-09.2-DOS-DISK -- mitigated by PRIMARY KEY (system); table size capped
--                      at ~9 rows. Tracker MUST UPSERT, never raw INSERT.
--   T-09.2-INJ      -- mitigated in writer (Plan 03): payload bound via
--                      $2::jsonb placeholder; reader validates schema with
--                      `snap?.version === 1`.
--
-- Reversal:
--   DROP TABLE IF EXISTS integration_health_snapshots;
--   DELETE FROM schema_migrations WHERE version = 20;

BEGIN;

CREATE TABLE IF NOT EXISTS integration_health_snapshots (
  system TEXT PRIMARY KEY,
  snapshot_jsonb JSONB NOT NULL,
  taken_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations (version, description, applied_at)
VALUES (20, 'integration_health_snapshots — per-system shutdown snapshot for tracker rehydrate (Phase 09.2 D-02, D-26)', NOW())
ON CONFLICT (version) DO NOTHING;

COMMIT;
