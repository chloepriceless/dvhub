---
phase: 02-i-o-modules
plan: 02
subsystem: epex
tags: [epex-prices, vrm-forecast, factory-pattern, dependency-injection, timer-lifecycle]

# Dependency graph
requires:
  - phase: 02-i-o-modules
    plan: 01
    provides: Activated DI context (ctx) in server.js, factory+DI wiring pattern
  - phase: 01-foundation-and-leaf-module
    provides: server-utils.js with berlinDateString/addDays, telemetry-runtime.js with buildPriceTelemetrySamples
provides:
  - dvhub/epex-fetch.js factory module with createEpexFetcher(ctx)
  - ctx.epexNowNext for downstream modules (polling, schedule-eval)
  - ctx.telemetryStore and ctx.publishRuntimeSnapshot on DI context
  - Complete Phase 2 I/O module extraction
affects: [03-polling-engine, 04-automation-core, 05-routes-and-integration]

# Tech tracking
tech-stack:
  added: []
  patterns: [timer-lifecycle-start-stop, getCfg-inside-function-body, ctx-extension-after-async-init]

key-files:
  created: [dvhub/epex-fetch.js]
  modified: [dvhub/server.js, dvhub/test/epex-summary-runtime.test.js]

key-decisions:
  - "ctx.telemetryStore and ctx.publishRuntimeSnapshot added after async telemetry init (not in ctx literal) because telemetryStore is created asynchronously"
  - "All 5 bare epexNowNext() calls in server.js updated to epex.epexNowNext() including buildCurrentRuntimeSnapshot, evaluateSchedule, userEnergyPricingSummary, and API routes"
  - "buildPriceTelemetrySamples import removed from server.js since only usage was in fetchEpexDay (now in epex-fetch.js)"

patterns-established:
  - "Timer lifecycle: start() creates all intervals/timeouts, stop() clears both clearInterval+clearTimeout on each handle"
  - "ctx extension after async init: ctx.telemetryStore = telemetryStore placed after await createTelemetryStoreIfEnabled()"
  - "Module public method on ctx: ctx.epexNowNext = epex.epexNowNext for cross-module access"

requirements-completed: [MODX-03]

# Metrics
duration: 6min
completed: 2026-03-26
---

# Phase 2 Plan 02: EPEX Fetch Extraction Summary

**EPEX price fetching and VRM solar forecast extracted into epex-fetch.js factory module with start()/stop() timer lifecycle, wired via DI context**

## Performance

- **Duration:** 6 min
- **Started:** 2026-03-26T21:58:45Z
- **Completed:** 2026-03-26T22:05:21Z
- **Tasks:** 2
- **Files modified:** 3 (1 created, 2 modified)

## Accomplishments
- Created dvhub/epex-fetch.js (246 lines) as a factory module exporting createEpexFetcher(ctx)
- Extracted 6 functions from server.js: fetchEpexFromDvhubApi, fetchEpexFromEnergyCharts, fetchEpexDay, fetchVrmForecast, epexNowNext, and VRM_FORECAST_API constant
- Wired epex.start()/stop() lifecycle into IS_RUNTIME_PROCESS and gracefulShutdown
- Extended ctx with telemetryStore, publishRuntimeSnapshot, and epexNowNext for downstream modules
- Updated epex-summary-runtime.test.js to read from epex-fetch.js instead of server.js
- Updated 5 bare epexNowNext() calls and 2 API route calls to use epex module methods
- Removed unused buildPriceTelemetrySamples import from server.js
- server.js reduced from ~3390 to 3199 lines (~191 lines removed)
- Zero test regressions (308 pass / 137 pre-existing fail, identical before and after)

## Task Commits

Each task was committed atomically:

1. **Task 1: Create epex-fetch.js factory module** - `55a55be` (feat)
2. **Task 2: Wire epex-fetch into server.js and update test** - `f7b88c5` (feat)

**Plan metadata:** pending (docs: complete plan)

## Files Created/Modified
- `dvhub/epex-fetch.js` - EPEX price fetching and VRM solar forecast factory module (createEpexFetcher) with timer lifecycle
- `dvhub/server.js` - Added epex-fetch import, created epex instance, extended ctx, removed 6 EPEX functions + timer setup, updated all references
- `dvhub/test/epex-summary-runtime.test.js` - Updated source path from server.js to epex-fetch.js

## Decisions Made
- ctx.telemetryStore and ctx.publishRuntimeSnapshot set after async telemetry init (line 3010-3011) rather than in ctx literal, because telemetryStore is created asynchronously via createTelemetryStoreIfEnabled()
- All 5 bare epexNowNext() calls throughout server.js updated to epex.epexNowNext() (in buildCurrentRuntimeSnapshot, evaluateSchedule, userEnergyPricingSummary, and control evaluation)
- Removed buildPriceTelemetrySamples from server.js telemetry-runtime.js import since its only usage was in fetchEpexDay (now in epex-fetch.js)
- API routes /api/epex/refresh and /api/forecast/refresh updated to call epex.fetchEpexDay() and epex.fetchVrmForecast() respectively

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Updated API route references to use epex module methods**
- **Found during:** Task 2 (Wire epex-fetch into server.js)
- **Issue:** /api/epex/refresh (line 2829) calls fetchEpexDay() and /api/forecast/refresh (line 2674) calls fetchVrmForecast() -- these bare function calls would break after deletion
- **Fix:** Updated to epex.fetchEpexDay() and epex.fetchVrmForecast()
- **Files modified:** dvhub/server.js
- **Verification:** grep confirms no remaining bare fetchEpexDay/fetchVrmForecast references
- **Committed in:** f7b88c5 (Task 2 commit)

**2. [Rule 3 - Blocking] Updated 5 bare epexNowNext() calls to epex.epexNowNext()**
- **Found during:** Task 2 (Wire epex-fetch into server.js)
- **Issue:** Plan mentioned updating the call in userEnergyPricingSummary and checking for others; found 5 total call sites across buildCurrentRuntimeSnapshot, evaluateSchedule, userEnergyPricingSummary, and control evaluation
- **Fix:** replace_all on epexNowNext() -> epex.epexNowNext()
- **Files modified:** dvhub/server.js
- **Verification:** grep confirms all 5 calls updated, no bare epexNowNext() remaining
- **Committed in:** f7b88c5 (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (2 blocking)
**Impact on plan:** Both auto-fixes were necessary to prevent runtime errors from deleted function references. Plan anticipated the userEnergyPricingSummary update but additional call sites needed updating. No scope creep.

## Issues Encountered
None - extraction was straightforward.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Phase 2 is now complete: both I/O modules (modbus-server.js and epex-fetch.js) extracted
- DI context fully wired with all necessary fields for downstream modules
- ctx.epexNowNext available for Phase 3 polling engine and Phase 4 schedule-eval
- Factory + DI pattern established and proven across two modules
- server.js reduced from original ~3669 to 3199 lines (470 lines extracted in Phase 2)
- 137 pre-existing test failures are unrelated to this extraction (branding/UI changes)

---
## Self-Check: PASSED

All files exist, all commits verified.

---
*Phase: 02-i-o-modules*
*Completed: 2026-03-26*
