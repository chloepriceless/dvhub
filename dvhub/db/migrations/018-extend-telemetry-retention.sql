-- Migration 018: Remove 45-day retention policy on timeseries_samples.
--
-- User request 2026-05-14: keep granular 5s-resolution telemetry samples for
-- as long as possible. The previous 45-day retention policy (migration 014)
-- dropped chunks older than 45 days entirely, losing the raw resolution
-- forever.
--
-- Disk-math (prod 2026-05-14):
--   - timeseries_samples hypertable: 1460 MB for ~49 days (21.97M rows,
--     57 distinct series).
--   - Compressed chunks measure ~50 KB / week (24,000:1 ratio — TimescaleDB
--     columnar compression on repetitive numeric series).
--   - Current uncompressed week-chunk: ~1186 MB; after compression (≥7 days
--     old per migration 014's compression policy): ~50 KB.
--   - Disk: 54 GB total, 29 GB free (45% used).
-- → Keeping data forever at this compression ratio costs ~MB / year.
--   Retention removal carries effectively zero disk risk on this prod box.
--
-- Strategy:
--   - REMOVE the 45-day retention policy. Chunks live indefinitely.
--   - KEEP the compression policy from migration 014 untouched (compress
--     chunks older than 7 days). That's the mechanism that makes
--     long retention practically free.
--
-- Defense-in-depth (separate code change, not in this migration):
--   - services/forecast/forecast-store.js#runSmartRetention previously
--     deleted samples with resolution_seconds <= 15 older than 30 days under
--     disk pressure. That rule is now also disabled in code (see commit
--     log around this migration) so disk-pressure handling no longer races
--     this migration's intent. If disk ever truly fills, ops can manually
--     re-apply add_retention_policy('timeseries_samples',
--     drop_after => INTERVAL '<X> days') to re-enable culling.
--
-- Reversal:
--   SELECT add_retention_policy(
--     'timeseries_samples',
--     drop_after => INTERVAL '45 days',
--     if_not_exists => TRUE
--   );

-- Only attempt the TimescaleDB call when the extension is actually installed.
-- On stock Postgres remove_retention_policy() does not exist and a raw call
-- crashes the whole migration — even when the runner's timescaledb flag is off.
-- The guard checks the REAL extension state (more robust than a flag-skip: it
-- also covers "flag true but package missing"). No-op without the extension.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    PERFORM remove_retention_policy('timeseries_samples', if_exists => TRUE);
  END IF;
END $$;

-- Register migration (idempotent). MUST stay OUTSIDE the guard above so 018
-- always records itself even on a timescaledb-less box (else: endless re-run).
INSERT INTO schema_migrations (version, description, applied_at)
VALUES (18, 'Remove 45d retention on timeseries_samples — keep granular 5s data indefinitely (compression at 7d still active)', NOW())
ON CONFLICT (version) DO NOTHING;
