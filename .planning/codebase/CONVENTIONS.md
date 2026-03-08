# Plexlite Conventions

## Scope

Plexlite is a small plain-JavaScript Node 18+ application with no build step. The backend lives in `dv-control-webapp/server.js`, shared config logic in `dv-control-webapp/config-model.js`, transport adapters in `dv-control-webapp/transport-modbus.js` and `dv-control-webapp/transport-mqtt.js`, and browser code in `dv-control-webapp/public/*.js`.

## Language and module conventions

- The repository uses native ES modules on the server via `"type": "module"` in `dv-control-webapp/package.json`.
- Backend imports prefer explicit Node built-ins such as `node:fs`, `node:path`, `node:http`, and local relative modules such as `./config-model.js`.
- Frontend code is also plain JavaScript, loaded directly from HTML files like `dv-control-webapp/public/index.html` without bundling or framework wrappers.
- Semicolons are used consistently, string literals are usually single-quoted, and helpers stay as function declarations unless a short local lambda is clearer.
- File names are kebab-case or descriptive flat names such as `transport-mqtt.js`, `config-model.js`, `settings.js`, and `setup.js`.
- Identifiers follow standard JavaScript casing: `camelCase` for functions and mutable variables, `UPPER_SNAKE_CASE` for process-wide constants like `CONFIG_PATH` and `MAX_BODY_BYTES`.

## Naming patterns

- Domain names encode units directly in identifiers: `gridSetpointW`, `chargeCurrentA`, `minSocPct`, `keepalivePulseSec`, `ct_kwh`.
- State containers are named for the subsystem they mirror: `state.meter`, `state.victron`, `state.schedule`, `state.energy`, `state.epex`.
- Config paths use dot notation strings such as `schedule.defaultGridSetpointW` and `victron.mqtt.portalId`; the same path vocabulary is reused across backend normalization in `dv-control-webapp/config-model.js` and frontend form rendering in `dv-control-webapp/public/settings.js`.
- UI element helpers use terse imperative names like `setText`, `setBanner`, `renderHealth`, `loadConfig`, and `saveScheduleDash`.

## Configuration patterns

- Runtime configuration is file-based JSON, with the path selected by `DV_APP_CONFIG` and defaulting to `dv-control-webapp/config.json` in `dv-control-webapp/server.js`.
- Config handling keeps three layers separate in `dv-control-webapp/config-model.js`: raw persisted input, merged persisted config, and effective config after transport-specific defaults are applied.
- Validation is lightweight and handwritten. Numbers are coerced with `Number(...)`, booleans pass through `coerceBoolean(...)`, select values are checked against allowed options, and invalid fields are dropped back to defaults with warnings.
- Shared helpers such as `hasPath`, `getPath`, `setPath`, `deletePath`, `collectChangedPaths`, and `detectRestartRequired` are a recurring idiom for editing nested config safely without a schema library.
- The settings UI mirrors backend config metadata instead of hardcoding every field. `getConfigDefinition()` in `dv-control-webapp/config-model.js` feeds dynamic rendering in `dv-control-webapp/public/settings.js`.
- Install-time configuration follows the same pattern: `install.sh` writes environment variables into the systemd unit rather than baking paths into application code.

## Error handling patterns

- The codebase prefers local `try`/`catch` blocks around I/O, network, and persistence boundaries instead of centralized middleware.
- Recoverable failures are usually logged and converted into state or JSON responses rather than rethrown. Examples include `pushLog(...)` in `dv-control-webapp/server.js`, `{ ok: false, error: ... }` API payloads, and health-check detail strings from `runServiceCommand(...)`.
- The HTTP layer uses explicit status codes and small helpers: `json(...)`, `text(...)`, `downloadJson(...)`, and a top-level `try`/`catch` around the request handler in `dv-control-webapp/server.js`.
- Validation failures return `400` with a compact error payload. Auth failures return `401` from `checkAuth(...)`. Optional service actions return `403` or `500` instead of crashing the process.
- Some noncritical code fails quietly on purpose. `persistEnergy()` suppresses recursive logging noise, and browser storage helpers in `dv-control-webapp/public/common.js` ignore `localStorage` exceptions.
- Catch blocks typically surface `error.message` or `e.message`, which keeps logs readable but means stack traces are often lost unless the outer handler logs the full error object.

## Recurring implementation idioms

- The backend is organized around one mutable process-level `state` object in `dv-control-webapp/server.js` rather than classes or dependency injection.
- Transport selection is abstracted through small factories: `createModbusTransport()` and `createMqttTransport(...)` return objects with a shared shape and are chosen once at startup.
- Periodic behavior uses timers directly: `setInterval(...)` drives polling, lease expiry, schedule evaluation, UI refresh, and MQTT keepalive.
- Browser pages use imperative DOM assembly and mutation rather than templates. Examples include SVG generation in `dv-control-webapp/public/app.js` and dynamic field rendering in `dv-control-webapp/public/settings.js`.
- Cross-page frontend concerns are centralized in `dv-control-webapp/public/common.js`, which exposes `window.PlexLiteCommon` for token-aware `apiFetch(...)` and URL building.
- The code favors small helper functions close to their call sites over deep module trees. Examples include `u16`, `s16`, `gridDirection`, `fmtTs`, and `fieldId`.

## Style notes worth preserving

- User-facing copy is predominantly German, but source text often stays ASCII-safe for runtime strings such as `gueltig`, `Einspeisung`, and `Zugriff verweigert`.
- Comments are sparse and mostly reserved for protocol boundaries, setup flow, or domain explanations, as seen in `dv-control-webapp/server.js` and `dv-control-webapp/transport-mqtt.js`.
- There is no visible lint or formatting toolchain in `dv-control-webapp/package.json`, so the de facto standard is the style already used in the existing files.
