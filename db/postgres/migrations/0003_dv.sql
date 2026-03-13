begin;

create table dv.providers (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table dv.provider_connections (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references shared.sites(id) on delete cascade,
  provider_id uuid not null references dv.providers(id) on delete restrict,
  endpoint text,
  tunnel_type text
    check (tunnel_type is null or tunnel_type in ('openvpn', 'wireguard', 'plain_tcp', 'custom')),
  status text not null default 'configured'
    check (status in ('configured', 'connected', 'degraded', 'error', 'disabled')),
  last_seen_at timestamptz,
  config_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (site_id, provider_id)
);

create table dv.rules (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references shared.sites(id) on delete cascade,
  rule_key text not null,
  priority integer not null default 100,
  enabled boolean not null default true,
  hard_constraint boolean not null default true,
  valid_from timestamptz not null,
  valid_to timestamptz,
  condition_json jsonb not null default '{}'::jsonb,
  action_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (site_id, rule_key, valid_from)
);

create index dv_rules_site_priority_idx on dv.rules(site_id, priority, valid_from desc);

create table dv.operating_state (
  site_id uuid primary key references shared.sites(id) on delete cascade,
  provider_id uuid references dv.providers(id) on delete set null,
  updated_at timestamptz not null,
  dv_mode text not null default 'active'
    check (dv_mode in ('active', 'passive', 'standby', 'error')),
  control_value integer
    check (control_value is null or control_value in (0, 1)),
  export_allowed boolean not null default true,
  export_limit_w bigint,
  forced_curtailment boolean not null default false,
  reason text,
  stale boolean not null default false,
  details_json jsonb not null default '{}'::jsonb
);

create table dv.decisions (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references shared.sites(id) on delete cascade,
  provider_id uuid references dv.providers(id) on delete set null,
  ts timestamptz not null,
  slot_start timestamptz,
  slot_end timestamptz,
  decision_type text not null
    check (decision_type in ('allow_export', 'limit_export', 'force_curtailment', 'allow_runtime', 'block_export')),
  export_allowed boolean not null,
  effective_export_limit_w bigint,
  reason text,
  source_rule_id uuid references dv.rules(id) on delete set null,
  details_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (slot_end is null or slot_start is not null)
);

create index dv_decisions_site_ts_idx on dv.decisions(site_id, ts desc);
create index dv_decisions_site_slot_idx on dv.decisions(site_id, slot_start);

create table dv.actions (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references shared.sites(id) on delete cascade,
  decision_id uuid references dv.decisions(id) on delete set null,
  target_system text not null
    check (target_system in ('victron', 'inverter', 'gateway', 'custom')),
  target_key text not null,
  requested_value numeric(18,6),
  status text not null default 'pending'
    check (status in ('pending', 'sent', 'skipped', 'failed', 'completed')),
  created_at timestamptz not null default now()
);

create index dv_actions_site_created_idx on dv.actions(site_id, created_at desc);

create table dv.action_results (
  id uuid primary key default gen_random_uuid(),
  action_id uuid not null references dv.actions(id) on delete cascade,
  executed_at timestamptz not null,
  success boolean not null,
  effective_value numeric(18,6),
  error_text text,
  readback_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table dv.measurement_exports (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references shared.sites(id) on delete cascade,
  provider_id uuid references dv.providers(id) on delete set null,
  ts timestamptz not null,
  grid_import_w bigint not null default 0,
  grid_export_w bigint not null default 0,
  grid_l1_w bigint,
  grid_l2_w bigint,
  grid_l3_w bigint,
  quality text not null default 'ok'
    check (quality in ('ok', 'stale', 'partial', 'invalid')),
  published_to_provider boolean not null default false,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index dv_measurement_exports_site_ts_idx on dv.measurement_exports(site_id, ts desc);

commit;
