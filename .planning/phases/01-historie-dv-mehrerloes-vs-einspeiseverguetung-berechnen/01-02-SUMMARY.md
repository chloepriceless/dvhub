---
phase: 01-historie-dv-mehrerloes-vs-einspeiseverguetung-berechnen
plan: 02
subsystem: history-runtime
tags: [dv-comparison, einspeiseverguetung, anzulegender-wert, negativpreis, eeg-rules, kpi-calculation]

# Dependency graph
requires:
  - phase: 01-01
    provides: "eeg-rules.js (getEegNegativePriceRule, getFeedInCompensationCtKwh, isNegativePriceSlotAffected), BNetzA feedType=full support"
provides:
  - "getSummary() returns 5 new DV comparison KPI fields for month/year views"
  - "hypFullFeedInEur: hypothetical EV using Volleinspeisung AW on total pvKwh"
  - "hypSurplusFeedInEur: hypothetical EV using Teileinspeisung AW on exportKwh"
  - "dvExcessEur: DV-Mehrerlos = actual DV revenue minus hypothetical surplus EV"
  - "dvCostEur: monthly DV cost (configurable dvCostMonthlyEur, year view scales by active months)"
  - "dvNetAdvantageEur: Netto DV-Vorteil = dvExcessEur minus dvCostEur"
  - "config-model.js: dvCostMonthlyEur field with 8.50 EUR default and sanitization"
affects:
  - "03-dv-comparison-frontend (KPI field names for display)"
  - "history-runtime consumers"

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "TDD with node:test - RED commit (failing tests), then GREEN commit (implementation)"
    - "Null-safe AW: explicit null check before Number() coercion (Number(null)===0 guards)"
    - "AGGREGATE_SUM_FIELDS exclusion: hypFullFeedInCtTotal/hypSurplusFeedInCtTotal omitted to preserve null semantics"
    - "Pre-pass pattern for consecutive negative hours before slot.map()"

key-files:
  created: []
  modified:
    - "dvhub/config-model.js"
    - "dvhub/history-runtime.js"
    - "dvhub/test/history-runtime.test.js"

key-decisions:
  - "hypFullFeedInCtTotal and hypSurplusFeedInCtTotal excluded from AGGREGATE_SUM_FIELDS to prevent finalizeAggregateSums from converting null to 0"
  - "awFullCtKwh uses explicit null check on ctPartial before Number() coercion (Number(null)===0 is finite, would give wrong AW=0)"
  - "Pre-pass (not inline) for consecutive negative hours tracking to enable look-ahead across slots"
  - "Year view dvCostEur: counts distinct months with exportKwh > 0 (not hardcoded 12)"
  - "Test getCurrentDate set to future date to avoid split history/live queries returning duplicate slots"

patterns-established:
  - "DV KPI null semantics: null = AW unavailable or wrong view (not 0), preserved through aggregation by excluding from AGGREGATE_SUM_FIELDS"
  - "Negative price pre-pass: separates curtailment state computation from per-slot mapping for clean code"

requirements-completed: [DV-CALC, DV-CONFIG]

# Metrics
duration: 35min
completed: 2026-03-25
---

# Phase 1 Plan 2: DV Comparison KPI Calculation Summary

**getSummary() extended with 5 DV comparison KPIs (hypFullFeedInEur, hypSurplusFeedInEur, dvExcessEur, dvCostEur, dvNetAdvantageEur) using Volleinspeisung/Teileinspeisung AW, negative price curtailment, and configurable monthly DV costs**

## Performance

- **Duration:** 35 min
- **Started:** 2026-03-25T00:00:00Z
- **Completed:** 2026-03-25T00:35:00Z
- **Tasks:** 2 (Task 1 config, Task 2 TDD)
- **Files modified:** 3

## Accomplishments
- Added `dvCostMonthlyEur` (default 8.50 EUR) to `config-model.js` with sanitization and settings UI field definition
- `getSummary()` computes hypothetical EV for Volleinspeisung (uses full-feed AW) and Teileinspeisung (uses partial AW) scenarios
- Pre-EEG 2023 plants fall back to single AW for both scenarios (feedType='full' returns null -> fallback to partial)
- Negative price curtailment pre-pass: correctly excludes pvKwh/exportKwh from EV calculation per EEG rule (none/15min/6h/4h/tiered)
- DV-Kosten scale by active months in year view (not fixed x12)
- All DV fields are null for day/week views and when AW data is unavailable
- 11 new TDD tests, all passing; 3 pre-existing passing tests preserved (no regressions)

## Task Commits

Each task was committed atomically:

1. **Task 1: dvCostMonthlyEur in config-model.js** - `bca93b2` (feat)
2. **Task 2 RED: Failing DV comparison tests** - `1a2d5bb` (test)
3. **Task 2 GREEN: Implement DV comparison KPIs** - `ee517a2` (feat)

_Note: TDD tasks produce multiple commits (test RED → feat GREEN)_

## Files Created/Modified
- `dvhub/config-model.js` - Added dvCostMonthlyEur default (8.50), sanitization, and settings field definition
- `dvhub/history-runtime.js` - Import eeg-rules.js; awFullCtKwh computation with feedType='full'; negative price pre-pass; per-slot DV fields; DV KPI aggregation and final EUR calculation
- `dvhub/test/history-runtime.test.js` - 11 new DV comparison tests covering all behaviors from plan spec

## Decisions Made
- `hypFullFeedInCtTotal` and `hypSurplusFeedInCtTotal` were intentionally **excluded** from `AGGREGATE_SUM_FIELDS` to prevent `finalizeAggregateSums` from converting `null` (no AW data) to `0` via `round2(Number(null || 0))`.
- awFullCtKwh computation uses explicit `ctVal == null` check before `Number()` coercion, because `Number(null) === 0` (finite) would silently treat missing AW as 0.
- Test fixtures use `getCurrentDate: () => '2025-04-15'` (future date relative to test data) to prevent the history/live split in `listRawFallbackSlotsForRange` from returning duplicate energy slots.
- `dvCostEur` in year view counts distinct months with `exportKwh > 0` rather than hardcoded 12.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] null AW handling in awFullCtKwh computation**
- **Found during:** Task 2 GREEN (first test run)
- **Issue:** `Number(null) === 0` is finite, so when `ctPartial = null`, the code incorrectly computed `awFullCtKwh = 0` instead of `null`. This produced `hypFullFeedInEur = -0.32` (0 - 0.4 ct/kWh × pvKwh) instead of `null`.
- **Fix:** Added explicit `ctVal == null` check before `Number()` coercion, mirroring the fix from Plan 01 for `getFeedInCompensationCtKwh`.
- **Files modified:** dvhub/history-runtime.js
- **Verification:** "DV comparison fields null when AW is null" test passes.
- **Committed in:** `ee517a2` (Task 2 GREEN commit)

**2. [Rule 1 - Bug] AGGREGATE_SUM_FIELDS mangle null to 0 for ct totals**
- **Found during:** Task 2 GREEN (null AW test)
- **Issue:** Including `hypFullFeedInCtTotal`/`hypSurplusFeedInCtTotal` in `AGGREGATE_SUM_FIELDS` caused `finalizeAggregateSums` to call `round2(Number(null || 0)) = 0`, destroying the null semantics.
- **Fix:** Removed these fields from `AGGREGATE_SUM_FIELDS`. They're accumulated in the reduce with explicit null-safety.
- **Files modified:** dvhub/history-runtime.js
- **Verification:** Null AW test passes; other DV tests still pass.
- **Committed in:** `ee517a2` (Task 2 GREEN commit)

**3. [Rule 1 - Bug] Test fixture date causing duplicate slots**
- **Found during:** Task 2 GREEN (hypFullFeedInEur was 2x expected)
- **Issue:** Using `getCurrentDate: () => '2025-03-31'` with March 2025 slots caused `listRawFallbackSlotsForRange` to split into history + live queries, both returning the same slot from the simple fixture → doubled pvKwh.
- **Fix:** Changed `getCurrentDate` to `'2025-04-15'` so the full March range is history-only (single query). Year test uses `'2026-02-01'`.
- **Files modified:** dvhub/test/history-runtime.test.js
- **Verification:** hypFullFeedInEur = 11.95 (expected), not 23.9.
- **Committed in:** `ee517a2` (Task 2 GREEN commit)

---

**Total deviations:** 3 auto-fixed (3x Rule 1 - bug)
**Impact on plan:** All fixes essential for correct null semantics and test reliability. No scope creep.

## Issues Encountered
- Plan spec used `date: '2025-03'` for month view, but `normalizeViewRange` requires YYYY-MM-DD. Fixed tests to use `'2025-03-01'`. Plan spec also used `date: '2025'` for year view; fixed to `'2025-01-01'`. This is consistent with how existing tests call `getSummary`.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- `getSummary()` returns all 5 DV comparison KPIs for month/year views
- Plan 03 (frontend display) can directly read: `kpis.hypFullFeedInEur`, `kpis.hypSurplusFeedInEur`, `kpis.dvExcessEur`, `kpis.dvCostEur`, `kpis.dvNetAdvantageEur`
- Also exports `awFullCtKwh` and `awPartialCtKwh` for potential display in tooltip

---
*Phase: 01-historie-dv-mehrerloes-vs-einspeiseverguetung-berechnen*
*Completed: 2026-03-25*
