# Roadmap: DVhub v2 -- Modular Energy Management System

## Overview

DVhub v2 transforms a working but monolithic Node.js energy management server (~2800 lines) into a modular architecture with three runtime modules (Gateway, DV, Optimizer), an intent-based arbitration layer, and a modernized deployment and UI stack. The decomposition is incremental: extract the foundation first, then the production-critical DV module to validate the pattern, then the complex optimizer module with external integrations, then formalize the control pipeline, and finally modernize deployment and UI. Every phase delivers verifiable capability while preserving the existing production DV functionality.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Foundation** - Module infrastructure, event bus, Device HAL, and bootstrap extraction from monolithic server.js
- [ ] **Phase 2: Data Architecture** - SQLite WAL optimization, multi-resolution storage, partitioned telemetry, and rollup engine
- [ ] **Phase 3: DV Module** - Direktvermarktung extraction with provider adapters, measurement export, and curtailment processing
- [ ] **Phase 4: Optimizer Core** - Adapter registry, EOS/EMHASS adapters, plan engine, and plan scoring/selection
- [ ] **Phase 5: External Integrations** - EVCC bridge, forecast broker, tariff models, and MISPEL preparation
- [ ] **Phase 6: Arbitration + Execution** - Intent-based control pipeline with priority resolution, command logging, and audit trail
- [ ] **Phase 7: Deployment** - Docker Compose orchestration, hybrid mode, compose-manager, and native install updates
- [ ] **Phase 8: UI Modernization** - Preact+HTM migration, animated power flow, setup wizard, and mobile-responsive dashboard

## Phase Details

### Phase 1: Foundation
**Goal**: The monolithic server.js is decomposed into a module-aware bootstrap (~200 lines) with a working Gateway core, RxJS event bus, Fastify HTTP server, Device HAL, module registry, and user role system -- all existing functionality preserved
**Depends on**: Nothing (first phase)
**Requirements**: ARCH-01, ARCH-02, ARCH-04, ARCH-05, GW-01, GW-02, GW-03, GW-05, GW-06, GW-07, SEC-01, SEC-04, SEC-05
**Success Criteria** (what must be TRUE):
  1. server.js is under 250 lines and only bootstraps modules via the module registry
  2. Gateway module starts, polls hardware via Device HAL (Victron driver), and publishes telemetry via RxJS BehaviorSubjects -- DV module can synchronously read current meter values via getValue()
  3. Fastify replaces raw node:http with proper route registration, Ajv schema validation, and Pino structured logging
  4. WebSocket endpoint via @fastify/websocket pushes real-time updates to dashboard, with auth token validation and user role filtering (readonly/user/admin)
  5. Manufacturer configs are loaded from external JSON files and the Victron driver reads/writes through the HAL interface without brand-specific code in business logic
  6. Existing HTTP API endpoints respond identically to v1 behavior (no regressions in /api/status, /api/config, etc.)
  7. Modbus TCP proxy enforces IP AllowList, buffer size caps, and interface binding
**Plans**: TBD

Plans:
- [ ] 01-01: TBD
- [ ] 01-02: TBD
- [ ] 01-03: TBD

### Phase 2: Data Architecture
**Goal**: Telemetry storage supports multi-resolution retention with automatic rollups via a Database Adapter Pattern -- TimescaleDB/PostgreSQL as default backend, SQLite as lightweight fallback, both behind the same interface
**Depends on**: Phase 1
**Requirements**: DATA-01, DATA-02, DATA-03, DATA-04, DATA-05, DATA-06, GW-04
**Success Criteria** (what must be TRUE):
  1. Database Adapter interface abstracts storage operations -- modules call adapter methods, never raw SQL specific to one backend
  2. TimescaleDB backend (default): Hypertables for telemetry, Continuous Aggregates for 5min/15min/daily rollups, native compression and retention policies via pg driver
  3. SQLite backend (fallback): WAL mode, optimized PRAGMAs, monthly partitioned raw tables (telemetry_raw_YYYY_MM), manual rollup engine
  4. Rollup engine automatically aggregates raw samples into 5-min, 15-min, and daily resolution (Continuous Aggregates for TimescaleDB, manual for SQLite)
  5. Retention policy enforces cleanup: raw data older than 7 days is purged after rollup confirmation, 5-min data retained 90 days, 15-min data retained 2 years
  6. All tables follow schema-prefix convention (shared_, dv_, opt_, exec_, telemetry_) and queries against 30-day history return in under 500ms
  7. Backend selection via config: `database.backend: "timescaledb" | "sqlite"` (default: timescaledb)
**Plans**: TBD

Plans:
- [ ] 02-01: TBD
- [ ] 02-02: TBD

### Phase 3: DV Module
**Goal**: All Direktvermarktung functionality operates as an independent module that can be enabled/disabled without affecting Gateway or Optimizer, while maintaining real-time measurement compliance
**Depends on**: Phase 2
**Requirements**: DV-01, DV-02, DV-03, DV-04, DV-05
**Success Criteria** (what must be TRUE):
  1. DV module lives under modules/dv/ and registers its own routes, event listeners, and config schema via the module registry
  2. When a Direktvermarkter (LUOX) reads measurement values via Modbus slave, the response reflects data no older than 2x the poll interval (staleness guarantee)
  3. Curtailment signals (0%/100% and intermediate values) from the DV provider are detected, processed, and forwarded as control intents within one poll cycle
  4. Disabling the DV module in config removes all DV functionality with zero runtime footprint -- no DV routes, no DV event listeners, no DV state
  5. The DV module emits structured intents to the event bus (for later arbitration) instead of calling hardware write functions directly
**Plans**: TBD

Plans:
- [ ] 03-01: TBD
- [ ] 03-02: TBD

### Phase 4: Optimizer Core
**Goal**: DVhub can orchestrate multiple external optimizers (EOS, EMHASS) through a pluggable adapter pattern, receive optimization plans, normalize them to a canonical format, score them, and select the best plan
**Depends on**: Phase 2
**Requirements**: OPT-01, OPT-02, OPT-04, OPT-08, OPT-11, SEC-02, SEC-03
**Success Criteria** (what must be TRUE):
  1. EOS adapter sends canonical input to EOS, receives optimization results, validates the response against a known schema, and normalizes output to canonical 15-min slot plans
  2. EMHASS adapter provides equivalent functionality with EMHASS-specific data format translation
  3. Plan engine stores received plans, scores them using a configurable metric, and selects a winner -- the winning plan is visible on the dashboard
  4. Optimizer containers are version-pinned (never :latest) and adapter startup logs a warning if the detected optimizer version is untested
  5. No optimizer communication blocks the event loop -- all outbound HTTP calls use fire-and-forget with 5-second timeouts, and the poll loop continues uninterrupted during optimization runs
**Plans**: TBD

Plans:
- [ ] 04-01: TBD
- [ ] 04-02: TBD
- [ ] 04-03: TBD

### Phase 5: External Integrations
**Goal**: DVhub integrates with EVCC for EV charging coordination, ingests forecasts from multiple sources, supports advanced German tariff models, and prepares for MISPEL regulation
**Depends on**: Phase 4
**Requirements**: OPT-03, OPT-05, OPT-06, OPT-07, OPT-09, OPT-10
**Success Criteria** (what must be TRUE):
  1. EVCC bridge reads loadpoint state (mode, power, SoC, plan) from EVCC REST API and displays EV charging data in the energy flow and cost calculations
  2. Forecast broker ingests PV and load forecasts from EOS/EMHASS optimization results and makes them available for dashboard display and plan evaluation
  3. Grid import optimization supports dynamic tariffs (EPEX), multi-window tariffs (Octopus-style), fixed prices, and Paragraph 14a Module 3 time-variable network charges
  4. MISPEL/Pauschaloption data model tracks energy provenance (PV vs grid) and annual cap (500 kWh/kWp) -- ready for activation when BNetzA rules finalize
  5. History data aggregates telemetry from all connected endpoints (inverter, DV, optimizer, EVCC) into a unified queryable store
**Plans**: TBD

Plans:
- [ ] 05-01: TBD
- [ ] 05-02: TBD
- [ ] 05-03: TBD

### Phase 6: Arbitration + Execution
**Goal**: All hardware control flows through an intent-based arbitration layer with fixed priority resolution, and an execution layer that logs every command with readback verification
**Depends on**: Phase 3, Phase 4
**Requirements**: EXEC-01, EXEC-02, EXEC-03, EXEC-04
**Success Criteria** (what must be TRUE):
  1. When DV curtailment (priority 2) and optimizer export plan (priority 4) conflict, the arbitrator selects DV curtailment and logs the optimizer plan as overridden
  2. No module writes to hardware directly -- all control flows through the execution layer via Device HAL, and any direct hardware write attempt is blocked or logged as a violation
  3. Every hardware command is logged with source, priority, target, value, and timestamp -- and a readback verification confirms the command was applied
  4. Deviation alerting fires when readback differs from commanded value by more than a configurable threshold
**Plans**: TBD

Plans:
- [ ] 06-01: TBD
- [ ] 06-02: TBD

### Phase 7: Deployment
**Goal**: DVhub deploys reliably in three modes (native-only, hybrid, full-Docker) with the hybrid mode as recommended default, and external optimizers run as managed Docker containers with resource limits
**Depends on**: Phase 4
**Requirements**: DEPLOY-01, DEPLOY-02, DEPLOY-03, DEPLOY-04, DEPLOY-05, DEPLOY-06
**Success Criteria** (what must be TRUE):
  1. Hybrid deployment works: DVhub runs natively via systemd while EOS/EMHASS/EVCC run as Docker Compose services with CPU and memory limits enforced
  2. Native-only installation works for DV-only users without Docker dependency
  3. Full-Docker mode runs the entire stack including DVhub in containers for x86 server deployments
  4. Compose-manager in DVhub can start, stop, and check health of optimizer containers, and optimizer runs are staggered to avoid concurrent CPU saturation on Pi
  5. install.sh uses npm ci with a committed lockfile for reproducible deployments on both ARM and x86
**Plans**: TBD

Plans:
- [ ] 07-01: TBD
- [ ] 07-02: TBD

### Phase 8: UI Modernization
**Goal**: Dashboard is rebuilt with Preact+HTM components providing animated power flow, market price visualization, module configuration, and mobile-responsive operation -- all without a build step
**Depends on**: Phase 5, Phase 6
**Requirements**: UI-01, UI-02, UI-03, UI-04, UI-05, UI-06, UI-07, UI-08, UI-09, ARCH-03
**Success Criteria** (what must be TRUE):
  1. Dashboard renders an animated power flow diagram showing PV, battery, grid, load, and EV with directional indicators and magnitude-proportional visualization
  2. EPEX prices display at 15-minute resolution (96 slots/day) with price overlay on the energy timeline chart
  3. Setup wizard allows module activation/deactivation (DV, Optimizer) and all configuration parameters are accessible through the settings UI
  4. Autarky rate (Autarkiegrad) and self-consumption rate (Eigenverbrauchsquote) display as prominent dashboard metrics
  5. All dashboard pages are mobile-responsive and usable on phone screens without horizontal scrolling
**Plans**: TBD

Plans:
- [ ] 08-01: TBD
- [ ] 08-02: TBD
- [ ] 08-03: TBD

## Progress

**Execution Order:**
Phases execute in numeric order. Phases 3 and 4 share Phase 2 as dependency and are independent of each other. Phase 6 requires both Phase 3 and Phase 4.

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundation | 0/3 | Not started | - |
| 2. Data Architecture | 0/2 | Not started | - |
| 3. DV Module | 0/2 | Not started | - |
| 4. Optimizer Core | 0/3 | Not started | - |
| 5. External Integrations | 0/3 | Not started | - |
| 6. Arbitration + Execution | 0/2 | Not started | - |
| 7. Deployment | 0/2 | Not started | - |
| 8. UI Modernization | 0/3 | Not started | - |
