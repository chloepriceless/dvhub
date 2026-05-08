-- Migration 011: opt.* tables (Optimization domain).
--
-- Source: docs/plans/2026-03-10-dvhub-postgres-schema-blueprint.md
-- Worktree template: .claude/worktrees/agent-aa7bdf66/db/postgres/migrations/0004_opt.sql
-- CONTEXT decisions: D-06 (opt.* table list), D-10 (schema-prefix hardcoded), D-11 (JSONB).
--
-- Note: opt.optimizer_runs (uuid-PK) is INTENTIONALLY DISTINCT from the
-- existing public.optimizer_runs (bigserial-PK). They coexist per D-10
-- (schema-prefix hardcoded in queries). Service-code refactor to opt.* is
-- deferred to Phase 10 (D-13: no service-code changes in 8.1).
--
-- All tables created empty. No data migration in this phase (D-01: additive).
BEGIN;

-- opt.forecast_providers — registry of forecast sources (PV/load/EV/weather/price).
CREATE TABLE IF NOT EXISTS opt.forecast_providers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  forecast_type TEXT NOT NULL
    CHECK (forecast_type IN ('pv', 'load', 'ev', 'weather', 'price')),
  endpoint TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- opt.forecast_runs — one row per forecast execution.
CREATE TABLE IF NOT EXISTS opt.forecast_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES shared.sites(id) ON DELETE CASCADE,
  provider_id UUID REFERENCES opt.forecast_providers(id) ON DELETE SET NULL,
  forecast_type TEXT NOT NULL
    CHECK (forecast_type IN ('pv', 'load', 'ev', 'weather', 'price')),
  model_version TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  horizon_start TIMESTAMPTZ NOT NULL,
  horizon_end TIMESTAMPTZ NOT NULL,
  raw_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  CHECK (horizon_end > horizon_start)
);

CREATE INDEX IF NOT EXISTS forecast_runs_site_created_idx ON opt.forecast_runs(site_id, created_at DESC);

-- opt.forecast_slots — per-slot forecast values.
CREATE TABLE IF NOT EXISTS opt.forecast_slots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES opt.forecast_runs(id) ON DELETE CASCADE,
  site_id UUID NOT NULL REFERENCES shared.sites(id) ON DELETE CASCADE,
  slot_start TIMESTAMPTZ NOT NULL,
  slot_end TIMESTAMPTZ NOT NULL,
  resolution_seconds INTEGER NOT NULL,
  forecast_type TEXT NOT NULL
    CHECK (forecast_type IN ('pv', 'load', 'ev', 'weather', 'price')),
  value_num NUMERIC(18,6) NOT NULL,
  unit TEXT NOT NULL,
  confidence NUMERIC(6,5),
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_id, forecast_type, slot_start)
);

CREATE INDEX IF NOT EXISTS forecast_slots_site_start_idx ON opt.forecast_slots(site_id, slot_start);

-- opt.input_snapshots — hashed input bundle for run-determinism.
CREATE TABLE IF NOT EXISTS opt.input_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES shared.sites(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  horizon_start TIMESTAMPTZ NOT NULL,
  horizon_end TIMESTAMPTZ NOT NULL,
  resolution_seconds INTEGER NOT NULL,
  snapshot_hash TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  UNIQUE (site_id, snapshot_hash)
);

CREATE INDEX IF NOT EXISTS input_snapshots_site_created_idx ON opt.input_snapshots(site_id, created_at DESC);

-- opt.optimizer_providers — registry of optimizer engines.
CREATE TABLE IF NOT EXISTS opt.optimizer_providers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- opt.optimizer_runs — uuid-PK; coexists with public.optimizer_runs (bigserial-PK)
-- per CONTEXT D-10 (schema-prefix hardcoded; convergence deferred to Phase 10).
CREATE TABLE IF NOT EXISTS opt.optimizer_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES shared.sites(id) ON DELETE CASCADE,
  optimizer_provider_id UUID NOT NULL REFERENCES opt.optimizer_providers(id) ON DELETE RESTRICT,
  input_snapshot_id UUID NOT NULL REFERENCES opt.input_snapshots(id) ON DELETE RESTRICT,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'skipped')),
  runtime_ms INTEGER,
  error_text TEXT,
  raw_result_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS optimizer_runs_site_started_idx ON opt.optimizer_runs(site_id, started_at DESC);

-- opt.plans — candidate / winner / fallback / blend plans for arbitration.
CREATE TABLE IF NOT EXISTS opt.plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES shared.sites(id) ON DELETE CASCADE,
  optimizer_run_id UUID NOT NULL REFERENCES opt.optimizer_runs(id) ON DELETE CASCADE,
  plan_kind TEXT NOT NULL DEFAULT 'candidate'
    CHECK (plan_kind IN ('candidate', 'winner', 'fallback', 'blend')),
  horizon_start TIMESTAMPTZ NOT NULL,
  horizon_end TIMESTAMPTZ NOT NULL,
  feasible BOOLEAN NOT NULL DEFAULT FALSE,
  selected BOOLEAN NOT NULL DEFAULT FALSE,
  selection_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (horizon_end > horizon_start)
);

CREATE INDEX IF NOT EXISTS plans_site_selected_idx ON opt.plans(site_id, selected, horizon_start DESC);

-- opt.plan_slots — per-slot plan instructions.
CREATE TABLE IF NOT EXISTS opt.plan_slots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id UUID NOT NULL REFERENCES opt.plans(id) ON DELETE CASCADE,
  site_id UUID NOT NULL REFERENCES shared.sites(id) ON DELETE CASCADE,
  slot_start TIMESTAMPTZ NOT NULL,
  slot_end TIMESTAMPTZ NOT NULL,
  resolution_seconds INTEGER NOT NULL,
  grid_import_wh BIGINT NOT NULL DEFAULT 0,
  grid_export_wh BIGINT NOT NULL DEFAULT 0,
  battery_charge_grid_wh BIGINT NOT NULL DEFAULT 0,
  battery_charge_pv_wh BIGINT NOT NULL DEFAULT 0,
  battery_discharge_load_wh BIGINT NOT NULL DEFAULT 0,
  battery_discharge_export_wh BIGINT NOT NULL DEFAULT 0,
  ev_charge_wh BIGINT NOT NULL DEFAULT 0,
  target_soc_pct NUMERIC(6,3),
  expected_profit_eur NUMERIC(12,5),
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (plan_id, slot_start)
);

CREATE INDEX IF NOT EXISTS plan_slots_site_start_idx ON opt.plan_slots(site_id, slot_start);

-- opt.plan_scores — multi-criteria scoring of each plan.
CREATE TABLE IF NOT EXISTS opt.plan_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id UUID NOT NULL UNIQUE REFERENCES opt.plans(id) ON DELETE CASCADE,
  site_id UUID NOT NULL REFERENCES shared.sites(id) ON DELETE CASCADE,
  feasibility_score NUMERIC(12,5) NOT NULL DEFAULT 0,
  economic_score NUMERIC(12,5) NOT NULL DEFAULT 0,
  soc_score NUMERIC(12,5) NOT NULL DEFAULT 0,
  forecast_score NUMERIC(12,5) NOT NULL DEFAULT 0,
  dv_compliance_score NUMERIC(12,5) NOT NULL DEFAULT 0,
  total_score NUMERIC(12,5) NOT NULL DEFAULT 0,
  winner BOOLEAN NOT NULL DEFAULT FALSE,
  scored_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  details_json JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS plan_scores_site_scored_idx ON opt.plan_scores(site_id, scored_at DESC);
CREATE INDEX IF NOT EXISTS plan_scores_site_total_idx ON opt.plan_scores(site_id, total_score DESC);

INSERT INTO schema_migrations (version, description, applied_at)
VALUES (11, 'opt.* tables: forecast_providers/runs/slots, input_snapshots, optimizer_providers/runs, plans/plan_slots/plan_scores', NOW())
ON CONFLICT (version) DO NOTHING;

COMMIT;
