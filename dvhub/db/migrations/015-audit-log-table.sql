-- Migration 015: Durable audit_log table for pushLog mirror.
--
-- Plan 08-09 Task 1: a 1000-entry in-memory ring buffer cannot serve as an
-- audit trail for legally-sensitive grid-asset control. This table receives
-- a fire-and-forget mirror of every pushLog() call so entries survive
-- restart and operator restarts (regulators asking "who flipped
-- allowGridCharge last week" can answer from SQL).
--
-- DRIFT NOTE: Plan 08-09-PLAN.md originally numbered this migration 008.
-- Phase 8.1 (Multi-Schema Genesis) shipped between plan 08-09 being written
-- (2026-04-18) and being executed (2026-05-09); 8.1's bootstrap migrations
-- claimed slots 008-014. This file uses slot 015 (next free) with the same
-- semantics. Version recorded in schema_migrations is 15. The plan's
-- must_haves.artifacts path reference is fulfilled by this file with the
-- renamed slot — see SUMMARY for details.
--
-- See also: shared.audit_log (migration 009 / phase 8.1) — DIFFERENT shape
-- (entity-change diff log with site_id REQUIRED, before_json/after_json).
-- public.audit_log (this file) is the operator-event log mirroring pushLog —
-- it has actor columns (ip, ua, session) and a JSONB payload, no site
-- concept. The two coexist intentionally. Convergence (if ever) is a
-- future-phase decision.
BEGIN;

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  ts_utc TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  event_type TEXT NOT NULL,
  payload JSONB,
  actor_ip TEXT,
  actor_ua TEXT,
  actor_session TEXT,
  severity TEXT DEFAULT 'info' CHECK (severity IN ('debug', 'info', 'warn', 'error', 'critical'))
);

CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log (ts_utc DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_event_ts ON audit_log (event_type, ts_utc DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor_ip_ts ON audit_log (actor_ip, ts_utc DESC);

-- Retention helper (documented — not a constraint): a future prune-job removes
-- rows older than 90d. Implementation belongs to a Phase 9 retention plan;
-- schema is in place now.

INSERT INTO schema_migrations (version, description, applied_at)
VALUES (15, 'audit_log table with actor columns + indexes (Plan 08-09 Task 1)', NOW())
ON CONFLICT (version) DO NOTHING;

COMMIT;
