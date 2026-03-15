---
phase: 11-backend-integration
plan: 02
subsystem: api
tags: [websocket, telemetry, config-save, sma, epex, costs, ctrl, keepalive]

requires:
  - phase: 11-backend-integration
    provides: API status field parity with keepalive and minSocPct
provides:
  - Extended WebSocket telemetry stream with costs/ctrl/keepalive fields
  - Config-save triggered SMA re-evaluation and EPEX refresh
affects: [12-schedule-ui, 13-status-display, 14-dv-dashboard]

tech-stack:
  added: []
  patterns:
    - "Config-save changedPaths propagation for selective downstream triggers"

key-files:
  created: []
  modified:
    - dvhub/modules/gateway/telemetry.js
    - dvhub/modules/gateway/index.js
    - dvhub/modules/gateway/routes/status.js

key-decisions:
  - "changedPaths passed from status route to onConfigSaved for selective trigger evaluation"
  - "SMA trigger uses startsWith match on schedule.smallMarketAutomation prefix"
  - "EPEX trigger uses exact match on epex.bzn and epex.enabled paths"

patterns-established:
  - "Config-save changedPaths propagation: route passes changedPaths array to onConfigSaved callback for selective re-evaluation"

requirements-completed: [INTEG-02, INTEG-03]

duration: 1min
completed: 2026-03-15
---

# Phase 11 Plan 02: Telemetry Extension & Config-Save Triggers Summary

**WebSocket telemetry extended with costs/ctrl/keepalive fields; config-save triggers SMA re-evaluation and EPEX refresh on relevant path changes**

## Performance

- **Duration:** 1 min
- **Started:** 2026-03-15T00:10:54Z
- **Completed:** 2026-03-15T00:11:58Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- WebSocket telemetry aggregate stream now includes costs, ctrl, and keepalive fields from each poll cycle
- Config-save handler passes changedPaths to onConfigSaved callback for selective downstream triggers
- SMA rules regenerated automatically when schedule.smallMarketAutomation config paths change
- EPEX day prices refreshed automatically when epex.bzn or epex.enabled changes
- Both triggers include pushLog calls for observability

## Task Commits

Each task was committed atomically:

1. **Task 1: Extend WS telemetry with costs, ctrl, keepalive** - `e46b997` (feat)
2. **Task 2: Config-save triggers SMA re-eval and EPEX refresh** - `93b9861` (feat)

## Files Created/Modified
- `dvhub/modules/gateway/telemetry.js` - Added costs/ctrl/keepalive to telemetry$.next() aggregate stream
- `dvhub/modules/gateway/index.js` - Extended both poll loop and init telemetryStreams.update() calls with costs/ctrl/keepalive; updated onConfigSaved to accept changedPaths and trigger SMA/EPEX
- `dvhub/modules/gateway/routes/status.js` - Pass changedPaths to onConfigSaved callback

## Decisions Made
- changedPaths passed from status route to onConfigSaved for selective trigger evaluation (avoids unnecessary SMA/EPEX re-evaluation on unrelated config changes)
- SMA trigger uses startsWith match on schedule.smallMarketAutomation prefix to catch all sub-paths
- EPEX trigger uses exact match on epex.bzn and epex.enabled (only these two paths warrant a price refresh)

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- All backend integration complete: API status fields, telemetry stream, and config-save triggers
- Ready for Phase 12 (Schedule UI) which consumes telemetry stream data
- Ready for Phase 14 (DV Dashboard) which uses costs/ctrl/keepalive from WebSocket

---
*Phase: 11-backend-integration*
*Completed: 2026-03-15*

## Self-Check: PASSED
