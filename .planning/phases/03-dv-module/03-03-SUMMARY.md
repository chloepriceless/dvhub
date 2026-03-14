---
phase: 03-dv-module
plan: 03
subsystem: dv
tags: [modbus, module-lifecycle, init-destroy, gateway-cleanup, integration-test]

requires:
  - phase: 03-dv-module
    provides: "DV state, provider, Modbus slave (Plan 01), curtailment, intents, plugin (Plan 02)"
  - phase: 01-core-infra
    provides: "Module registry with initAll/destroyAll, event bus with BehaviorSubject streams"
provides:
  - "Complete DV module lifecycle (createDvModule) wiring all Plan 01/02 components"
  - "Gateway module with zero DV-specific code (functions, state, routes removed)"
  - "Integration tests proving DV enable/disable behavior"
affects: [06-arbitration]

tech-stack:
  added: []
  patterns: [module-lifecycle-wiring, plugin-wrapper-closure, registry-ctx-access]

key-files:
  created:
    - dvhub/test/dv-module-lifecycle.test.js
  modified:
    - dvhub/modules/dv/index.js
    - dvhub/modules/gateway/index.js
    - dvhub/modules/gateway/routes/control.js
    - dvhub/server.js

key-decisions:
  - "Plugin wrapper closure in init() captures opts without modifying server.js plugin registration"
  - "Registry added to initAll ctx so DV module can access gateway modbusProxy via ctx.registry.get('gateway')"
  - "Gateway exposes modbusProxy on module return object for cross-module access"
  - "Negative price protection DV calls replaced with comments (Phase 6 arbitration concern)"
  - "controlValue() references in gateway replaced with default 1 (producing) when DV not loaded"

patterns-established:
  - "Module cross-access: ctx.registry.get('name') for accessing other module instances during init"
  - "Plugin wrapper: closure capturing opts for server.js compatibility without modification"

requirements-completed: [DV-05]

duration: 7min
completed: 2026-03-14
---

# Phase 3 Plan 3: DV Module Lifecycle Wiring Summary

**Complete DV module lifecycle wiring all 6 components with init/destroy, gateway cleaned of 263 lines of DV code, and 8 integration tests proving enable/disable behavior**

## Performance

- **Duration:** 7 min
- **Started:** 2026-03-14T10:49:43Z
- **Completed:** 2026-03-14T10:56:43Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments
- DV module init wires provider, state, intent emitter, curtailment manager, modbus slave, telemetry subscription, frame handler, and lease timer in correct order
- DV module destroy reverses all init steps: stops lease timer, unsubscribes telemetry, nulls all references
- Gateway module cleaned of all DV-specific code: 263 lines removed (3093 to 2830), zero DV functions remain
- 8 integration tests verify module interface, lifecycle, frame handler registration, telemetry subscription, and gateway cleanup

## Task Commits

Each task was committed atomically:

1. **Task 1: Complete DV module lifecycle wiring** - `23cca30` (feat)
2. **Task 2: Remove DV code from gateway, add lifecycle tests** - `638a7af` (feat)

## Files Created/Modified
- `dvhub/modules/dv/index.js` - Rewritten from stub to full lifecycle (126 lines), wires all Plan 01/02 components
- `dvhub/modules/gateway/index.js` - Removed 12 DV functions, dvRegs state, DV ctrl state, DV route handlers, dead startModbusServer
- `dvhub/modules/gateway/routes/control.js` - Removed /dv/control-value route (now in DV module)
- `dvhub/server.js` - Added registry to initAll ctx for cross-module access
- `dvhub/test/dv-module-lifecycle.test.js` - 8 integration tests for module lifecycle and gateway cleanup

## Decisions Made
- Plugin wrapper closure: DV plugin opts captured in init() closure, so server.js fastify.register(mod.plugin) works without knowing about DV-specific opts
- Registry in ctx: Added registry to the ctx object passed to initAll so DV module can access gateway.modbusProxy via ctx.registry.get('gateway')
- Gateway modbusProxy exposure: Added modbusProxy property to gateway module return object, set during init, cleared during destroy
- Negative price protection: Removed direct applyDvVictronControl calls, left as Phase 6 arbitration concern (comments mark the integration points)
- Default controlValue: Gateway references to controlValue() replaced with constant 1 (normal/producing) since DV module owns curtailment state

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added registry to initAll ctx**
- **Found during:** Task 1
- **Issue:** ctx passed to initAll in server.js did not include registry, but DV module needs ctx.registry.get('gateway') to access modbusProxy
- **Fix:** Added registry to the ctx object in server.js bootstrapServer()
- **Files modified:** dvhub/server.js
- **Verification:** DV module init successfully accesses gateway modbusProxy in tests
- **Committed in:** 23cca30 (Task 1 commit)

**2. [Rule 3 - Blocking] Removed dead startModbusServer function**
- **Found during:** Task 2
- **Issue:** Old monolithic startModbusServer() still referenced processModbusFrame which was being removed
- **Fix:** Removed entirely (was dead code, replaced by modbusProxy in Phase 01-04)
- **Files modified:** dvhub/modules/gateway/index.js
- **Committed in:** 638a7af (Task 2 commit)

**3. [Rule 3 - Blocking] Removed setReg calls from gateway poll loop**
- **Found during:** Task 2
- **Issue:** Gateway poll loop (line 1195-1198) called setReg() to update DV registers after meter read, but setReg was removed
- **Fix:** Removed calls; DV module now updates registers via telemetry stream subscription
- **Files modified:** dvhub/modules/gateway/index.js
- **Committed in:** 638a7af (Task 2 commit)

---

**Total deviations:** 3 auto-fixed (3 blocking)
**Impact on plan:** All auto-fixes necessary for correct DV module lifecycle. No scope creep.

## Issues Encountered

- Pre-existing test failure in `dvhub/test/dv-control-readback-runtime.test.js`: test reads from `server.js` looking for functions that were moved to `gateway/index.js` during Phase 01-04. Not caused by this plan. Logged in deferred-items.md.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- DV module extraction complete (all 3 plans done)
- Phase 3 can be marked complete
- DV module ready for Phase 6 arbitration layer integration
- Gateway cleaned and ready for independent evolution

---
## Self-Check: PASSED
