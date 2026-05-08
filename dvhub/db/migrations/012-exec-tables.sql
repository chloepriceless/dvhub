-- Migration 012: exec.* tables (Execution / arbitration domain).
--
-- Source: docs/plans/2026-03-10-dvhub-postgres-schema-blueprint.md
-- Worktree template: .claude/worktrees/agent-aa7bdf66/db/postgres/migrations/0005_exec.sql
-- CONTEXT decisions: D-06 (exec.* table list), D-10 (schema-prefix hardcoded), D-11 (JSONB).
--
-- Note: exec.command_events INTENTIONALLY coexists with public.control_events
-- (different shape, different consumers). Convergence is deferred to Plan
-- 09-05 (Audit-Trail durability) per CONTEXT "Out of scope für 8.1".
--
-- Cross-schema FKs: arbitration_runs references dv.decisions(id) and
-- opt.plans(id). Migration 010 (dv.*) and 011 (opt.*) run BEFORE this one
-- via the runner's numeric ordering, so the FK target tables exist by the
-- time CREATE TABLE here is parsed (Postgres validates FK targets at
-- CREATE TABLE time).
--
-- All tables created empty. No data migration in this phase (D-01: additive).
BEGIN;

-- exec.control_intents — multi-source intents (DV / optimization / manual / safety).
CREATE TABLE IF NOT EXISTS exec.control_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES shared.sites(id) ON DELETE CASCADE,
  source_module TEXT NOT NULL
    CHECK (source_module IN ('dv', 'optimization', 'manual', 'safety')),
  source_ref_id UUID,
  priority INTEGER NOT NULL,
  intent_type TEXT NOT NULL
    CHECK (intent_type IN ('curtailment', 'export_limit', 'battery_schedule', 'ev_schedule', 'setpoint', 'fallback')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'superseded', 'cancelled', 'expired')),
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS control_intents_site_created_idx ON exec.control_intents(site_id, created_at DESC);
CREATE INDEX IF NOT EXISTS control_intents_site_priority_idx ON exec.control_intents(site_id, priority DESC, created_at DESC);

-- exec.intent_slots — per-slot intent values.
CREATE TABLE IF NOT EXISTS exec.intent_slots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  control_intent_id UUID NOT NULL REFERENCES exec.control_intents(id) ON DELETE CASCADE,
  slot_start TIMESTAMPTZ NOT NULL,
  slot_end TIMESTAMPTZ NOT NULL,
  target_key TEXT NOT NULL,
  target_value_num NUMERIC(18,6),
  unit TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (control_intent_id, slot_start, target_key)
);

-- exec.arbitration_runs — DV-vs-Opt-vs-Manual arbitration log.
-- Cross-schema FKs: active_dv_decision_id → dv.decisions, active_opt_plan_id → opt.plans.
CREATE TABLE IF NOT EXISTS exec.arbitration_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES shared.sites(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL
    CHECK (status IN ('running', 'completed', 'failed', 'skipped')),
  active_dv_decision_id UUID REFERENCES dv.decisions(id) ON DELETE SET NULL,
  active_opt_plan_id UUID REFERENCES opt.plans(id) ON DELETE SET NULL,
  reason TEXT,
  details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS arbitration_runs_site_started_idx ON exec.arbitration_runs(site_id, started_at DESC);

-- exec.effective_plans — final plan after arbitration.
CREATE TABLE IF NOT EXISTS exec.effective_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES shared.sites(id) ON DELETE CASCADE,
  arbitration_run_id UUID NOT NULL REFERENCES exec.arbitration_runs(id) ON DELETE CASCADE,
  plan_mode TEXT NOT NULL
    CHECK (plan_mode IN ('dv_only', 'optimization_only', 'combined', 'fallback')),
  valid_from TIMESTAMPTZ NOT NULL,
  valid_to TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'expired', 'cancelled', 'superseded')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (valid_to > valid_from)
);

CREATE INDEX IF NOT EXISTS effective_plans_site_valid_idx ON exec.effective_plans(site_id, valid_from DESC);

-- exec.effective_plan_slots — per-slot effective vs requested values.
-- reason_codes_json is array-shaped — default '[]'::jsonb (NOT '{}').
CREATE TABLE IF NOT EXISTS exec.effective_plan_slots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  effective_plan_id UUID NOT NULL REFERENCES exec.effective_plans(id) ON DELETE CASCADE,
  slot_start TIMESTAMPTZ NOT NULL,
  slot_end TIMESTAMPTZ NOT NULL,
  target_key TEXT NOT NULL,
  requested_value NUMERIC(18,6),
  effective_value NUMERIC(18,6),
  limited_by_dv BOOLEAN NOT NULL DEFAULT FALSE,
  limited_by_safety BOOLEAN NOT NULL DEFAULT FALSE,
  limited_by_manual BOOLEAN NOT NULL DEFAULT FALSE,
  reason_codes_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (effective_plan_id, slot_start, target_key)
);

CREATE INDEX IF NOT EXISTS effective_plan_slots_plan_start_idx ON exec.effective_plan_slots(effective_plan_id, slot_start);

-- exec.command_events — actual write commands sent (with effective vs requested).
-- Coexists with public.control_events; convergence deferred to Plan 09-05.
CREATE TABLE IF NOT EXISTS exec.command_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES shared.sites(id) ON DELETE CASCADE,
  effective_plan_slot_id UUID REFERENCES exec.effective_plan_slots(id) ON DELETE SET NULL,
  target_system TEXT NOT NULL
    CHECK (target_system IN ('victron', 'evcc', 'inverter', 'gateway', 'custom')),
  target_key TEXT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL,
  requested_value NUMERIC(18,6),
  effective_value NUMERIC(18,6),
  success BOOLEAN NOT NULL,
  error_text TEXT,
  readback_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS command_events_site_sent_idx ON exec.command_events(site_id, sent_at DESC);

-- exec.manual_overrides — operator overrides (force a target value temporarily).
CREATE TABLE IF NOT EXISTS exec.manual_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES shared.sites(id) ON DELETE CASCADE,
  target_key TEXT NOT NULL,
  value_num NUMERIC(18,6),
  valid_until TIMESTAMPTZ,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by TEXT
);

CREATE INDEX IF NOT EXISTS manual_overrides_site_created_idx ON exec.manual_overrides(site_id, created_at DESC);

INSERT INTO schema_migrations (version, description, applied_at)
VALUES (12, 'exec.* tables: control_intents/intent_slots, arbitration_runs, effective_plans/slots, command_events, manual_overrides', NOW())
ON CONFLICT (version) DO NOTHING;

COMMIT;
