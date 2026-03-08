# Phase 2 Research: Guided Setup Rebuild

## Scope Fit

Phase 2 is the implementation phase for:

- `SET-01`: first-run setup becomes a real step-by-step flow
- `SET-02`: setup adapts to `victron.transport = modbus | mqtt`
- `SET-03`: user gets actionable validation before advancing or saving
- `SET-04`: user sees a review of key values before final save

The codebase already has a setup page, but it is not a wizard yet. It is a single-page form split into four visual cards.

## Current Setup Architecture

### Frontend

- `dv-control-webapp/public/setup.html`
  - Renders four static `<article class="wizard-step">` cards on one page.
  - Exposes all current setup fields at once.
  - Has no step navigation, no back/next actions, and no review step.
- `dv-control-webapp/public/setup.js`
  - Owns the setup page behavior.
  - Keeps only three top-level state objects: `currentConfig`, `currentEffectiveConfig`, and `currentMeta`.
  - Uses the DOM as the real source of truth for edited values via `getValue()` and `collectConfig()`.
  - Only transport-specific UI behavior today is `updateTransportVisibility()`, which hides or shows the MQTT block.
  - Saves the full draft in one shot with `saveSetup()`.

### Backend and schema

- `dv-control-webapp/server.js`
  - `GET /api/config` returns `{ meta, config, effectiveConfig, definition }`.
  - `POST /api/config` and `POST /api/config/import` persist the raw config object and return restart metadata.
  - Root `/` routes to `setup.html` when `loadedConfig.needsSetup` is true.
- `dv-control-webapp/config-model.js`
  - Is the single source of truth for defaults, field paths, select options, restart-sensitive prefixes, and normalization.
  - `normalizeConfigInput()` merges raw input onto defaults.
  - `applyVictronDefaults()` fills inherited host/port/unitId/timeout values into effective config for register-based blocks.
  - `detectRestartRequired()` marks transport-related changes as restart-sensitive.

### Existing precedent from Settings

- `dv-control-webapp/public/settings.js`
  - Already solved one key UX problem that setup has not: it keeps a `currentDraftConfig` object independent of which UI section is currently rendered.
  - `syncRenderedFieldsToDraft()` and `parseFieldInput()` preserve edits while sections mount/unmount.
  - Phase 2 should copy this pattern for wizard steps. If setup keeps using the DOM as its only state, moving to one-step-at-a-time rendering will lose values from previous steps.

## Relevant File Touch Points

| File | Why it is likely in scope |
| --- | --- |
| `dv-control-webapp/public/setup.html` | Replace static four-card layout with an actual stepper, next/back actions, and review step |
| `dv-control-webapp/public/setup.js` | Core phase file for wizard state, step transitions, transport-aware rendering, validation, and review summary |
| `dv-control-webapp/public/styles.css` | Stepper navigation, step status, inline validation states, review layout |
| `dv-control-webapp/config-model.js` | Best place to extend schema metadata if setup needs shared step metadata, field group metadata, or reusable validation hints |
| `dv-control-webapp/server.js` | Only needed if Phase 2 adds structured validation responses or dry-run validation; current save API already persists config |
| `dv-control-webapp/public/settings.js` | Likely extraction target if setup and settings should share draft/path helpers instead of duplicating them |
| `dv-control-webapp/test/` | No setup coverage exists yet; Phase 2 will need new tests here |

## Actual Config Shape Setup Must Work With

The save API expects the same raw config shape that `saveConfigFile()` persists. For planning purposes, the setup wizard draft should stay aligned to that raw shape instead of inventing a setup-only DTO.

Core shape touched by the current setup:

```js
{
  httpPort,
  apiToken,
  modbusListenHost,
  modbusListenPort,
  gridPositiveMeans,
  victron: {
    transport,
    host,
    port,
    unitId,
    timeoutMs,
    mqtt: {
      broker,
      portalId,
      keepaliveIntervalMs,
      qos
    }
  },
  meter: {
    fc,
    address,
    quantity,
    timeoutMs,
    host,
    port,
    unitId
  },
  dvControl: {
    enabled
  },
  schedule: {
    timezone
  },
  epex: {
    enabled,
    bzn,
    timezone
  },
  influx: {
    enabled,
    apiVersion,
    url,
    db,
    org,
    bucket,
    token,
    measurement
  }
}
```

Important nuance:

- Current setup only edits a subset of this shape.
- Omitted values are filled by `createDefaultConfig()` in `config-model.js`.
- Saved raw config remains sparse; the UI receives a richer `effectiveConfig` back from the server.
- `setup.js` starts `collectConfig()` by cloning `currentConfig` (the raw config returned by the API), then overwrites only the fields that setup renders. That means hidden pre-existing raw fields are preserved today instead of being discarded.
- Review UI should probably show both user-entered values and important inherited/defaulted values, because `SET-04` is about confirming the real outcome, not only the sparse raw payload.

## Current Setup Coverage vs Schema

The current setup page edits these essential fields directly:

- Step 1 card: `httpPort`, `apiToken`
- Step 2 card: `victron.transport`, `victron.host`, `victron.port`, `victron.unitId`, `victron.timeoutMs`, `victron.mqtt.broker`, `victron.mqtt.portalId`, `victron.mqtt.keepaliveIntervalMs`
- Step 3 card: `modbusListenHost`, `modbusListenPort`, `gridPositiveMeans`, `meter.fc`, `meter.address`, `meter.quantity`, `dvControl.enabled`
- Step 4 card: `schedule.timezone`, `epex.enabled`, `epex.bzn`, `influx.enabled`, `influx.url`, `influx.db`

The schema contains more setup-adjacent fields that the current setup omits and Settings still owns:

- `victron.mqtt.qos`
- `meter.timeoutMs`, `meter.host`, `meter.port`, `meter.unitId`
- `epex.timezone`
- `influx.apiVersion`, `influx.org`, `influx.bucket`, `influx.token`, `influx.measurement`

That is acceptable for Phase 2 if the wizard intentionally remains beginner-focused, but the plan should explicitly call out which omitted fields remain default-only and discoverable later in Settings.

## Wizard-State Shape

Setup cannot stay DOM-driven if it becomes a true wizard. The minimum planning shape is:

```js
{
  draftConfig,          // raw config object to POST to /api/config
  effectiveConfig,      // merged/defaulted config returned by backend
  meta,                 // config file state, warnings, needsSetup
  activeStepId,         // e.g. basics | transport | dv | services | review
  stepOrder,
  visitedStepIds,
  completedStepIds,
  validation,          // per-step + per-field errors/warnings
  transportMode,       // derived from draftConfig.victron.transport
  reviewSnapshot       // derived summary, ideally computed not hand-maintained
}
```

Planning implications:

- `draftConfig` must become the source of truth, not the DOM.
- Step changes should sync the currently rendered inputs into `draftConfig`, similar to `settings.js`.
- `transportMode` should be derived from `draftConfig.victron.transport`, not stored independently long-term.
- `reviewSnapshot` should be computed from `draftConfig` plus `effectiveConfig`, so inherited values like meter host/port/unitId are visible.

Best-fit implementation pattern:

- Keep pure state helpers in `setup.js` or a shared setup helper module.
- Keep rendering thin and imperative, matching the current classic-browser architecture.
- Export pure helpers on `globalThis` for `node:test`, the same way Phase 1 exposed settings-shell helpers.

## Transport-Specific Branching

This phase is not only about hiding fields. The backend behavior differs materially by transport.

### Modbus path

- `server.js` creates `createModbusTransport()` when `cfg.victron.transport !== 'mqtt'`.
- Victron reads use `transport.mbRequest(conf)`.
- Meter polling uses `transport.mbRequest(cfg.meter)`.
- Writes use Modbus register encoding and `mbWriteSingle()` / `mbWriteMultiple()`.
- Modbus-specific inputs that matter in setup:
  - `victron.host`
  - `victron.port`
  - `victron.unitId`
  - `victron.timeoutMs`
  - `meter.fc`
  - `meter.address`
  - `meter.quantity`
  - `gridPositiveMeans`

### MQTT path

- `server.js` creates `createMqttTransport(cfg.victron)`.
- Point reads use `transport.readPoint(name)` against cached MQTT topics.
- Meter polling reads `meter_l1/l2/l3` from MQTT cache, then applies `gridPositiveMeans` sign normalization.
- Writes use `transport.mqttWrite(target, value)` with engineering values, not Modbus register encoding.
- MQTT-specific inputs that matter in setup:
  - `victron.mqtt.broker`
  - `victron.mqtt.portalId`
  - `victron.mqtt.keepaliveIntervalMs`
  - `gridPositiveMeans`

Critical planning nuance:

- `transport-mqtt.js` falls back to `mqtt://${victron.host}:1883` when broker is blank, so `victron.host` is still useful even in MQTT mode if broker is not entered.
- `portalId` is effectively required for useful MQTT operation. The code only logs a warning when it is missing, but topic resolution depends on it.
- `victron.unitId` is not used by the MQTT transport itself.

### Restart coupling

The running transport instance is created once at server startup and is not recreated when config is saved. Phase 2 must plan around that:

- Saving `victron.transport` or MQTT connection settings does not hot-switch the live transport.
- `config-model.js` already marks these paths as restart-sensitive.
- The wizard review/save UX should therefore treat transport changes as "save now, apply after restart/reconnect", not as instantly live.

This is especially important for `SET-04`, because the review step should tell the user which choices are saved versus immediately active.

## Validation Architecture

### What exists today

Validation is fragmented and too weak for `SET-03`.

1. HTML input attributes
   - `setup.html` uses `min`, `max`, and input types for some fields.
   - This is browser-level assistance only. It does not gate wizard progress reliably.
   - Because `collectConfig()` coerces with `Number(...)`, a blank numeric field currently becomes `0` instead of producing a useful validation error.

2. Frontend setup logic
   - `setup.js` performs no explicit per-step validation before save.
   - There is no inline field-error model.
   - There is no "cannot continue until fixed" logic because there are no steps yet.

3. Backend normalization
   - `config-model.js -> sanitizeRawConfig()` coerces booleans, numbers, and select values.
   - Invalid numbers/options are deleted and replaced by defaults, with warnings recorded.
   - `loadConfigFile()` only flags `needsSetup` for missing or invalid JSON files, not for semantically incomplete configs.
   - Declared field `min`/`max` metadata is not enforced on the backend, so out-of-range but finite numbers can still persist.

4. Save API behavior
   - `POST /api/config` only rejects when `body.config` is missing/not an object.
   - Otherwise it saves normalized raw config and returns `200 OK`, even if some fields were reset to defaults.
   - Warnings are available through `meta.warnings`, but setup currently does not surface them usefully.

### Planning consequence

Phase 2 needs frontend-first validation for UX, plus a backend warning handoff for safety.

Recommended validation split:

- Step-level blocking validation in the wizard before `Next`
- Full-draft validation before entering the review step
- Backend warning display after save/import if normalization still changed anything

If the phase wants stronger "setup complete" semantics than "JSON file exists and parses", planning should include backend work in `config-model.js` and/or `server.js`, because the current `needsSetup` flag is not based on semantic completeness.

Recommended step rules based on current schema:

### Basics step

- `httpPort`: required, numeric, `1..65535`
- `apiToken`: optional string

### Transport step

- `victron.transport`: required enum `modbus | mqtt`
- If `modbus`
  - `victron.host`: required non-empty
  - `victron.port`: required, numeric, `1..65535`
  - `victron.unitId`: required, numeric, `0..255`
  - `victron.timeoutMs`: required, numeric, `100..60000`
- If `mqtt`
  - `victron.mqtt.portalId`: should be treated as required in the wizard even though backend only warns
  - `victron.mqtt.keepaliveIntervalMs`: numeric, `1000..600000`
  - `victron.mqtt.broker`: either this or `victron.host` must be present, because broker falls back to host
  - `victron.host`: optional if broker is set, otherwise required

### DV and meter step

- `modbusListenHost`: required non-empty
- `modbusListenPort`: required, numeric, `1..65535`
- `gridPositiveMeans`: required enum
- `meter.fc`: required enum `3 | 4`
- `meter.address`: required, numeric, `0..65535`
- `meter.quantity`: required, numeric, `1..125`
- `dvControl.enabled`: boolean only

### Services step

- `schedule.timezone`: required non-empty string
- `epex.enabled`: boolean only
- If `epex.enabled`
  - `epex.bzn`: should be required non-empty
- `influx.enabled`: boolean only
- If `influx.enabled`
  - `influx.url`: required non-empty
  - `influx.db`: required non-empty

### Review step

- Must not be a passive summary only
- It should run full-draft validation and block final save if any blocking errors remain
- It should surface non-blocking backend-style warnings separately from errors

### Implication for `02-VALIDATION.md`

Phase planning should derive `02-VALIDATION.md` from the following rule:

- Client validation blocks step navigation and final save.
- Backend normalization warnings never silently replace client validation.
- Save/import response warnings are shown back to the user if the persisted result differs from what the review step implied.

## Testing Implications

### Current state

- There is only one test file: `dv-control-webapp/test/settings-shell.test.js`.
- It covers pure helpers extracted from `public/settings.js`.
- There are no setup tests.
- There is no `npm test` script in `dv-control-webapp/package.json`.
- Existing tests do run with `node --test` from the PlexLite repo root, but not from arbitrary cwd values.

### Current test harness issue

The existing test file hardcodes a path that is brittle:

- Running `node --test` from the workspace root fails because it resolves `dv-control-webapp/public/settings.js` relative to the wrong cwd.
- Running it from `dv-control-webapp/` also fails because the hardcoded path becomes `dv-control-webapp/dv-control-webapp/public/settings.js`.
- Running from the PlexLite repo root works because the test currently assumes that exact cwd.

That means Phase 2 should not copy this exact path-loading pattern for setup tests. Use `import.meta.url` / `fileURLToPath()` or another cwd-independent path resolution approach.

### What should be tested in Phase 2

Minimum useful automated coverage:

- pure wizard-state helper tests
  - next/back transitions
  - preserving draft values across step switches
  - step completion gating
  - transport-specific visible field sets
  - review summary generation
- validation helper tests
  - modbus required fields
  - mqtt required fields
  - conditional `epex` / `influx` requirements
  - blocking vs non-blocking warnings
- if `config-model.js` changes
  - tests for any new shared setup metadata or validation hints

The easiest path is the same strategy used in Phase 1:

- keep step/state/validation logic in pure functions
- keep DOM wiring thin
- test the pure functions with `node:test`

## Architecture Patterns

- Stay in the current classic browser-script architecture; no frontend rewrite is needed.
- Use the config model as the canonical field-path and default source.
- Use a draft config object as setup state, not a parallel setup-only field map.
- Derive transport-specific UI from `draftConfig.victron.transport`.
- Keep review output derived from both raw draft and effective config.
- Reuse the Phase 1 pattern of pure helpers + DOM adapter so the wizard remains testable.

## Standard Stack

- Browser UI: existing static HTML + vanilla JS in `public/`
- Backend: existing Node HTTP server in `server.js`
- Schema/defaults: `config-model.js`
- Transport behavior: `transport-modbus.js` and `transport-mqtt.js`
- Tests: `node:test`

No new framework is required to plan this phase well.

## Don't Hand-Roll

- Do not hand-maintain a second copy of config paths that drifts from `config-model.js`.
- Do not treat hidden DOM fields as persistent wizard state.
- Do not rely on backend sanitization warnings as the main user-facing validation model.
- Do not pretend transport changes apply immediately; the server architecture currently requires restart/reconnect for real transport changes.

## Common Pitfalls

- Silent defaulting: invalid numeric/select input is currently dropped and replaced by defaults.
- MQTT `portalId` is operationally important even though the backend does not hard-fail without it.
- `gridPositiveMeans` matters in both transports; it is not a Modbus-only setting.
- Setup and Settings currently share some schema concepts but not a shared frontend form engine, so duplication drift is a real risk.
- A wizard that unmounts steps without draft sync will lose prior inputs.

## Code Examples

Useful reference points in the current codebase:

- Setup load/save flow
  - `dv-control-webapp/public/setup.js`
  - `loadSetup()`
  - `collectConfig()`
  - `saveSetup()`
- Draft-preservation pattern worth copying
  - `dv-control-webapp/public/settings.js`
  - `currentDraftConfig`
  - `syncRenderedFieldsToDraft()`
  - `parseFieldInput()`
- Shared config normalization
  - `dv-control-webapp/config-model.js`
  - `normalizeConfigInput()`
  - `applyVictronDefaults()`
  - `detectRestartRequired()`
- Transport-specific backend behavior
  - `dv-control-webapp/server.js`
  - `pollPoint()`
  - `pollMeter()`
  - `writeScheduleTarget()`
  - `applyDvVictronControl()`

## Planning Guidance For The 3 Roadmap Plans

The roadmap split already matches the codebase well:

### `02-01 Extract shared setup draft handling and wizard step state`

Should cover:

- move setup from DOM-driven collection to draft-config state
- add step registry and navigation state
- add pure helper surface for tests
- optionally extract shared path/draft helpers from `settings.js`

### `02-02 Build transport-aware setup steps with beginner-focused copy`

Should cover:

- actual one-step-at-a-time rendering
- Modbus vs MQTT field branching
- transport-specific validation
- concise copy that explains why a field is shown

### `02-03 Add setup review step and save integration`

Should cover:

- review screen using raw + effective values
- final blocking validation pass
- save/import warning surfacing
- restart-required messaging and redirect behavior
- initial automated setup coverage

## Bottom Line

The main thing to know before planning is that Phase 2 is not primarily a visual refactor. It is a state-management and validation refactor built on top of an existing save API and config schema.

The highest-risk planning areas are:

- introducing explicit wizard draft state so step transitions do not lose values
- deciding how much setup metadata should live in `config-model.js` versus `setup.js`
- treating Modbus and MQTT as materially different runtime paths, not just different labels
- adding real pre-save validation because the backend currently normalizes invalid input instead of clearly rejecting it
- accounting for restart-required transport changes in the review/save UX
