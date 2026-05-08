-- Migration 010: dv.* tables (DirektVermarktung domain).
--
-- Source: docs/plans/2026-03-10-dvhub-postgres-schema-blueprint.md
-- Worktree template: .claude/worktrees/agent-aa7bdf66/db/postgres/migrations/0003_dv.sql
-- CONTEXT decisions: D-06 (dv.* table list), D-10 (schema-prefix hardcoded), D-11 (JSONB).
--
-- Closes REPOLENS finding (deferred from Plan 08-08):
--   - data-integrity/003-014: dv.rules.valid_to > valid_from CHECK
--
-- All tables created empty. No data migration in this phase (D-01: additive).
-- Cross-schema FKs reference shared.sites(id) — that table is created by
-- migration 009 (Plan 8.1-02). The runner applies migrations in numeric
-- order, so 009 runs before 010.
BEGIN;

-- dv.providers — DirektVermarktung provider registry (Tibber-style external systems).
CREATE TABLE IF NOT EXISTS dv.providers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- dv.provider_connections — site × provider link with tunnel config.
CREATE TABLE IF NOT EXISTS dv.provider_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES shared.sites(id) ON DELETE CASCADE,
  provider_id UUID NOT NULL REFERENCES dv.providers(id) ON DELETE RESTRICT,
  endpoint TEXT,
  tunnel_type TEXT
    CHECK (tunnel_type IS NULL OR tunnel_type IN ('openvpn', 'wireguard', 'plain_tcp', 'custom')),
  status TEXT NOT NULL DEFAULT 'configured'
    CHECK (status IN ('configured', 'connected', 'degraded', 'error', 'disabled')),
  last_seen_at TIMESTAMPTZ,
  config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (site_id, provider_id)
);

-- dv.rules — versioned rule set (with valid_from/valid_to).
-- REPOLENS data-integrity/003-014: table-level CHECK (valid_to IS NULL OR valid_to > valid_from)
-- closes the gap deferred from Plan 08-08.
CREATE TABLE IF NOT EXISTS dv.rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES shared.sites(id) ON DELETE CASCADE,
  rule_key TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  hard_constraint BOOLEAN NOT NULL DEFAULT TRUE,
  valid_from TIMESTAMPTZ NOT NULL,
  valid_to TIMESTAMPTZ,
  condition_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  action_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (site_id, rule_key, valid_from),
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);

CREATE INDEX IF NOT EXISTS dv_rules_site_priority_idx ON dv.rules(site_id, priority, valid_from DESC);

-- dv.operating_state — current dv mode per site (singleton-per-site: site_id is BOTH PK and FK).
CREATE TABLE IF NOT EXISTS dv.operating_state (
  site_id UUID PRIMARY KEY REFERENCES shared.sites(id) ON DELETE CASCADE,
  provider_id UUID REFERENCES dv.providers(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  dv_mode TEXT NOT NULL DEFAULT 'active'
    CHECK (dv_mode IN ('active', 'passive', 'standby', 'error')),
  control_value INTEGER
    CHECK (control_value IS NULL OR control_value IN (0, 1)),
  export_allowed BOOLEAN NOT NULL DEFAULT TRUE,
  export_limit_w BIGINT,
  forced_curtailment BOOLEAN NOT NULL DEFAULT FALSE,
  reason TEXT,
  stale BOOLEAN NOT NULL DEFAULT FALSE,
  details_json JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- dv.decisions — DV decisions emitted to optimizer + executor.
CREATE TABLE IF NOT EXISTS dv.decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES shared.sites(id) ON DELETE CASCADE,
  provider_id UUID REFERENCES dv.providers(id) ON DELETE SET NULL,
  ts TIMESTAMPTZ NOT NULL,
  slot_start TIMESTAMPTZ,
  slot_end TIMESTAMPTZ,
  decision_type TEXT NOT NULL
    CHECK (decision_type IN ('allow_export', 'limit_export', 'force_curtailment', 'allow_runtime', 'block_export')),
  export_allowed BOOLEAN NOT NULL,
  effective_export_limit_w BIGINT,
  reason TEXT,
  source_rule_id UUID REFERENCES dv.rules(id) ON DELETE SET NULL,
  details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- WR-04: enforce slot validity — both endpoints set together AND end > start.
  -- Mirrors the (valid_to > valid_from) pattern used by dv.rules, tariff_sets,
  -- exec.effective_plans, opt.plans, opt.forecast_runs.
  CHECK (slot_end IS NULL OR (slot_start IS NOT NULL AND slot_end > slot_start))
);

CREATE INDEX IF NOT EXISTS dv_decisions_site_ts_idx ON dv.decisions(site_id, ts DESC);
CREATE INDEX IF NOT EXISTS dv_decisions_site_slot_idx ON dv.decisions(site_id, slot_start);

-- dv.actions — write actions to inverter / gateway.
CREATE TABLE IF NOT EXISTS dv.actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES shared.sites(id) ON DELETE CASCADE,
  decision_id UUID REFERENCES dv.decisions(id) ON DELETE SET NULL,
  target_system TEXT NOT NULL
    CHECK (target_system IN ('victron', 'inverter', 'gateway', 'custom')),
  target_key TEXT NOT NULL,
  requested_value NUMERIC(18,6),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'skipped', 'failed', 'completed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS dv_actions_site_created_idx ON dv.actions(site_id, created_at DESC);

-- dv.action_results — readback after sending an action.
CREATE TABLE IF NOT EXISTS dv.action_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action_id UUID NOT NULL REFERENCES dv.actions(id) ON DELETE CASCADE,
  executed_at TIMESTAMPTZ NOT NULL,
  success BOOLEAN NOT NULL,
  effective_value NUMERIC(18,6),
  error_text TEXT,
  readback_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- dv.measurement_exports — measurements published to providers.
CREATE TABLE IF NOT EXISTS dv.measurement_exports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES shared.sites(id) ON DELETE CASCADE,
  provider_id UUID REFERENCES dv.providers(id) ON DELETE SET NULL,
  ts TIMESTAMPTZ NOT NULL,
  grid_import_w BIGINT NOT NULL DEFAULT 0,
  grid_export_w BIGINT NOT NULL DEFAULT 0,
  grid_l1_w BIGINT,
  grid_l2_w BIGINT,
  grid_l3_w BIGINT,
  quality TEXT NOT NULL DEFAULT 'ok'
    CHECK (quality IN ('ok', 'stale', 'partial', 'invalid')),
  published_to_provider BOOLEAN NOT NULL DEFAULT FALSE,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS dv_measurement_exports_site_ts_idx ON dv.measurement_exports(site_id, ts DESC);

INSERT INTO schema_migrations (version, description, applied_at)
VALUES (10, 'dv.* tables: providers, provider_connections, rules + valid_range CHECK, operating_state, decisions, actions, action_results, measurement_exports', NOW())
ON CONFLICT (version) DO NOTHING;

COMMIT;
