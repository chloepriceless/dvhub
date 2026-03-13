begin;

create trigger set_shared_sites_updated_at
before update on shared.sites
for each row execute function shared.set_updated_at();

create trigger set_shared_assets_updated_at
before update on shared.assets
for each row execute function shared.set_updated_at();

create trigger set_shared_asset_bindings_updated_at
before update on shared.asset_bindings
for each row execute function shared.set_updated_at();

create trigger set_shared_meter_devices_updated_at
before update on shared.meter_devices
for each row execute function shared.set_updated_at();

create trigger set_shared_tariff_sets_updated_at
before update on shared.tariff_sets
for each row execute function shared.set_updated_at();

create trigger set_dv_provider_connections_updated_at
before update on dv.provider_connections
for each row execute function shared.set_updated_at();

create trigger set_dv_rules_updated_at
before update on dv.rules
for each row execute function shared.set_updated_at();

create trigger set_dv_operating_state_updated_at
before update on dv.operating_state
for each row execute function shared.set_updated_at();

commit;
