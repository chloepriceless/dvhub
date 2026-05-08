-- Migration 002: enable foreign-key enforcement.
--
-- Postgres: foreign keys are enforced by default whenever the database engine
-- is built with FK support (always, in our case). This migration is therefore
-- a Postgres no-op apart from recording the intent in schema_migrations.
--
-- SQLite (the embedded session-cache database in dvhub/telemetry-store.js):
-- the engine ignores FOREIGN KEY clauses unless `PRAGMA foreign_keys = ON` is
-- set on the connection. The PRAGMA is per-connection and CANNOT be applied
-- via this SQL file (it never runs against the SQLite handle). Plan 08-08
-- Task 1 sets the PRAGMA programmatically inside createTelemetryStore() so
-- every freshly-opened SQLite connection enforces FKs.
--
-- The single FK in the public-schema (optimizer_run_series.optimizer_run_id →
-- optimizer_runs.id ON DELETE CASCADE) now actually fires on parent delete.
-- Multi-schema FK enforcement (shared/dv/opt/exec) is deferred to Phase 8.1
-- (Multi-Schema Genesis) — those tables do not yet exist in this codebase.
INSERT INTO schema_migrations (version, description, applied_at)
VALUES (2, 'Enable FK enforcement (SQLite via PRAGMA, Postgres no-op marker)', NOW())
ON CONFLICT (version) DO NOTHING;
