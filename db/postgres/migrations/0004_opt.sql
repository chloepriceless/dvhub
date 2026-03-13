begin;

create table opt.forecast_providers (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  forecast_type text not null
    check (forecast_type in ('pv', 'load', 'ev', 'weather', 'price')),
  endpoint text,
  active boolean not null default true,
  config_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table opt.forecast_runs (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references shared.sites(id) on delete cascade,
  provider_id uuid references opt.forecast_providers(id) on delete set null,
  forecast_type text not null
    check (forecast_type in ('pv', 'load', 'ev', 'weather', 'price')),
  model_version text,
  created_at timestamptz not null default now(),
  horizon_start timestamptz not null,
  horizon_end timestamptz not null,
  raw_json jsonb not null default '{}'::jsonb,
  check (horizon_end > horizon_start)
);

create index forecast_runs_site_created_idx on opt.forecast_runs(site_id, created_at desc);

create table opt.forecast_slots (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references opt.forecast_runs(id) on delete cascade,
  site_id uuid not null references shared.sites(id) on delete cascade,
  slot_start timestamptz not null,
  slot_end timestamptz not null,
  resolution_seconds integer not null,
  forecast_type text not null
    check (forecast_type in ('pv', 'load', 'ev', 'weather', 'price')),
  value_num numeric(18,6) not null,
  unit text not null,
  confidence numeric(6,5),
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (run_id, forecast_type, slot_start)
);

create index forecast_slots_site_start_idx on opt.forecast_slots(site_id, slot_start);

create table opt.input_snapshots (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references shared.sites(id) on delete cascade,
  created_at timestamptz not null default now(),
  horizon_start timestamptz not null,
  horizon_end timestamptz not null,
  resolution_seconds integer not null,
  snapshot_hash text not null,
  payload_json jsonb not null,
  unique (site_id, snapshot_hash)
);

create index input_snapshots_site_created_idx on opt.input_snapshots(site_id, created_at desc);

create table opt.optimizer_providers (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  active boolean not null default true,
  config_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table opt.optimizer_runs (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references shared.sites(id) on delete cascade,
  optimizer_provider_id uuid not null references opt.optimizer_providers(id) on delete restrict,
  input_snapshot_id uuid not null references opt.input_snapshots(id) on delete restrict,
  started_at timestamptz not null,
  finished_at timestamptz,
  status text not null
    check (status in ('pending', 'running', 'completed', 'failed', 'skipped')),
  runtime_ms integer,
  error_text text,
  raw_result_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index optimizer_runs_site_started_idx on opt.optimizer_runs(site_id, started_at desc);

create table opt.plans (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references shared.sites(id) on delete cascade,
  optimizer_run_id uuid not null references opt.optimizer_runs(id) on delete cascade,
  plan_kind text not null default 'candidate'
    check (plan_kind in ('candidate', 'winner', 'fallback', 'blend')),
  horizon_start timestamptz not null,
  horizon_end timestamptz not null,
  feasible boolean not null default false,
  selected boolean not null default false,
  selection_reason text,
  created_at timestamptz not null default now(),
  check (horizon_end > horizon_start)
);

create index plans_site_selected_idx on opt.plans(site_id, selected, horizon_start desc);

create table opt.plan_slots (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references opt.plans(id) on delete cascade,
  site_id uuid not null references shared.sites(id) on delete cascade,
  slot_start timestamptz not null,
  slot_end timestamptz not null,
  resolution_seconds integer not null,
  grid_import_wh bigint not null default 0,
  grid_export_wh bigint not null default 0,
  battery_charge_grid_wh bigint not null default 0,
  battery_charge_pv_wh bigint not null default 0,
  battery_discharge_load_wh bigint not null default 0,
  battery_discharge_export_wh bigint not null default 0,
  ev_charge_wh bigint not null default 0,
  target_soc_pct numeric(6,3),
  expected_profit_eur numeric(12,5),
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (plan_id, slot_start)
);

create index plan_slots_site_start_idx on opt.plan_slots(site_id, slot_start);

create table opt.plan_scores (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null unique references opt.plans(id) on delete cascade,
  site_id uuid not null references shared.sites(id) on delete cascade,
  feasibility_score numeric(12,5) not null default 0,
  economic_score numeric(12,5) not null default 0,
  soc_score numeric(12,5) not null default 0,
  forecast_score numeric(12,5) not null default 0,
  dv_compliance_score numeric(12,5) not null default 0,
  total_score numeric(12,5) not null default 0,
  winner boolean not null default false,
  scored_at timestamptz not null default now(),
  details_json jsonb not null default '{}'::jsonb
);

create index plan_scores_site_scored_idx on opt.plan_scores(site_id, scored_at desc);
create index plan_scores_site_total_idx on opt.plan_scores(site_id, total_score desc);

commit;
