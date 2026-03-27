---
phase: 05-http-layer-and-orchestrator-cleanup
plan: 01
subsystem: api
tags: [http, routing, factory-pattern, dependency-injection, express-like]

# Dependency graph
requires:
  - phase: 04-automation-core
    provides: schedule-eval.js and market-automation-builder.js factories with ctx injection
provides:
  - routes-api.js factory with createApiRoutes(ctx) returning { handleRequest, serveStatic }
  - SECURITY_HEADERS exported from routes-api.js
  - ~25 simple/read-only route handlers extracted from server.js
  - Auth (checkAuth) and rate limiting (checkRateLimit) inside routes-api.js factory
  - costSummary/userEnergyPricingSummary exposed to orchestrator via ctx mutation pattern
affects: [05-02-admin-routes, 05-03-orchestrator-cleanup]

# Tech tracking
tech-stack:
  added: []
  patterns: [factory-return-with-ctx-mutation, handleRequest-delegation, orchestrator-admin-fallthrough]

key-files:
  created:
    - dvhub/routes-api.js
  modified:
    - dvhub/server.js

key-decisions:
  - "handleRequest returns false for unmatched routes, allowing orchestrator to handle admin routes before static fallback"
  - "serveStatic exposed via factory return (alongside handleRequest) for orchestrator fallback"
  - "Local json() helper kept in server.js for admin routes that remain until Plan 2"
  - "REDACTED_PATHS duplicated in both files (trivial 3-element array) since redactConfig moved to routes-api.js while restoreRedactedValues stays"
  - "costSummary/userEnergyPricingSummary exposed to orchestrator via ctx mutation (not factory return) per locked user decision"

patterns-established:
  - "handleRequest delegation: orchestrator tries routes.handleRequest first, falls through to admin routes, then routes.serveStatic"
  - "ctx mutation for response builders: factory sets ctx.costSummary and ctx.userEnergyPricingSummary before returning"

requirements-completed: [MODX-07]

# Metrics
duration: 14min
completed: 2026-03-27
---

# Phase 5 Plan 01: Routes API Factory Summary

**createApiRoutes factory extracts ~25 read-only route handlers, auth/rate-limiting, response builders, and static file serving from server.js into routes-api.js, reducing orchestrator from 2037 to 1409 lines**

## Performance

- **Duration:** 14 min
- **Started:** 2026-03-27T03:49:56Z
- **Completed:** 2026-03-27T04:04:32Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments
- Created routes-api.js with createApiRoutes(ctx) factory containing all simple/read-only route handlers
- Extracted auth (checkAuth with crypto.timingSafeEqual), rate limiting (per-IP buckets), and static file serving
- Wired server.js to delegate HTTP handling via routes.handleRequest with CORS + try/catch wrapper
- Reduced server.js by 628 lines (2037 -> 1409) while maintaining 100% behavioral compatibility

## Task Commits

Each task was committed atomically:

1. **Task 1: Create routes-api.js factory** - `8d5be8b` (feat)
2. **Task 2: Wire routes-api.js into server.js** - `615475f` (feat)

## Files Created/Modified
- `dvhub/routes-api.js` - New factory module with createApiRoutes(ctx), SECURITY_HEADERS, handleRequest, serveStatic
- `dvhub/server.js` - Imports routes-api.js, delegates simple routes, keeps admin/config POST routes for Plan 2

## Decisions Made
- handleRequest returns `false` for unmatched routes so orchestrator can handle remaining admin routes before static fallback
- serveStatic is exposed in the factory return value `{ handleRequest, serveStatic }` for orchestrator to call as final fallback
- Local `json()` helper kept in server.js for admin routes that are not yet extracted (Plan 2 scope)
- REDACTED_PATHS array duplicated in both files (trivial constant, used by both redactConfig and restoreRedactedValues)
- Removed `crypto`, `user-energy-pricing`, and unused `server-utils` imports from server.js

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] handleRequest fallthrough pattern for admin routes**
- **Found during:** Task 2 (wiring server.js)
- **Issue:** Plan specified replacing entire HTTP handler with just `routes.handleRequest`, but admin routes staying in server.js would never be reached since handleRequest falls through to serveStatic
- **Fix:** Made handleRequest return `false` for unmatched routes; orchestrator tries admin routes after handleRequest, then calls routes.serveStatic as final fallback
- **Files modified:** dvhub/routes-api.js, dvhub/server.js
- **Verification:** All pre-existing test failures remain identical (137 failures, all pre-existing)
- **Committed in:** 615475f (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Necessary structural adjustment to preserve admin route handling during incremental extraction. No scope creep.

## Issues Encountered
None beyond the deviation documented above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- routes-api.js factory established with clean ctx injection pattern
- Admin/config POST routes remain in server.js, ready for extraction in Plan 2
- serveStatic exposed for orchestrator fallback pattern

---
*Phase: 05-http-layer-and-orchestrator-cleanup*
*Completed: 2026-03-27*
