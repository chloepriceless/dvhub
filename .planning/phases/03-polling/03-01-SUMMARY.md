---
phase: 03-polling
plan: 01
subsystem: polling
tags: [modbus, mqtt, energy-integration, factory-pattern, serial-task-runner]

# Dependency graph
requires:
  - phase: 01-utils
    provides: berlinDateString, gridDirection, u16, s16 utilities
  - phase: 01-utils
    provides: resolveImportPriceCtKwhForSlot pricing function
  - phase: 02-io
    provides: createSerialTaskRunner, normalizePollIntervalMs runtime helpers
  - phase: 02-io
    provides: factory pattern reference from epex-fetch.js
provides:
  - "polling.js module with loadEnergy export and createPoller factory"
  - "Device polling lifecycle (start/stop/requestPoll)"
  - "Energy integration with cost/revenue tracking"
  - "Crash-safe energy state persistence (atomic write)"
  - "ctx.onPollComplete callback for telemetry decoupling"
affects: [03-polling (plan 02 wiring), 04-automation, 05-integration]

# Tech tracking
tech-stack:
  added: []
  patterns: [factory-with-DI-context, recursive-setTimeout-with-stopping-guard, atomic-file-write]

key-files:
  created: [dvhub/polling.js]
  modified: []

key-decisions:
  - "schedulePollLoop uses if (!stopping) guard instead of .finally() for graceful shutdown"
  - "Telemetry decoupled via ctx.onPollComplete callback instead of direct liveTelemetryBuffer/publishRuntimeSnapshot access"
  - "loadEnergy kept as standalone export (not inside factory) for startup-time usage"

patterns-established:
  - "Factory closure pattern: private functions + start/stop lifecycle + DI context"
  - "Config hot-reload: getCfg() called inside function bodies, never captured at factory creation"
  - "Timer lifecycle: single pollTimeout variable reassigned each cycle (not array of handles)"

requirements-completed: [MODX-04]

# Metrics
duration: 3min
completed: 2026-03-27
---

# Phase 3 Plan 1: Polling Module Extraction Summary

**Device polling factory (createPoller) with meter/Victron polling, energy integration, and crash-safe persistence extracted from server.js**

## Performance

- **Duration:** 3 min
- **Started:** 2026-03-27T00:05:34Z
- **Completed:** 2026-03-27T00:08:41Z
- **Tasks:** 1
- **Files modified:** 1

## Accomplishments
- Created dvhub/polling.js with complete device polling subsystem extracted from server.js
- loadEnergy standalone export for restoring energy state at startup
- createPoller(ctx) factory returning { start, stop, requestPoll } with 10 closure-private functions
- Telemetry decoupled via ctx.onPollComplete callback (no direct liveTelemetryBuffer/publishRuntimeSnapshot)
- All config access via getCfg() for hot-reload safety
- Energy persistence uses atomic write (tmp + rename) for crash safety

## Task Commits

Each task was committed atomically:

1. **Task 1: Create polling.js with loadEnergy export and createPoller factory** - `4338146` (feat)

## Files Created/Modified
- `dvhub/polling.js` - Device polling factory module with meter polling, Victron point polling, energy integration, and persistence

## Decisions Made
- schedulePollLoop uses `if (!stopping)` guard instead of `.finally()` + unconditional reschedule for graceful shutdown support
- Telemetry decoupled via ctx.onPollComplete callback -- server.js will wire this to liveTelemetryBuffer/publishRuntimeSnapshot in plan 03-02
- loadEnergy remains a standalone named export (not inside createPoller) since it needs to run once at startup before the poller is created

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- polling.js ready for wiring into server.js (plan 03-02)
- Server.js needs to: import { loadEnergy, createPoller }, create ctx with energyPath/onPollComplete/epexNowNext, replace inline functions with factory calls
- No blockers for plan 03-02

---
*Phase: 03-polling*
*Completed: 2026-03-27*
