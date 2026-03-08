# PlexLite Architecture

## System Shape

PlexLite is a small monolithic Node.js application centered on `dv-control-webapp/server.js`. One process exposes two network surfaces at once:

- an HTTP server for the dashboard, setup flow, settings UI, tools UI, and JSON APIs in `dv-control-webapp/server.js`
- a Modbus TCP server that emulates the DV/Plexlog-facing control registers, also in `dv-control-webapp/server.js`

The service talks to Victron either through a Modbus client adapter in `dv-control-webapp/transport-modbus.js` or an MQTT adapter in `dv-control-webapp/transport-mqtt.js`. Configuration defaults, normalization, persistence, and schema metadata live in `dv-control-webapp/config-model.js`.

The browser side is plain static HTML/CSS/JS under `dv-control-webapp/public/`. Each page is its own entry point and calls back into the same API surface using the shared helper in `dv-control-webapp/public/common.js`.

## Entry Points

- `dv-control-webapp/server.js`: main runtime entry; started by `npm start`
- `dv-control-webapp/package.json`: declares the application package and `start` script
- `install.sh`: production/bootstrap entry that installs Node, clones the repo, installs dependencies, writes the systemd unit, and points `DV_APP_CONFIG` at an external config file
- `20-dv-modbus.sh`: deployment-side network helper for forwarding port 502 traffic to PlexLite's Modbus listener
- `dv-control-webapp/public/index.html`: dashboard entry
- `dv-control-webapp/public/settings.html`: full config editor entry
- `dv-control-webapp/public/setup.html`: first-run setup entry
- `dv-control-webapp/public/tools.html`: diagnostics entry

## Main Layers

### 1. Config and Schema Layer

`dv-control-webapp/config-model.js` acts as the config authority:

- creates defaults with `createDefaultConfig()`
- applies Victron host/port/unit defaults across nested register definitions with `applyVictronDefaults()`
- sanitizes and normalizes persisted config with `normalizeConfigInput()`
- loads and saves the JSON config file with `loadConfigFile()` and `saveConfigFile()`
- exposes UI form metadata with `getConfigDefinition()`
- computes restart-sensitive changes with `collectChangedPaths()` and `detectRestartRequired()`

This file is both data model and form schema, so backend config rules and settings-page rendering are intentionally coupled to the same source of truth.

### 2. Runtime State Layer

`dv-control-webapp/server.js` owns a single in-memory `state` object. It aggregates:

- emulated DV registers in `state.dvRegs`
- direct-marketing control lease state in `state.ctrl`
- keepalive metadata in `state.keepalive`
- live meter and Victron values in `state.meter` and `state.victron`
- scan tool state in `state.scan`
- schedule rules, active outputs, and last writes in `state.schedule`
- day energy counters in `state.energy`
- fetched market prices in `state.epex`
- recent event rows in `state.log`

There is no database. Durability is limited to config persistence and the daily energy snapshot in `energy_state.json`.

### 3. Transport Adapter Layer

The app uses a small adapter boundary for upstream Victron access:

- `dv-control-webapp/transport-modbus.js` implements pooled Modbus TCP request/response helpers (`mbRequest`, `mbWriteSingle`, `mbWriteMultiple`)
- `dv-control-webapp/transport-mqtt.js` implements cached topic subscriptions plus MQTT writes (`readPoint`, `mqttWrite`, `getCached`)

`dv-control-webapp/server.js` selects the adapter once at startup through `createModbusTransport()` or `createMqttTransport()`. A second Modbus adapter instance, `scanTransport`, is kept separate for the diagnostics scanner so scan traffic does not reuse the main logical transport abstraction.

### 4. Protocol and API Layer

`dv-control-webapp/server.js` exposes two protocol surfaces:

- Modbus TCP server: created with `net.createServer()`, parses FC3/4/6/16 frames, updates `state.dvRegs`, and turns specific writes into forced-off/forced-on control transitions
- HTTP server: created with `http.createServer()`, serves static files from `dv-control-webapp/public/` and exposes operational APIs such as `/api/status`, `/api/config`, `/api/schedule`, `/api/control/write`, `/api/meter/scan`, and integration endpoints

Authorization is simple and shared: if `cfg.apiToken` is set, `/api/*` and `/dv/*` require either `Authorization: Bearer ...` or `?token=...`.

### 5. Browser UI Layer

The UI is page-oriented, not componentized:

- `dv-control-webapp/public/common.js` stores the API token in local storage and wraps `fetch`
- `dv-control-webapp/public/app.js` drives the dashboard, chart rendering, schedule editing, and manual write actions
- `dv-control-webapp/public/settings.js` renders the config editor dynamically from the schema returned by `/api/config`
- `dv-control-webapp/public/setup.js` implements the narrower first-run wizard
- `dv-control-webapp/public/tools.js` drives the Modbus scan and raw schedule JSON editor
- `dv-control-webapp/public/styles.css` is the shared styling layer across all pages

The front end depends directly on backend payload shapes; there is no client-side model layer between them.

## Data and Control Flow

### Startup Flow

1. `dv-control-webapp/server.js` resolves `CONFIG_PATH` from `DV_APP_CONFIG` or local `config.json`.
2. The server loads config through `loadConfigFile()` from `dv-control-webapp/config-model.js`.
3. It creates the selected Victron transport and a dedicated `scanTransport`.
4. It starts the HTTP server and the Modbus server.
5. It restores `energy_state.json`, initializes transport, performs an initial meter poll, and starts recurring timers.

### Live Telemetry Flow

1. `pollMeter()` runs on the `meterPollMs` interval in `dv-control-webapp/server.js`.
2. Meter values come either from Modbus registers or cached MQTT topics.
3. Additional Victron points are polled through `pollPoint()` using the same transport abstraction.
4. Derived values are computed in-process: PV total, grid import/export split, battery charge/discharge, and daily cost/revenue estimates.
5. The consolidated state is exposed to the dashboard through `/api/status`, `/api/costs`, and integration endpoints.

### Direct-Marketing / DV Control Flow

1. A direct marketer or forwarded VPN connection talks Modbus TCP to the PlexLite listener.
2. `processModbusFrame()` in `dv-control-webapp/server.js` answers reads from `state.dvRegs`.
3. Writes to the expected control registers call `handleWriteSignal()`.
4. That toggles `state.ctrl.forcedOff` through `setForcedOff()` or `clearForcedOff()`.
5. The transition fan-outs to `applyDvVictronControl()`, which writes Victron-side feed-in/block flags using the active transport.
6. The current control bit is also exposed over `/dv/control-value`.

This means PlexLite acts as a protocol bridge: downstream DV talks to PlexLite's own Modbus register model, while upstream plant control is translated into Victron Modbus or MQTT writes.

### Schedule and Manual Write Flow

1. Rules and defaults are held in `state.schedule` and persisted back into config.
2. `evaluateSchedule()` runs on its own interval from `cfg.schedule.evaluateMs`.
3. It computes the effective target for `gridSetpointW` and `chargeCurrentA`, applies negative-price overrides when needed, and writes values through `applyControlTarget()`.
4. `applyControlTarget()` encodes engineering values into Modbus words when required, or writes directly over MQTT when running in MQTT mode.
5. Manual writes from `/api/control/write`, EOS apply endpoints, and EMHASS apply endpoints all reuse the same write path.

### Market and Integration Flow

1. `fetchEpexDay()` pulls day-ahead prices from the external Energy Charts API.
2. Prices are stored in `state.epex` and reused for dashboard display, negative-price protection, cost estimation, `eosState()`, and `emhassState()`.
3. `buildInfluxLines()` converts in-memory state into line protocol, then `flushInflux()` writes to InfluxDB v2 or v3 endpoints.
4. Home Assistant, Loxone, EOS, and EMHASS integrations are read-only state exports plus optional optimization apply endpoints.

### Config and Admin Flow

1. `setup.html` and `settings.html` both call `/api/config`.
2. The settings page renders fields dynamically from `definition.fields` produced by `dv-control-webapp/config-model.js`.
3. POSTs to `/api/config` or `/api/config/import` sanitize and persist only the raw config JSON.
4. Restart-sensitive changes are detected immediately and surfaced back to the UI.
5. Health and restart actions use `systemctl` via `execFile`, optionally wrapped in `sudo`, from `dv-control-webapp/server.js`.

## Module Boundaries

### Clear Boundaries

- `dv-control-webapp/config-model.js` is a real boundary around config defaults, validation, schema, and restart detection.
- `dv-control-webapp/transport-modbus.js` and `dv-control-webapp/transport-mqtt.js` are real boundaries around upstream protocol details.
- `dv-control-webapp/public/common.js` is a small but consistent boundary for token-aware API access in the browser.

### Soft Boundaries

- Most domain logic still lives in `dv-control-webapp/server.js`: scheduling, Modbus emulation, EPEX handling, admin helpers, API routing, telemetry derivation, and persistence timers.
- API contracts are implicit. The browser files under `dv-control-webapp/public/` depend on exact JSON shapes from `dv-control-webapp/server.js`.
- Integration logic is embedded inline rather than isolated in separate modules.

The practical result is a compact codebase with low file count but a large central control file.

## Architectural Patterns

- Monolithic service with adapter modules: one process owns all runtime concerns, while protocol specifics are split into helper files.
- Shared mutable in-memory state: nearly every flow reads or mutates the single `state` object.
- Config-driven register mapping: meter points, write points, and DV registers come from structured config rather than hardcoded route logic alone.
- Page-per-workflow frontend: dashboard, setup, settings, and tools are separate HTML+JS entries instead of a bundled SPA.
- Poll plus push hybrid: Modbus mode is poll-driven, MQTT mode is cache-and-subscribe-driven, but both feed the same state model.
- Deployment-aware application code: service restart helpers and setup assumptions are built directly into the app rather than delegated to an external control plane.

## Practical Reading Order

For an engineer onboarding to the architecture, the highest-signal path is:

1. `dv-control-webapp/server.js`
2. `dv-control-webapp/config-model.js`
3. `dv-control-webapp/transport-modbus.js`
4. `dv-control-webapp/transport-mqtt.js`
5. `dv-control-webapp/public/common.js`
6. `dv-control-webapp/public/app.js`
7. `dv-control-webapp/public/settings.js`

