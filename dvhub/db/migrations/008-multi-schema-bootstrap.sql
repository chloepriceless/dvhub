-- Migration 008: Multi-schema bootstrap (foundation for Multi-Vendor, Phases 10+11).
--
-- Source: docs/plans/2026-03-10-dvhub-postgres-schema-blueprint.md
-- Worktree template: .claude/worktrees/agent-aa7bdf66/db/postgres/migrations/0001_bootstrap.sql
-- CONTEXT decisions: D-06 (new schemas), D-07 (file naming).
--
-- Creates the four domain schemas (shared/dv/opt/exec) and the shared
-- updated_at trigger function. Idempotent: re-running this is a no-op.
--
-- Why now: Plan 08-08 surfaced that REPOLENS audit findings reference
-- shared.* / dv.* / opt.* / exec.* tables that did not yet exist in dvhub.
-- This migration closes that gap additively (D-01: lazy migration, no
-- public-schema cutover in 8.1).
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS shared;
CREATE SCHEMA IF NOT EXISTS dv;
CREATE SCHEMA IF NOT EXISTS opt;
CREATE SCHEMA IF NOT EXISTS exec;

CREATE OR REPLACE FUNCTION shared.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

INSERT INTO schema_migrations (version, description, applied_at)
VALUES (8, 'Multi-schema bootstrap: pgcrypto + shared/dv/opt/exec schemas + set_updated_at()', NOW())
ON CONFLICT (version) DO NOTHING;

COMMIT;
