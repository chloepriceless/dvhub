---
phase: 03-polling
plan: 02
subsystem: polling
tags: [modbus, mqtt, energy-integration, factory-pattern, di-wiring, lifecycle]

# Dependency graph
requires:
  - phase: 03-polling
    plan: 01
    provides: "polling.js module with loadEnergy export and createPoller factory"
  - phase: 02-io
    provides: "DI context pattern, ctx object wiring from epex-fetch.js"
provides:
  - "server.js fully wired to polling.js via DI context"
  - "Polling implementation completely removed from server.js"
  - "poller.start()/stop()/requestPoll() lifecycle in orchestrator"
  - "ctx.onPollComplete callback wiring for telemetry decoupling"
affects: [04-automation, 05-integration]

# Tech tracking
tech-stack:
  added: []
  patterns: [di-context-wiring, factory-lifecycle-integration, closure-callback-for-telemetry]

key-files:
  created: []
  modified: [dvhub/server.js, dvhub/test/dv-control-readback-runtime.test.js]

key-decisions:
  - "ctx.onPollComplete callback placed in async init block (after telemetryStore) -- liveTelemetryBuffer captured by reference via closure, works because callback invoked later at poll time"
  - "Removed createSerialTaskRunner and normalizePollIntervalMs imports from server.js (only used by deleted polling code)"

patterns-established:
  - "Lifecycle delegation: orchestrator calls factory.start()/stop(), never manages timers directly"
  - "Callback telemetry bridge: ctx.onPollComplete closure captures module-level vars by reference"

requirements-completed: [MODX-04]

# Metrics
duration: 6min
completed: 2026-03-27
---

# Phase 3 Plan 2: Polling Wiring into Server.js Summary

**Server.js wired to polling.js via DI context with 294 lines removed (10 functions + poll infrastructure replaced by poller.start()/stop()/requestPoll())**

## Performance

- **Duration:** 6 min
- **Started:** 2026-03-27T00:12:02Z
- **Completed:** 2026-03-27T00:18:31Z
- **Tasks:** 1
- **Files modified:** 2

## Accomplishments
- Wired polling.js into server.js: import, createPoller(ctx), ctx.requestPoll, ctx.onPollComplete, poller.start()/stop()
- Deleted 10 extracted functions from server.js: persistEnergy, loadEnergy, pointFromRegs, pollPoint, buildDvControlReadbackPollConfig, buildDvControlReadbackPolls, pollDvControlReadback, updateEnergyIntegrals, pollMeter, schedulePollLoop/requestPollMeter
- Removed unused imports: createSerialTaskRunner, normalizePollIntervalMs, MIN_POLL_INTERVAL_MS, effectivePollIntervalMs
- server.js reduced from 3199 to 2905 lines (294 lines removed)
- All 376 tests pass with identical results (308 pass, 68 fail -- same pre-existing failures)

## Task Commits

Each task was committed atomically:

1. **Task 1: Add polling.js import and wire poller into server.js DI context** - `3b2dc03` (feat)

## Files Created/Modified
- `dvhub/server.js` - Orchestrator now imports polling.js, wires poller via DI, uses lifecycle methods
- `dvhub/test/dv-control-readback-runtime.test.js` - Updated to read buildDvControlReadbackPollConfig from polling.js instead of server.js

## Decisions Made
- ctx.onPollComplete callback placed in async init block after telemetryStore creation -- liveTelemetryBuffer is captured by closure reference (not by value), so it works correctly when invoked later during poll cycles
- Removed createSerialTaskRunner and normalizePollIntervalMs from runtime-performance.js import since they are no longer used in server.js (both moved to polling.js)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Updated dv-control-readback test to read from polling.js**
- **Found during:** Task 1 (verification step)
- **Issue:** Test extracted buildDvControlReadbackPollConfig/buildDvControlReadbackPolls by parsing server.js source text; functions no longer in server.js after extraction
- **Fix:** Changed test to read from polling.js instead of server.js
- **Files modified:** dvhub/test/dv-control-readback-runtime.test.js
- **Verification:** Test passes (2/2 assertions)
- **Committed in:** 3b2dc03 (part of task commit)

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Necessary fix for test that directly parsed server.js source. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Phase 3 (Polling) complete -- both plans executed
- server.js now at 2905 lines (down from 3199 before Phase 3, down from 3669 at project start)
- Ready for Phase 4 (Automation Core) -- schedule-eval extraction
- No blockers for Phase 4

---
*Phase: 03-polling*
*Completed: 2026-03-27*
