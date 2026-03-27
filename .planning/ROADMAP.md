# Roadmap: DVhub Server.js Monolith Decomposition (C1)

## Overview

Transform server.js from a 3,669-line monolith into a ~500-line orchestrator by extracting 7 focused modules in leaf-first dependency order. Each phase leaves the system fully functional with all 39 tests passing. The extraction proceeds from pure utilities and stateless functions (lowest risk) through I/O modules and polling, to the high-risk automation brain, and finally the HTTP layer -- always respecting the dependency graph so each phase builds only on previously-verified modules.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Foundation and Leaf Module** - Establish DI contract, extract utilities and user-energy-pricing as validation (completed 2026-03-26)
- [x] **Phase 2: I/O Modules** - Extract modbus-server and epex-fetch (self-contained data acquisition) (completed 2026-03-26)
- [x] **Phase 3: Polling** - Extract device polling loop with energy integration (completed 2026-03-27)
- [x] **Phase 4: Automation Core** - Extract market-automation-builder and schedule-eval (highest risk) (completed 2026-03-27)
- [x] **Phase 5: HTTP Layer and Orchestrator Cleanup** - Extract routes-api and reduce server.js to 926-line orchestrator (completed 2026-03-27)

## Phase Details

### Phase 1: Foundation and Leaf Module
**Goal**: Modules can receive dependencies via a proven DI contract, and the first stateless extraction validates the pattern end-to-end
**Depends on**: Nothing (first phase)
**Requirements**: FOUND-01, FOUND-02, FOUND-03, MODX-01
**Success Criteria** (what must be TRUE):
  1. server-utils.js exists and all pure utility functions (nowIso, fmtTs, berlinDateString, addDays, localMinutesOfDay, gridDirection, u16, s16, parseBody, roundCtKwh, resolveLogLimit, shared constants) are importable from it
  2. The DI context object shape `{ state, getCfg, transport, pushLog, telemetrySafeWrite, persistConfig }` is documented and used as template for all subsequent extractions
  3. getCfg() getter pattern works correctly -- config changes via /api/config POST are immediately visible to modules using getCfg() (no stale closures)
  4. user-energy-pricing.js exports pure functions (effectiveBatteryCostCtKwh, slotComparison, resolveImportPriceCtKwhForSlot) and server.js imports them instead of containing them inline
  5. All 39 test files pass (`npm test`) and all API endpoints return identical responses
**Plans:** 2 plans

Plans:
- [x] 01-01-PLAN.md -- Extract server-utils.js (pure utility functions + constants) from server.js
- [x] 01-02-PLAN.md -- Document DI context, extract user-energy-pricing.js, update test wiring

### Phase 2: I/O Modules
**Goal**: Self-contained I/O subsystems (Modbus TCP server and EPEX price fetching) operate as independent modules with proper lifecycle management
**Depends on**: Phase 1
**Requirements**: MODX-02, MODX-03
**Success Criteria** (what must be TRUE):
  1. modbus-server.js exports a createModbusServer factory that returns an object with start() and close() lifecycle methods, and the Modbus TCP server on port 1502 accepts connections and processes frames identically to before
  2. epex-fetch.js exports a createEpexFetcher factory that returns fetchEpexDay(), fetchVrmForecast(), and epexNowNext(), and EPEX price fetching works on-demand and on schedule
  3. Both modules receive dependencies via the DI context (no direct imports of server.js internals)
  4. Graceful shutdown calls close()/stop() on both modules without timer or socket leaks
  5. All 39 test files pass and no new npm dependencies introduced
**Plans:** 2 plans

Plans:
- [x] 02-01-PLAN.md -- Extract modbus-server.js factory, activate DI ctx in server.js
- [x] 02-02-PLAN.md -- Extract epex-fetch.js factory with timer lifecycle, update test

### Phase 3: Polling
**Goal**: Device polling runs as an independent module while preserving exact mutation ordering between meter reads and energy integral updates
**Depends on**: Phase 1, Phase 2
**Requirements**: MODX-04
**Success Criteria** (what must be TRUE):
  1. polling.js exports a createPoller factory that returns pollMeter(), pollPoint(), updateEnergyIntegrals(), start(), and stop() methods
  2. pollMeter and updateEnergyIntegrals remain in the same module and execute in correct order (mutation ordering preserved)
  3. Polling loop reads Victron battery, grid meter, and solar values at correct intervals and state.meter/state.victron/state.energy update correctly
  4. Cross-module wiring works: polling calls epexNowNext (from epex-fetch) and resolveImportPriceCtKwhForSlot (from user-energy-pricing) via injected references
  5. All 39 test files pass and graceful shutdown stops all polling timers cleanly
**Plans:** 2/2 plans complete

Plans:
- [x] 03-01-PLAN.md -- Create polling.js factory module (loadEnergy + createPoller with all polling functions)
- [x] 03-02-PLAN.md -- Wire polling.js into server.js, remove extracted functions, update lifecycle

### Phase 4: Automation Core
**Goal**: The schedule evaluation brain and market automation rule builder operate as extracted modules while preserving exact hardware control behavior and async chains
**Depends on**: Phase 1, Phase 2, Phase 3
**Requirements**: MODX-05, MODX-06
**Success Criteria** (what must be TRUE):
  1. market-automation-builder.js exports a createMarketAutomationBuilder factory with buildSmallMarketAutomationRules() and regenerateSmallMarketAutomationRules() that produce identical slot allocations and MILP results as before
  2. schedule-eval.js exports a createScheduleEvaluator factory with evaluateSchedule(), applyControlTarget(), setForcedOff(), clearForcedOff(), start(), and stop() methods
  3. applyControlTarget writes correct control signals to hardware via injected transport -- DV control target values match pre-extraction behavior exactly
  4. schedule-eval receives market-automation-builder functions via DI (not direct import) -- no circular dependencies between any extracted modules
  5. All 39 test files pass, config hot-reload propagates to both modules, and graceful shutdown stops the 15-second evaluation cycle cleanly
**Plans:** 2/2 plans complete

Plans:
- [x] 04-01-PLAN.md -- Extract market-automation-builder.js (SMA constants + createMarketAutomationBuilder factory), wire into server.js
- [x] 04-02-PLAN.md -- Extract schedule-eval.js (createScheduleEvaluator factory with timer lifecycle), wire into server.js

### Phase 5: HTTP Layer and Orchestrator Cleanup
**Goal**: All ~45 API endpoints are served from an extracted routes module and server.js is a clean ~680-line orchestrator that owns only init, state, config, wiring, and shutdown
**Depends on**: Phase 1, Phase 2, Phase 3, Phase 4
**Requirements**: MODX-07, ORCH-01, ORCH-02
**Success Criteria** (what must be TRUE):
  1. routes-api.js exports a createApiRoutes factory returning a handleRequest(req, res, url) function that handles all ~45 /api/* and /dv/* endpoints with identical URLs, request formats, and response formats
  2. server.js is approximately 680 lines and reads top-to-bottom as: imports, config, state, module initialization, HTTP server creation, polling loop start, graceful shutdown handler
  3. Graceful shutdown calls stop()/close() on ALL modules (poller, scheduler, modbus server, epex fetcher) -- process exits cleanly on SIGTERM with no timer or socket leaks
  4. Auth, rate limiting, CORS, and security headers remain functional (CORS + security headers in orchestrator, checkAuth + checkRateLimit in routes)
  5. All tests pass, all API endpoints return identical responses, no circular dependencies exist between any modules (verifiable with madge --circular)
**Plans**: 3 plans

Plans:
- [x] 05-01-PLAN.md -- Create routes-api.js factory, extract simple/read-only routes, auth, static serving
- [x] 05-02-PLAN.md -- Move admin/config/mutation routes, wire ctx callbacks for side effects
- [x] 05-03-PLAN.md -- Orchestrator cleanup: remove dead imports, verify structure, circular dep check

## Cross-Cutting Quality Gates

These requirements apply as validation criteria to EVERY phase:

- **QUAL-01**: All 39 existing test files remain green after each extraction (`npm test`)
- **QUAL-02**: All API endpoints retain exact URLs, request formats, and response formats (100% backward compatibility)
- **QUAL-03**: No new npm dependencies introduced at any point
- **QUAL-04**: No circular import dependencies between extracted modules
- **QUAL-05**: Config hot-reload continues working -- changes via /api/config POST are immediately visible to all modules via getCfg()

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3 -> 4 -> 5

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundation and Leaf Module | 2/2 | Complete | 2026-03-26 |
| 2. I/O Modules | 2/2 | Complete | 2026-03-26 |
| 3. Polling | 2/2 | Complete | 2026-03-27 |
| 4. Automation Core | 2/2 | Complete | 2026-03-27 |
| 5. HTTP Layer and Orchestrator Cleanup | 3/3 | Complete | 2026-03-27 |
