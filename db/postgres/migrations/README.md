# DVhub PostgreSQL MVP Migrations

Derived from:

- `docs/plans/2026-03-10-dvhub-postgres-schema-blueprint.md`
- commit `ecbe016` (`docs: add postgres schema blueprint`)

This package is intentionally tool-agnostic plain SQL. Apply the files in lexical order:

1. `0001_bootstrap.sql`
2. `0002_shared.sql`
3. `0003_dv.sql`
4. `0004_opt.sql`
5. `0005_exec.sql`
6. `0006_updated_at_triggers.sql`

Scope of this first package:

- PostgreSQL extension bootstrap (`pgcrypto`)
- schema creation for `shared`, `dv`, `opt`, `exec`
- full MVP table set from the blueprint
- base indexes from the blueprint
- centralized `updated_at` trigger wiring for tables that carry `updated_at`

Intentional non-scope in this first package:

- partitioning
- retention jobs
- seed data
- migration runner integration
- phase-2 tables

Notes:

- `shared.meter_channels` uses an expression-based unique index for `(meter_device_id, channel_key, coalesce(phase, 'all'))`, because PostgreSQL does not allow expressions inside a table-level `unique (...)` constraint.
- Timestamp-based indexes are kept in place so later partitioning remains possible without redesigning table shapes.

Example execution with `psql`:

```bash
psql -v ON_ERROR_STOP=1 -d "$DATABASE_URL" -f db/postgres/migrations/0001_bootstrap.sql
psql -v ON_ERROR_STOP=1 -d "$DATABASE_URL" -f db/postgres/migrations/0002_shared.sql
psql -v ON_ERROR_STOP=1 -d "$DATABASE_URL" -f db/postgres/migrations/0003_dv.sql
psql -v ON_ERROR_STOP=1 -d "$DATABASE_URL" -f db/postgres/migrations/0004_opt.sql
psql -v ON_ERROR_STOP=1 -d "$DATABASE_URL" -f db/postgres/migrations/0005_exec.sql
psql -v ON_ERROR_STOP=1 -d "$DATABASE_URL" -f db/postgres/migrations/0006_updated_at_triggers.sql
```
