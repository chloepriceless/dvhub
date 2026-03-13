begin;

create extension if not exists pgcrypto;

create schema if not exists shared;
create schema if not exists dv;
create schema if not exists opt;
create schema if not exists exec;

create or replace function shared.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

commit;
