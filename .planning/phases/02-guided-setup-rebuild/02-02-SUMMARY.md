---
phase: 02-guided-setup-rebuild
plan: 02
subsystem: ui
tags: [setup, wizard, validation, vanilla-js, node:test]
requires:
  - phase: 02-guided-setup-rebuild
    provides: draft-backed setup wizard helpers and shell rendering from plan 02-01
provides:
  - Schema-backed setup step metadata derived from the config definition
  - Transport-aware wizard presentation for Modbus and MQTT onboarding
  - Branch-specific step validation with actionable inline error guidance
affects: [02-guided-setup-rebuild, setup-review-save, SET-04]
tech-stack:
  added: []
  patterns: [schema-backed setup metadata, transport-specific step copy, step-level validation summaries]
key-files:
  created: []
  modified: [dv-control-webapp/config-model.js, dv-control-webapp/public/setup.html, dv-control-webapp/public/setup.js, dv-control-webapp/public/styles.css, dv-control-webapp/test/setup-wizard.test.js]
key-decisions:
  - "Keep setup step ownership and beginner copy on config definition metadata so the wizard cannot drift from the real schema."
  - "Present the active step with progress chrome and transport-specific guidance instead of showing raw field lists."
  - "Treat MQTT connection validation as broker-or-host and reject blank numeric fields instead of coercing them to zero."
patterns-established:
  - "Setup fields opt into the wizard through field.setup metadata on getConfigDefinition() output."
  - "Transport-specific onboarding copy is generated from pure helpers and reused by the DOM renderer."
requirements-completed: [SET-01, SET-02, SET-03]
duration: 8min
completed: 2026-03-08
---

# Phase 2 Plan 2: Build transport-aware setup steps with beginner-focused copy Summary

**Schema-driven setup steps with Modbus/MQTT-specific guidance, focused step chrome, and branch-aware validation gates**

## Performance

- **Duration:** 8 min
- **Started:** 2026-03-08T23:22:39Z
- **Completed:** 2026-03-08T23:30:17Z
- **Tasks:** 3
- **Files modified:** 5

## Accomplishments

- Moved setup step ownership into `getConfigDefinition()` metadata so the wizard now derives its field inventory from the canonical schema.
- Reworked the setup renderer into a more explicit stepper with progress chrome, transport-aware callouts, and responsive step navigation styling.
- Tightened validation so MQTT accepts either broker or GX host, blank numerics no longer coerce to zero, and each blocked step explains what to fix next.

## Task Commits

Each task was committed atomically:

1. **Task 1: Encode wizard step ownership without duplicating config paths** - `c509988` (feat)
2. **Task 2: Render one focused step at a time with transport-aware field branching** - `deec0eb` (feat)
3. **Task 3: Enforce actionable step-level validation with focused coverage** - `3924ba1` (feat)

**Plan metadata:** Pending final docs commit for this plan.

## Files Created/Modified

- `dv-control-webapp/config-model.js` - Adds setup wizard step metadata and field-level beginner guidance to the canonical config definition.
- `dv-control-webapp/public/setup.html` - Labels the wizard shell with dedicated setup stepper and stage hooks.
- `dv-control-webapp/public/setup.js` - Derives steps from schema metadata, renders transport-aware step chrome, and enforces branch-specific validation.
- `dv-control-webapp/public/styles.css` - Styles the focused stepper, progress treatment, callouts, nav copy, and inline validation summary states.
- `dv-control-webapp/test/setup-wizard.test.js` - Covers schema-backed step derivation, transport field branching, MQTT broker-or-host validation, and blank numeric rejection.

## Decisions Made

- Kept setup-specific field ownership in `config-model.js` instead of a second browser-only registry so Settings and Setup stay aligned.
- Put transport guidance into a pure `describeSetupStep()` helper so the UI copy remains testable without a browser.
- Allowed MQTT validation to succeed with either `victron.mqtt.broker` or `victron.host`, matching the runtime fallback behavior from research.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Moved setup metadata annotation to the top-level field definition builder**
- **Found during:** Task 2 (Render one focused step at a time with transport-aware field branching)
- **Issue:** Setup metadata was initially attached only inside the register-group helper, leaving the main beginner fields without `field.setup` metadata once the UI tried to render from the schema.
- **Fix:** Returned plain register helper fields again and applied `addSetupWizardMetadata()` when the full field definition list is finalized.
- **Files modified:** `dv-control-webapp/config-model.js`
- **Verification:** `node --test dv-control-webapp/test/setup-wizard.test.js`
- **Committed in:** `deec0eb` (part of Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** The fix was required for the schema-backed wizard to function. No scope creep beyond the planned setup metadata refactor.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Ready for Plan 02-03 to add the review step and final save integration on top of the schema-backed step metadata and validation summaries.
- Transport-specific field branching and validation rules are now stable enough to summarize on a review screen without duplicating logic.

## Self-Check: PASSED

- Verified summary file exists on disk.
- Verified task commits `c509988`, `deec0eb`, and `3924ba1` exist in git history.
