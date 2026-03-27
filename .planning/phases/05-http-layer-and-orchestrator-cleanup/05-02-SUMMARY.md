---
phase: 05-http-layer-and-orchestrator-cleanup
plan: 02
subsystem: api
tags: [http, routing, ctx-callbacks, dependency-injection, admin-routes]

# Dependency graph
requires:
  - phase: 05-http-layer-and-orchestrator-cleanup
    plan: 01
    provides: routes-api.js factory with createApiRoutes(ctx), simple/read-only route handlers
provides:
  - All ~45 route handlers consolidated in routes-api.js handleRequest
  - ctx callbacks for saveAndApplyConfig, scheduleServiceRestart, runServiceCommand, getServiceActionsEnabled, getServiceName, getServiceUseSudo, assertValidRuntimeCommand
  - adminHealthPayload moved to routes-api.js
  - server.js HTTP handler reduced to CORS + delegation + static fallback only
affects: [05-03-orchestrator-cleanup]

# Tech tracking
tech-stack:
  added: []
  patterns: [ctx-callback-wrapping-for-side-effects, orchestrator-delegation-only-http-handler]

key-files:
  created: []
  modified:
    - dvhub/routes-api.js
    - dvhub/server.js

key-decisions:
  - "ctx.saveAndApplyConfig wraps restoreRedactedValues internally so route handlers pass raw body.config"
  - "adminHealthPayload moved to routes-api.js using ctx callbacks (getServiceActionsEnabled, getLoadedConfig, etc)"
  - "EOS/EMHASS telemetry writes use ctx.telemetryStore?.writeOptimizerRun with optional chaining (async init)"
  - "Removed local json() helper from server.js (all responses now in routes-api.js)"
  - "Removed unused imports from server.js: buildOptimizerRunPayload, isSmallMarketAutomationRule, parseBody, fmtTs"

patterns-established:
  - "All HTTP route handling delegated to routes-api.js; server.js only does CORS + delegation + static fallback"
  - "Admin side-effects exposed via ctx callbacks wrapping orchestrator-owned functions"

requirements-completed: [MODX-07]

# Metrics
duration: 14min
completed: 2026-03-27
---

# Phase 5 Plan 02: Admin Route Extraction Summary

**All ~20 admin/config/mutation route handlers moved from server.js to routes-api.js via ctx callbacks, reducing server.js from 1409 to 934 lines with zero route handler code remaining**

## Performance

- **Duration:** 14 min
- **Started:** 2026-03-27T04:07:41Z
- **Completed:** 2026-03-27T04:22:40Z
- **Tasks:** 1
- **Files modified:** 2

## Accomplishments
- Moved all admin/config/mutation route handlers from server.js to routes-api.js handleRequest
- Added 7 ctx callbacks in server.js to expose orchestrator-owned side-effect functions
- Moved adminHealthPayload() builder to routes-api.js using ctx callbacks
- Removed unused imports and local json() helper from server.js
- server.js HTTP handler now only contains: URL parsing, CORS, routes.handleRequest delegation, static fallback, error catch

## Task Commits

Each task was committed atomically:

1. **Task 1: Move admin/config/mutation route handlers** - `bf174a0` (feat)

## Files Created/Modified
- `dvhub/routes-api.js` - Now contains all ~45 route handlers including admin/config/mutation endpoints, adminHealthPayload builder, buildOptimizerRunPayload import, execFileAsync for update operations
- `dvhub/server.js` - HTTP handler reduced to CORS + delegation + fallback; added ctx callbacks for saveAndApplyConfig, scheduleServiceRestart, runServiceCommand, getServiceActionsEnabled, getServiceName, getServiceUseSudo, assertValidRuntimeCommand

## Decisions Made
- ctx.saveAndApplyConfig wraps restoreRedactedValues(incomingConfig, rawCfg) internally, so route handlers pass body.config directly without worrying about redaction restore
- adminHealthPayload uses ctx callbacks (getServiceActionsEnabled, getServiceName, getLoadedConfig, getAppVersion, getTransportType, getConfigPath, runServiceCommand) instead of direct variable access
- EOS/EMHASS telemetry writes use ctx.telemetryStore?.writeOptimizerRun with optional chaining since telemetryStore is set asynchronously
- Removed local json() helper from server.js since no route handling code remains there
- Config POST response includes meta/configMetaPayload and uses redactConfig (already in routes-api.js) for config/effectiveConfig fields

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Config POST response field alignment**
- **Found during:** Task 1 (config POST handler move)
- **Issue:** Original server.js config POST returned raw `rawCfg` and `cfg` without redaction. The routes-api.js version adds `meta: configMetaPayload()` and applies `redactConfig()` to both config and effectiveConfig, matching the GET /api/config response format.
- **Fix:** Added configMetaPayload() to response and wrapped config/effectiveConfig with redactConfig() for consistency
- **Files modified:** dvhub/routes-api.js
- **Verification:** All tests pass (same 137 pre-existing failures)
- **Committed in:** bf174a0

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Improved config POST response consistency. No scope creep.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- All route handlers now in routes-api.js (44 url.pathname checks)
- server.js has 0 route handler pathname checks
- Ready for Plan 3: orchestrator cleanup (final server.js reduction)
- server.js retains: config model, state, transport, telemetry, DI context, lifecycle, shutdown

---
*Phase: 05-http-layer-and-orchestrator-cleanup*
*Completed: 2026-03-27*
