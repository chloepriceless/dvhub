---
phase: 04-automation-core
plan: 02
subsystem: api
tags: [schedule-eval, hardware-control, timer-lifecycle, di-context, victron, modbus]

# Dependency graph
requires:
  - phase: 04-automation-core
    plan: 01
    provides: "market-automation-builder.js with isSmallMarketAutomationRule, SLOT_DURATION_MS, ctx.regenerateSmallMarketAutomationRules"
  - phase: 03-polling
    provides: "DI context pattern (ctx object), timer lifecycle with stopping guard"
provides:
  - "schedule-eval.js module with createScheduleEvaluator factory"
  - "Hardware control functions: applyDvVictronControl, applyControlTarget via DI context"
  - "Schedule evaluation brain: evaluateSchedule with 15-second timer lifecycle"
  - "ctx.applyDvVictronControl and ctx.applyControlTarget on DI context"
  - "ctx.onEvalComplete callback for runtime snapshot publishing"
affects: [05-api-routes]

# Tech tracking
tech-stack:
  added: []
  patterns: ["ctx.onEvalComplete callback for post-evaluation side effects", "Timer lifecycle with stopping guard (consistent with polling.js)"]

key-files:
  created: [dvhub/schedule-eval.js]
  modified: [dvhub/server.js, dvhub/test/schedule-runtime.test.js]

key-decisions:
  - "telemetryStore references in extracted code use ctx.telemetryStore?.writeControlEvent (optional chaining since telemetryStore is set asynchronously)"
  - "Bare applyControlTarget calls in API routes rewired to ctx.applyControlTarget (7 call sites)"
  - "Removed unused imports from server.js: autoDisableStopSocScheduleRules, autoDisableExpiredScheduleRules, scheduleMatch, parseHHMM, localMinutesOfDay, SLOT_DURATION_MS, SMA_ID_PREFIX, SMALL_MARKET_AUTOMATION_SOURCE, SMALL_MARKET_AUTOMATION_DISPLAY_TONE"
  - "evaluateSchedule replaces publishRuntimeSnapshot() call with ctx.onEvalComplete?.() callback for decoupled side effects"

patterns-established:
  - "ctx.onEvalComplete callback decouples evaluation from snapshot publishing (same pattern as ctx.onPollComplete)"
  - "Hardware-writing functions (applyControlTarget, applyDvVictronControl) exposed via ctx for API route access"

requirements-completed: [MODX-06]

# Metrics
duration: 12min
completed: 2026-03-27
---

# Phase 4 Plan 02: Schedule Evaluation Brain Extraction Summary

**Extracted ~405 lines from server.js into schedule-eval.js: hardware control (applyDvVictronControl, applyControlTarget), schedule evaluation brain (evaluateSchedule), and 15-second timer lifecycle with start/stop, all using DI context**

## Performance

- **Duration:** 12 min
- **Started:** 2026-03-27T02:17:54Z
- **Completed:** 2026-03-27T02:30:12Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- Created schedule-eval.js as standalone module with createScheduleEvaluator factory containing 6 functions (toRawForWrite, effectiveTargetValue, applyDvVictronControl, applyControlTarget, evaluateSchedule, timer lifecycle)
- Removed ~405 lines from server.js (2442 -> 2037 lines), eliminating 6 extracted functions and 9 unused imports
- All 308 passing tests remain passing, 0 new failures introduced
- Rewired 7 API route applyControlTarget calls and setForcedOff to use ctx-prefixed functions

## Task Commits

Each task was committed atomically:

1. **Task 1: Create schedule-eval.js module** - `b9d81bb` (feat)
2. **Task 2: Wire schedule-eval.js into server.js and remove extracted code** - `dcf0404` (feat)

## Files Created/Modified
- `dvhub/schedule-eval.js` - New module: createScheduleEvaluator factory with applyDvVictronControl, toRawForWrite, effectiveTargetValue, applyControlTarget, evaluateSchedule, start/stop lifecycle
- `dvhub/server.js` - Removed extracted code, added import + factory wiring, rewired setForcedOff and API routes to use ctx-prefixed functions, added ctx.onEvalComplete callback
- `dvhub/test/schedule-runtime.test.js` - Updated source-reading test to verify schedule-eval.js for autoDisableStopSocScheduleRules

## Decisions Made
- telemetryStore references in extracted code changed from bare `telemetryStore` to `ctx.telemetryStore?.` with optional chaining, since telemetryStore is created asynchronously after ctx initialization
- API route calls to applyControlTarget (EOS, EMHASS, manual write endpoints -- 7 call sites) rewired to ctx.applyControlTarget to match extraction
- evaluateSchedule no longer calls publishRuntimeSnapshot() directly -- replaced with ctx.onEvalComplete?.() callback, consistent with polling.js ctx.onPollComplete pattern
- Removed 9 now-unused imports from server.js (moved to schedule-eval.js or no longer needed)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Rewired bare applyControlTarget calls in API routes**
- **Found during:** Task 2 (server.js wiring)
- **Issue:** 7 call sites in API routes (EOS apply, EMHASS apply, manual control write) still called bare `applyControlTarget()` after function definition was removed
- **Fix:** Updated all to `ctx.applyControlTarget()`
- **Files modified:** dvhub/server.js
- **Verification:** grep confirms no bare applyControlTarget calls remain
- **Committed in:** dcf0404 (Task 2 commit)

**2. [Rule 1 - Bug] Updated schedule-runtime.test.js to read from correct file**
- **Found during:** Task 2 (test verification)
- **Issue:** Test at line 224 checks server.js source for `autoDisableStopSocScheduleRules` -- function moved to schedule-eval.js
- **Fix:** Changed source path from server.js to schedule-eval.js for this assertion
- **Files modified:** dvhub/test/schedule-runtime.test.js
- **Verification:** Test passes (308 pass, 68 fail -- identical to baseline)
- **Committed in:** dcf0404 (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (2 bugs)
**Impact on plan:** Both auto-fixes necessary for correctness after extraction. No scope creep.

## Issues Encountered
None beyond the auto-fixed deviations above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Phase 4 (Automation Core) complete: both market-automation-builder.js and schedule-eval.js extracted
- server.js reduced from ~2905 lines (pre-Phase 4) to ~2037 lines (~868 lines removed in Phase 4)
- DI context fully wired: ctx.applyDvVictronControl, ctx.applyControlTarget, ctx.onEvalComplete available for Phase 5 API route extraction
- schedule-eval.js ready: hardware control functions accessible via ctx for API routes still in server.js
- No circular dependencies: schedule-eval.js imports from market-automation-builder, schedule-runtime, server-utils only

## Self-Check: PASSED

- dvhub/schedule-eval.js: FOUND
- .planning/phases/04-automation-core/04-02-SUMMARY.md: FOUND
- Commit b9d81bb: FOUND
- Commit dcf0404: FOUND

---
*Phase: 04-automation-core*
*Completed: 2026-03-27*
