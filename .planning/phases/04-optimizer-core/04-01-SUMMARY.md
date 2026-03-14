---
phase: 04-optimizer-core
plan: 01
subsystem: optimizer
tags: [ajv, json-schema, adapter-pattern, eos, emhass, fetch]

requires:
  - phase: 01-gateway-core
    provides: module registry, event bus, factory function pattern
provides:
  - Adapter registry for optimizer discovery and health-check orchestration
  - EOS adapter with 3-step optimization flow and Ajv schema validation
  - EMHASS adapter with MPC optimization and permissive validation
  - Canonical plan format (15-min slots) for normalized optimizer output
  - Three JSON schemas (canonical-plan, eos-response, emhass-response)
affects: [04-02, 04-03, 06-arbitration]

tech-stack:
  added: [ajv (existing Fastify dep)]
  patterns: [optimizer adapter interface, schema-validated I/O, mock-fetch testing]

key-files:
  created:
    - dvhub/modules/optimizer/adapter-registry.js
    - dvhub/modules/optimizer/adapters/eos.js
    - dvhub/modules/optimizer/adapters/emhass.js
    - dvhub/modules/optimizer/schemas/canonical-plan.json
    - dvhub/modules/optimizer/schemas/eos-response.json
    - dvhub/modules/optimizer/schemas/emhass-response.json
    - dvhub/test/optimizer-adapter-registry.test.js
    - dvhub/test/optimizer-adapter-eos.test.js
    - dvhub/test/optimizer-adapter-emhass.test.js
  modified: []

key-decisions:
  - "Ajv draft-07 schemas (Fastify ships ajv 8 which defaults to draft-07, not 2020-12)"
  - "EMHASS response schema is permissive (empty required) -- tighten after container testing per research"
  - "Adapter interface: name, testedVersions, buildInput, validateResponse, normalizeOutput, healthCheck, optimize"
  - "Canonical plan uses camelCase slot fields (gridImportWh, batteryChargeWh) for JS convention"

patterns-established:
  - "Optimizer adapter interface: { name, testedVersions, buildInput, validateResponse, normalizeOutput, healthCheck, optimize }"
  - "Schema validation on optimizer responses before normalization (SEC-02)"
  - "Version pinning with log.warn on untested versions (SEC-03)"
  - "Mock-fetch pattern: save/restore globalThis.fetch in beforeEach/afterEach"

requirements-completed: [OPT-01, OPT-02, SEC-02, SEC-03]

duration: 4min
completed: 2026-03-14
---

# Phase 04 Plan 01: Optimizer Adapter Infrastructure Summary

**Pluggable optimizer adapter registry with EOS/EMHASS adapters, Ajv schema validation (SEC-02), and version pinning warnings (SEC-03)**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-14T11:22:44Z
- **Completed:** 2026-03-14T11:26:41Z
- **Tasks:** 2
- **Files modified:** 9

## Accomplishments
- Adapter registry with register/get/getAll/healthCheckAll supporting pluggable optimizer backends
- EOS adapter implementing 3-step PUT/POST/GET optimization flow with Ajv-validated responses
- EMHASS adapter implementing single-POST MPC optimization with parallel-array-to-slot normalization
- Three JSON schemas defining canonical plan format, EOS response, and EMHASS response
- 29 unit tests covering registry operations, schema validation, adapter pure functions, and mocked HTTP

## Task Commits

Each task was committed atomically:

1. **Task 1: JSON schemas and adapter registry with tests** - `77023b9` (feat)
2. **Task 2: EOS and EMHASS adapters with tests** - `60bca54` (feat)

## Files Created/Modified
- `dvhub/modules/optimizer/adapter-registry.js` - Adapter registration, discovery, health-check orchestration with SEC-03 version warning
- `dvhub/modules/optimizer/adapters/eos.js` - EOS adapter with buildInput, validateResponse (Ajv), normalizeOutput, healthCheck, optimize
- `dvhub/modules/optimizer/adapters/emhass.js` - EMHASS adapter with same interface, permissive validation
- `dvhub/modules/optimizer/schemas/canonical-plan.json` - Canonical 15-min slot plan schema (required: optimizer, slots, createdAt, runId)
- `dvhub/modules/optimizer/schemas/eos-response.json` - EOS API response schema (required: result array with start/end datetimes)
- `dvhub/modules/optimizer/schemas/emhass-response.json` - EMHASS API response schema (permissive, tighten later)
- `dvhub/test/optimizer-adapter-registry.test.js` - 11 tests for registry and canonical schema
- `dvhub/test/optimizer-adapter-eos.test.js` - 10 tests for EOS adapter
- `dvhub/test/optimizer-adapter-emhass.test.js` - 8 tests for EMHASS adapter

## Decisions Made
- Used Ajv draft-07 schemas because Fastify ships ajv 8 which defaults to draft-07 (not 2020-12)
- EMHASS response schema is intentionally permissive (empty required array) per research recommendation to tighten after container testing
- Adapter interface contract: { name, testedVersions, buildInput, validateResponse, normalizeOutput, healthCheck, optimize }
- Canonical plan uses camelCase slot fields (gridImportWh, batteryChargeWh) following JS naming convention
- EOS normalizeOutput maps Akku_SoC (0-1 fraction) to targetSocPct (0-100 percent)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Fixed JSON schema draft version for Ajv 8 compatibility**
- **Found during:** Task 1 (schema validation tests)
- **Issue:** Schemas used `$schema: "https://json-schema.org/draft/2020-12/schema"` which Ajv 8 does not support without additional plugin
- **Fix:** Changed all 3 schemas to `"http://json-schema.org/draft-07/schema#"` (Ajv 8 default)
- **Files modified:** canonical-plan.json, eos-response.json, emhass-response.json
- **Verification:** All schema validation tests pass
- **Committed in:** 77023b9 (Task 1 commit)

**2. [Rule 1 - Bug] Fixed floating-point precision in EMHASS test assertion**
- **Found during:** Task 2 (EMHASS normalizeOutput test)
- **Issue:** `0.58 * 100 = 57.99999999999999` caused strict equality assertion to fail
- **Fix:** Changed `assert.equal(s1.targetSocPct, 58)` to tolerance-based `Math.abs(...) < 0.001`
- **Files modified:** dvhub/test/optimizer-adapter-emhass.test.js
- **Verification:** Test passes
- **Committed in:** 60bca54 (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (1 blocking, 1 bug)
**Impact on plan:** Both fixes necessary for correctness. No scope creep.

## Issues Encountered
None beyond the auto-fixed deviations above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Adapter infrastructure ready for 04-02 (optimizer scheduler/runner)
- Registry can register both EOS and EMHASS adapters
- Canonical plan format established for downstream consumers (arbitration, UI)

## Self-Check: PASSED

All 9 created files verified present. Both task commits (77023b9, 60bca54) verified in git log.

---
*Phase: 04-optimizer-core*
*Completed: 2026-03-14*
