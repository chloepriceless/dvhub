begin;

create table exec.control_intents (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references shared.sites(id) on delete cascade,
  source_module text not null
    check (source_module in ('dv', 'optimization', 'manual', 'safety')),
  source_ref_id uuid,
  priority integer not null,
  intent_type text not null
    check (intent_type in ('curtailment', 'export_limit', 'battery_schedule', 'ev_schedule', 'setpoint', 'fallback')),
  status text not null default 'active'
    check (status in ('active', 'superseded', 'cancelled', 'expired')),
  payload_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index control_intents_site_created_idx on exec.control_intents(site_id, created_at desc);
create index control_intents_site_priority_idx on exec.control_intents(site_id, priority desc, created_at desc);

create table exec.intent_slots (
  id uuid primary key default gen_random_uuid(),
  control_intent_id uuid not null references exec.control_intents(id) on delete cascade,
  slot_start timestamptz not null,
  slot_end timestamptz not null,
  target_key text not null,
  target_value_num numeric(18,6),
  unit text,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (control_intent_id, slot_start, target_key)
);

create table exec.arbitration_runs (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references shared.sites(id) on delete cascade,
  started_at timestamptz not null,
  finished_at timestamptz,
  status text not null
    check (status in ('running', 'completed', 'failed', 'skipped')),
  active_dv_decision_id uuid references dv.decisions(id) on delete set null,
  active_opt_plan_id uuid references opt.plans(id) on delete set null,
  reason text,
  details_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index arbitration_runs_site_started_idx on exec.arbitration_runs(site_id, started_at desc);

create table exec.effective_plans (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references shared.sites(id) on delete cascade,
  arbitration_run_id uuid not null references exec.arbitration_runs(id) on delete cascade,
  plan_mode text not null
    check (plan_mode in ('dv_only', 'optimization_only', 'combined', 'fallback')),
  valid_from timestamptz not null,
  valid_to timestamptz not null,
  status text not null default 'active'
    check (status in ('active', 'expired', 'cancelled', 'superseded')),
  created_at timestamptz not null default now(),
  check (valid_to > valid_from)
);

create index effective_plans_site_valid_idx on exec.effective_plans(site_id, valid_from desc);

create table exec.effective_plan_slots (
  id uuid primary key default gen_random_uuid(),
  effective_plan_id uuid not null references exec.effective_plans(id) on delete cascade,
  slot_start timestamptz not null,
  slot_end timestamptz not null,
  target_key text not null,
  requested_value numeric(18,6),
  effective_value numeric(18,6),
  limited_by_dv boolean not null default false,
  limited_by_safety boolean not null default false,
  limited_by_manual boolean not null default false,
  reason_codes_json jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  unique (effective_plan_id, slot_start, target_key)
);

create index effective_plan_slots_plan_start_idx on exec.effective_plan_slots(effective_plan_id, slot_start);

create table exec.command_events (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references shared.sites(id) on delete cascade,
  effective_plan_slot_id uuid references exec.effective_plan_slots(id) on delete set null,
  target_system text not null
    check (target_system in ('victron', 'evcc', 'inverter', 'gateway', 'custom')),
  target_key text not null,
  sent_at timestamptz not null,
  requested_value numeric(18,6),
  effective_value numeric(18,6),
  success boolean not null,
  error_text text,
  readback_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index command_events_site_sent_idx on exec.command_events(site_id, sent_at desc);

create table exec.manual_overrides (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references shared.sites(id) on delete cascade,
  target_key text not null,
  value_num numeric(18,6),
  valid_until timestamptz,
  reason text,
  created_at timestamptz not null default now(),
  created_by text
);

create index manual_overrides_site_created_idx on exec.manual_overrides(site_id, created_at desc);

commit;
