# Phase 2: Data Architecture - Context

**Gathered:** 2026-03-14
**Status:** Ready for planning
**Source:** Orchestrator conversation (database architecture discussion)

<domain>
## Phase Boundary

Phase 2 implements the Database Adapter Pattern with TimescaleDB/PostgreSQL as default backend and SQLite as lightweight fallback. It creates multi-resolution telemetry storage with automatic rollups (Continuous Aggregates for TimescaleDB, manual for SQLite), retention policies, and schema-prefix conventions. The existing SQLite telemetry store is migrated behind the new adapter interface.

This phase does NOT change the Gateway poll loop or add new telemetry points -- it provides the storage infrastructure that all modules will use.

</domain>

<decisions>
## Implementation Decisions

### Database Backend Selection
- TimescaleDB/PostgreSQL is the **default** backend (x86 primary platform)
- SQLite is the **fallback** for lightweight/edge deployments
- Selection via config: `database.backend: "timescaledb" | "sqlite"` (default: "timescaledb")
- Both backends behind the same Database Adapter interface
- `pg` npm package is a core dependency (not optional)
- `node:sqlite` (built-in) for SQLite backend -- no extra dependency

### Database Adapter Interface
- Modules call adapter methods, never raw SQL specific to one backend
- Adapter methods: insert, query, aggregate, rollup, retention, health-check
- Factory pattern: `createDatabaseAdapter(config)` returns the correct backend
- Adapter must support both sync and async operations where needed

### TimescaleDB Backend (Default)
- Hypertables for raw telemetry data (automatic partitioning by time)
- Continuous Aggregates for 5-min, 15-min, and daily rollups (no manual rollup code needed)
- Native compression policies for old data (90%+ space savings)
- Native retention policies (automatic data cleanup)
- Connection via `pg` driver with connection pooling
- Schema: Uses PostgreSQL schemas or table prefixes for module separation

### SQLite Backend (Fallback)
- WAL mode enabled for concurrent read/write
- Optimized PRAGMAs (journal_mode=WAL, synchronous=NORMAL, cache_size, mmap_size)
- Monthly partitioned raw tables: telemetry_raw_YYYY_MM
- Manual rollup engine (scheduled job that aggregates and inserts into rollup tables)
- Manual retention policy (scheduled job that purges old data after rollup confirmation)

### Multi-Resolution Data Retention
- Raw data (~1s resolution): retained 7 days, then purged after rollup confirmation
- 5-minute rollups: retained 90 days
- 15-minute rollups: retained 2 years
- Daily rollups: retained forever
- Rollups contain: avg, min, max, count for each metric

### Schema Convention
- All tables follow prefix convention: shared_, dv_, opt_, exec_, telemetry_
- `telemetry_raw` -- high-resolution raw samples (Hypertable in TimescaleDB)
- `telemetry_5min` -- 5-minute aggregates
- `telemetry_15min` -- 15-minute aggregates
- `telemetry_daily` -- daily aggregates
- `shared_config` -- configuration state
- Module-specific tables (dv_*, opt_*, exec_*) are created by their respective modules in later phases

### Performance Target
- Queries against 30-day history must return in under 500ms
- This is on x86 hardware (not Pi-constrained)

### Existing Data
- Current SQLite telemetry data should be preservable (migration path)
- VRM backfill data already exists in 15-min blocks
- Existing telemetry-store.js in the codebase should be replaced by the adapter

### Claude's Discretion
- Internal adapter method signatures and return types
- Connection pool configuration for PostgreSQL
- Continuous Aggregate refresh intervals
- Compression policy thresholds (e.g., compress chunks older than X days)
- SQLite PRAGMA tuning values
- Error handling and retry strategy for database connections
- Migration script format (SQL files vs programmatic)
- Whether to use a migration library or raw SQL for schema setup

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Existing Architecture
- `docs/plans/2026-03-10-dvhub-postgres-schema-blueprint.md` -- PostgreSQL schema blueprint with 4 schemas (shared, dv, opt, exec). Reference for table structure and naming.
- `docs/plans/2026-03-10-dvhub-data-architecture-masterlist.md` -- Data architecture with MVP tables, rollup definitions, and retention policies.

### Phase 1 Deliverables
- `dvhub/core/config.js` -- Config loading (database.backend will be added here)
- `dvhub/core/event-bus.js` -- RxJS event bus (telemetry streams that feed data to storage)
- `dvhub/modules/gateway/index.js` -- Gateway module (currently writes to SQLite directly)
- `dvhub/modules/gateway/telemetry.js` -- Telemetry stream definitions

### Current Database Code
- Existing SQLite telemetry store code in the codebase (to be replaced by adapter)

### Research
- `.planning/research/STACK.md` -- Database recommendations (SQLite vs TimescaleDB analysis)
- `.planning/research/ARCHITECTURE.md` -- Architecture patterns including data layer design
- `.planning/research/PITFALLS.md` -- Database-related pitfalls (P2: premature PostgreSQL migration, P9: storage bloat)

</canonical_refs>

<specifics>
## Specific Ideas

- TimescaleDB Continuous Aggregates eliminate the need for a manual rollup engine on the default backend -- massive simplification
- The `pg` driver supports parameterized queries which prevent SQL injection
- For SQLite, the existing `node:sqlite` DatabaseSync API provides synchronous operations
- Schema setup should be idempotent (CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS)
- Consider a `database.connectionString` config for TimescaleDB (e.g., `postgresql://user:pass@host:5432/dvhub`)
- The adapter should expose a `healthCheck()` method that modules can call
- Rollup tables should include a `sample_count` column to verify completeness before purging raw data

</specifics>

<deferred>
## Deferred Ideas

- PostgreSQL replication / HA setup -- not needed for single-site
- InfluxDB backend -- evaluated and rejected for v2
- Multi-site database synchronization -- out of scope
- GraphQL API for database queries -- REST endpoints sufficient
- Real-time streaming of database changes (CDC) -- not needed yet

</deferred>

---

*Phase: 02-data-architecture*
*Context gathered: 2026-03-14 via orchestrator conversation*
