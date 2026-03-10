# DVhub Data Architecture Masterlist

**Date:** 2026-03-10

**Status:** Reference document

**Purpose:** Preserve the agreed data architecture, module split, and phased table masterlist for future implementation stages without losing the design reasoning from the planning discussion.

## Related Documents

- `docs/plans/2026-03-10-dvhub-optimizer-orchestrator-design.md`
- `docs/plans/2026-03-10-dvhub-optimizer-orchestrator.md`

## Core Architectural Decision

DVhub is structured into two primary product modules plus a shared platform and a shared execution layer:

- `DV Core`
- `Optimization Core`
- `Shared Platform`
- `Execution / Arbitration Layer`

This split is intentional and must be kept in future iterations.

### DV Core

The DV Core is a standalone module for:

- direct marketing interfaces
- DV-specific rules and operating state
- negative-price and curtailment logic
- manufacturer-independent control support
- live meter-based DV operation even without forecasts or optimizers

The DV Core must not depend on the forecast or optimizer stack to remain operational.

### Optimization Core

The Optimization Core is a standalone module for:

- PV, load, EV, and market forecasts
- optimizer integration such as EOS and EMHASS
- plan generation, scoring, and backtesting
- economic import/export/battery/EV scheduling

The Optimization Core produces candidate plans but does not directly control devices.

### Shared Platform

The Shared Platform is responsible for:

- site and asset registry
- telemetry and live state
- price and tariff data
- bindings to external systems and devices
- common logs and audit trails

### Execution / Arbitration Layer

Only the execution layer may produce effective control commands.

Priority order:

1. technical safety and hard device constraints
2. DV Core restrictions
3. manual overrides
4. Optimization Core candidate plans

## Database Strategy

Recommended database layout:

- `PostgreSQL` as primary relational store
- optional `TimescaleDB` later for heavy time-series scaling
- optional `Redis` for volatile runtime state and queueing

Recommended schemas:

- `shared`
- `dv`
- `opt`
- `exec`

Modeling rule:

- anything used for filtering, scoring, comparison, reporting, or enforcement must be stored in typed columns
- provider-specific or manufacturer-specific details may additionally be stored in `jsonb`

## Non-Negotiable System Rules

- DV and Optimization never write directly to devices
- both produce intents, not final commands
- the DV live meter path is first-class and must not be hidden behind optimizer logic
- the system must support `DV-only`, `Optimization-only`, and `Combined` operation modes
- plan selection and execution must remain auditable

## Required Live Meter Principle

The DV module requires a dedicated live measurement path from the grid interconnection point.

This includes:

- current grid import
- current grid export
- phase values when available
- timestamps for data freshness
- quality or stale markers

This path is required even if no optimizer is active.

## Standard Cross-Table Fields

These fields should be standardized broadly across the schema where applicable:

- `id`
- `site_id`
- `created_at`
- `updated_at`
- `status`
- `source`
- `slot_start`
- `slot_end`
- `resolution_seconds`
- `priority`
- `confidence`
- `quality`
- `metadata_json`

## MVP Masterlist

These tables are considered the first professional implementation baseline.

### Shared Schema

- `shared.sites`
- `shared.assets`
- `shared.asset_bindings`
- `shared.asset_constraints`
- `shared.meter_devices`
- `shared.meter_channels`
- `shared.telemetry_samples_raw`
- `shared.live_snapshots`
- `shared.market_price_runs`
- `shared.market_price_slots`
- `shared.tariff_sets`
- `shared.event_log`
- `shared.audit_log`

### DV Schema

- `dv.providers`
- `dv.provider_connections`
- `dv.rules`
- `dv.operating_state`
- `dv.decisions`
- `dv.actions`
- `dv.action_results`
- `dv.measurement_exports`

### Optimization Schema

- `opt.forecast_providers`
- `opt.forecast_runs`
- `opt.forecast_slots`
- `opt.input_snapshots`
- `opt.optimizer_providers`
- `opt.optimizer_runs`
- `opt.plans`
- `opt.plan_slots`
- `opt.plan_scores`

### Execution Schema

- `exec.control_intents`
- `exec.intent_slots`
- `exec.arbitration_runs`
- `exec.effective_plans`
- `exec.effective_plan_slots`
- `exec.command_events`
- `exec.manual_overrides`

## Phase 2 Masterlist

These tables should be added once backtesting, richer analytics, or broader device integration becomes active.

### Shared Schema

- `shared.live_point_values`
- `shared.telemetry_slots`
- `shared.tariff_slots`

### DV Schema

- `dv.signal_runs`
- `dv.signal_slots`
- `dv.rule_assignments`
- `dv.export_policies`
- `dv.manufacturer_profiles`
- `dv.control_capabilities`

### Optimization Schema

- `opt.forecast_quality`
- `opt.optimizer_configs`
- `opt.optimizer_artifacts`
- `opt.plan_score_slots`
- `opt.plan_backtests`
- `opt.statistics_daily`

### Execution Schema

- `exec.command_batches`
- `exec.feedback_events`
- `exec.failures`
- `exec.active_state`

## Later Optional Tables

These are useful but not required for the first production-ready architecture.

### Optimization Schema

- `opt.plan_versions`
- `opt.blend_candidates`
- `opt.statistics_contextual`

### DV Schema

- provider-specific extension tables if future direct marketers send true slot schedules or advanced control directives

### Execution Schema

- replay or recovery-specific execution tables for more advanced event-driven operation

## Especially Important MVP Tables

These should not be cut from the first serious schema version:

- `shared.meter_devices`
- `shared.meter_channels`
- `shared.telemetry_samples_raw`
- `dv.measurement_exports`
- `exec.arbitration_runs`

They preserve the explicit grid-meter live path, DV observability, and the separation between intent generation and effective execution.

## Operational Modes

The schema and service architecture must support:

- `DV-only`
- `Optimization-only`
- `Combined`

This is a core design requirement, not a future enhancement.

## Reference Guidance for Future Expansion

When extending the platform later:

- add new providers through `asset_bindings`, provider registries, and adapter logic first
- avoid embedding provider-specific fields into general plan or telemetry tables if they are not broadly queryable
- prefer new phase-specific tables over bloating MVP tables with nullable edge-case columns
- preserve the strict separation between DV decisions, optimizer plans, and effective execution

## Summary

This document is the canonical reference for the agreed DVhub data architecture direction:

- dual-module platform with `DV Core` and `Optimization Core`
- shared telemetry and pricing foundation
- shared execution and arbitration authority
- phased table rollout with strong MVP boundaries
- explicit preservation of the grid live-value path for DV operation
