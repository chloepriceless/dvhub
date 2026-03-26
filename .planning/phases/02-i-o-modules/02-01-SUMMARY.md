---
phase: 02-i-o-modules
plan: 01
subsystem: modbus
tags: [modbus-tcp, factory-pattern, dependency-injection, server-extraction]

# Dependency graph
requires:
  - phase: 01-foundation-and-leaf-module
    provides: server-utils.js with u16/s16 exports, DI context template (commented out)
provides:
  - dvhub/modbus-server.js factory module with createModbusServer(ctx)
  - Activated DI context object (ctx) in server.js
  - Established factory + DI wiring pattern for all subsequent extractions
affects: [02-02-epex-fetch, 03-polling-engine, 04-automation-core, 05-routes-and-integration]

# Tech tracking
tech-stack:
  added: []
  patterns: [factory-module-with-DI-context, ctx-getter-pattern-for-cfg, lifecycle-start-close]

key-files:
  created: [dvhub/modbus-server.js]
  modified: [dvhub/server.js]

key-decisions:
  - "Inlined setReg calls in server.js meter polling (state.dvRegs[addr] = u16(val)) since setReg moved to modbus-server.js but was still called from polling code"
  - "Kept net import in server.js despite no remaining usage (conservative per plan instructions)"
  - "Placed ctx definition after controlValue() function (line 1151) to ensure all injected functions are defined"

patterns-established:
  - "Factory with DI: createXxx(ctx) receives shared context, returns {start, close} lifecycle"
  - "ctx.getCfg() getter pattern: never capture cfg directly, always call getCfg() inside function bodies"
  - "ctx extension: after createXxx(ctx), extend ctx with module public methods for downstream consumers"

requirements-completed: [MODX-02]

# Metrics
duration: 5min
completed: 2026-03-26
---

# Phase 2 Plan 01: Modbus Server Extraction Summary

**Modbus TCP server extracted into modbus-server.js factory module with activated DI context and ctx.setForcedOff/clearForcedOff/expireLeaseIfNeeded delegation**

## Performance

- **Duration:** 5 min
- **Started:** 2026-03-26T21:50:43Z
- **Completed:** 2026-03-26T21:56:00Z
- **Tasks:** 1
- **Files modified:** 2 (1 created, 1 modified)

## Accomplishments
- Created dvhub/modbus-server.js (162 lines) as a factory module exporting createModbusServer(ctx)
- Activated the DI context object in server.js (was a commented-out template from Phase 1)
- Wired modbus.start()/close() lifecycle into IS_RUNTIME_PROCESS and gracefulShutdown
- Replaced 4 bare setForcedOff/clearForcedOff calls with ctx.setForcedOff/ctx.clearForcedOff
- Replaced bare expireLeaseIfNeeded() with ctx.expireLeaseIfNeeded() in processModbusFrame
- Removed 8 functions from server.js (setReg, getReg, buildException, buildReadResp, handleWriteSignal, rememberModbusQuery, processModbusFrame, startModbusServer)
- Zero test regressions (308 pass / 137 pre-existing fail, identical before and after)

## Task Commits

Each task was committed atomically:

1. **Task 1: Create modbus-server.js and activate ctx in server.js** - `856db70` (feat)

**Plan metadata:** pending (docs: complete plan)

## Files Created/Modified
- `dvhub/modbus-server.js` - Modbus TCP server factory module (createModbusServer) handling FC3/4/6/16 frames
- `dvhub/server.js` - Activated ctx object, added import, wired modbus lifecycle, removed extracted functions, inlined setReg calls

## Decisions Made
- Inlined setReg calls at lines 1522-1525 of server.js as `state.dvRegs[addr] = u16(val)` since setReg was moved to modbus-server.js but server.js meter polling code still needed to write registers
- Kept `import net from 'node:net'` in server.js despite no remaining usage (plan explicitly instructed to leave it)
- Placed ctx definition after controlValue() (after all referenced functions are defined) to avoid temporal dead zone issues

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Inlined setReg calls in server.js polling code**
- **Found during:** Task 1 (Delete Modbus functions from server.js)
- **Issue:** server.js lines 1522-1525 call setReg() for meter register updates, but setReg was moved to modbus-server.js
- **Fix:** Replaced `setReg(addr, val)` with `state.dvRegs[addr] = u16(val)` (4 call sites)
- **Files modified:** dvhub/server.js
- **Verification:** npm test shows identical pass/fail counts before and after
- **Committed in:** 856db70 (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Essential fix to prevent runtime error. No scope creep.

## Issues Encountered
None - extraction was straightforward.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- DI context (ctx) is now activated and ready for all subsequent module extractions
- The factory + DI pattern is established: createXxx(ctx) returns {start, close}
- Plan 02-02 (EPEX fetch extraction) can proceed, building on the same ctx object
- 137 pre-existing test failures are unrelated to this extraction (branding/UI changes)

---
*Phase: 02-i-o-modules*
*Completed: 2026-03-26*
