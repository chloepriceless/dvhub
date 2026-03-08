# Plexlite Testing

## Current test posture

Plexlite currently has no automated test harness checked into the repository. `dv-control-webapp/package.json` defines only `npm start`, there is no `test` script, no `test` or `__tests__` directory, and no visible dev dependencies for Jest, Vitest, Mocha, Playwright, Cypress, or similar tools.

## Test frameworks and tooling present today

- Runtime verification is manual and app-driven rather than framework-driven.
- The main smoke-test surfaces are the browser pages in `dv-control-webapp/public/index.html`, `dv-control-webapp/public/settings.html`, `dv-control-webapp/public/setup.html`, and `dv-control-webapp/public/tools.html`.
- Backend health is exposed through live endpoints in `dv-control-webapp/server.js`, especially `/api/status`, `/api/admin/health`, `/api/config`, `/api/schedule`, `/api/meter/scan`, and `/api/epex/refresh`.
- Installation and service behavior are exercised manually through `install.sh` plus the generated systemd service and sudoers rules.

## Test layout

- No formal test layout exists yet.
- The code is split in a way that suggests a natural future layout:
  - backend unit tests around pure helpers from `dv-control-webapp/config-model.js`
  - transport-focused tests around `dv-control-webapp/transport-modbus.js` and `dv-control-webapp/transport-mqtt.js`
  - HTTP integration tests against `dv-control-webapp/server.js`
  - browser-level tests for `dv-control-webapp/public/app.js`, `dv-control-webapp/public/settings.js`, `dv-control-webapp/public/setup.js`, and `dv-control-webapp/public/tools.js`
- Because the server file currently owns startup side effects, future tests will need either refactoring or process-level harnesses to avoid binding ports and timers during import.

## Mocking and stubbing patterns

- No mocking library or fixture system is present in the repository.
- The closest thing to test seams is functional decomposition:
  - `normalizeConfigInput(...)`, `collectChangedPaths(...)`, and `detectRestartRequired(...)` in `dv-control-webapp/config-model.js` are mostly pure and easy to unit test directly.
  - `createModbusTransport()` and `createMqttTransport(...)` isolate protocol behavior behind a small interface, which is a good boundary for future fakes.
  - `runServiceCommand(...)` and `serviceCommandParts(...)` isolate systemd interaction in `dv-control-webapp/server.js`.
  - `window.PlexLiteCommon.apiFetch(...)` in `dv-control-webapp/public/common.js` is a single chokepoint for stubbing browser network calls.
- Current manual stubbing is implicit rather than explicit: operators can point config at a different Victron host, MQTT broker, or config file, but the codebase does not provide in-repo fakes for those dependencies.

## Manual verification flows visible in the repo

- Start the app with `npm start` from `dv-control-webapp/` and verify that `/` redirects to setup or dashboard depending on config validity in `dv-control-webapp/server.js`.
- Use `dv-control-webapp/public/setup.html` and `dv-control-webapp/public/settings.html` to confirm config load, save, import, export, restart-required messaging, and service health rendering.
- Use `dv-control-webapp/public/index.html` to verify live polling, EPEX refresh, manual control writes, and schedule editing.
- Use `dv-control-webapp/public/tools.html` to verify Modbus scan flow and raw schedule JSON editing.
- Exercise auth manually by setting `apiToken` in config and confirming `401` handling plus the `plexlite:unauthorized` browser event in `dv-control-webapp/public/common.js`.

## Visible coverage gaps

- Config normalization is untested across invalid types, partial objects, and restart-sensitive path detection in `dv-control-webapp/config-model.js`.
- HTTP request handling lacks automated coverage for auth checks, oversized request bodies, bad JSON, and endpoint-specific validation in `dv-control-webapp/server.js`.
- Time-dependent logic is uncovered: lease expiry, schedule evaluation, EPEX day boundaries, and timezone-sensitive helpers all rely on live timers and current time.
- Transport failure modes are uncovered, especially socket reconnect behavior in `dv-control-webapp/transport-modbus.js` and broker timeout or cache-miss paths in `dv-control-webapp/transport-mqtt.js`.
- Browser code has no regression protection for DOM rendering, event wiring, schedule row grouping, import/export flows, or unauthorized-state UX in `dv-control-webapp/public/*.js`.
- Installer behavior in `install.sh` has no automated verification for root escalation, non-empty target directories, Node installation branches, or generated systemd content.
- Integration endpoints for EOS, EMHASS, Loxone, and Home Assistant are only wired at the HTTP layer; there is no visible contract testing for payload shape or downstream expectations.

## Highest-value first additions

- Add unit tests for `dv-control-webapp/config-model.js` before broader refactors; that file has the cleanest pure-function surface.
- Add HTTP integration tests for a few high-risk endpoints in `dv-control-webapp/server.js`: auth, config save/import, schedule writes, control writes, and health.
- Add a small browser smoke suite around setup and settings because those pages are the main operator workflows and currently rely on unchecked DOM assumptions.
