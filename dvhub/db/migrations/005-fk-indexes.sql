-- Migration 005: btree indexes on FK columns lacking one (REPOLENS database
-- index-strategy/002-016).
--
-- Diagnostic query that should drive any further entries here:
--   SELECT c.conrelid::regclass AS tbl, a.attname AS col
--   FROM pg_constraint c
--   JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
--   WHERE c.contype = 'f'
--     AND NOT EXISTS (
--       SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid AND a.attnum = ANY(i.indkey)
--     );
--
-- In the current public-schema there is exactly ONE FK that lacks a
-- supporting index:
--   optimizer_run_series.optimizer_run_id REFERENCES optimizer_runs(id) ON DELETE CASCADE
--
-- Without an index on optimizer_run_id, every parent-row delete in
-- optimizer_runs triggers a sequential scan of optimizer_run_series to find
-- and cascade-delete child rows. On a Pi this is multi-second-lock territory
-- under load.
--
-- Multi-schema FK-index work (across shared/dv/opt/exec — REPOLENS
-- index-strategy/004) is deferred to Phase 8.1 (Multi-Schema Genesis).
BEGIN;

CREATE INDEX IF NOT EXISTS idx_optimizer_run_series_run_id
  ON optimizer_run_series (optimizer_run_id);

INSERT INTO schema_migrations (version, description, applied_at)
VALUES (5, 'FK index on optimizer_run_series.optimizer_run_id', NOW())
ON CONFLICT (version) DO NOTHING;

COMMIT;
