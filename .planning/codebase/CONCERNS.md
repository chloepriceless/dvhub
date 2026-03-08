# Plexlite Codebase Concerns

## Overall Risk Profile

Plexlite is functional, but the current implementation concentrates operational risk in a small number of large files and exposes several control-plane and configuration surfaces with only light safeguards. The highest-risk areas are the HTTP API and config flow in `dv-control-webapp/server.js`, token handling in `dv-control-webapp/public/common.js`, and privileged install/service management in `install.sh`.

## Technical Debt And Maintainability

### Runtime responsibilities are collapsed into a monolith

- `dv-control-webapp/server.js` is 1,619 lines and owns HTTP routing, Modbus server behavior, transport orchestration, polling, schedule evaluation, energy accounting, EPEX fetching, Influx flushing, integration adapters, health checks, and service restart handling.
- `dv-control-webapp/config-model.js` is another 1,298 lines and mixes schema definition, defaulting, sanitization, persistence, restart-detection metadata, and UI form metadata.
- This makes change impact hard to reason about. A small edit to control logic, config, or integrations can easily regress unrelated runtime behavior because there are few module boundaries and almost no explicit contracts between subsystems.

### Frontend logic is also large and tightly coupled to server payload shape

- `dv-control-webapp/public/app.js` and `dv-control-webapp/public/settings.js` both contain substantial UI state management, fetch logic, DOM rendering, and request shaping.
- The frontend depends directly on server response structure from `/api/status`, `/api/config`, `/api/schedule`, and `/api/admin/health`, but there is no shared contract layer, no generated types, and no compatibility checks.
- Any backend payload change will likely fail at runtime rather than at build time.

### No automated quality gate is visible

- `dv-control-webapp/package.json` only defines `start` and has no test, lint, or validation scripts.
- Repository search did not surface any Jest, Vitest, Playwright, Cypress, Mocha, or `node:test` coverage.
- This is especially concerning because the project performs control writes to external energy hardware and service-management actions.

## Security Risks

### Authentication is optional and defaults to open access

- `dv-control-webapp/config-model.js` defaults `apiToken` to an empty string.
- `dv-control-webapp/server.js` short-circuits `checkAuth()` when no token is configured, which leaves `/api/*` and `/dv/*` endpoints unprotected.
- In the same defaults, `modbusListenHost` is `0.0.0.0`, so insecure deployments are easy to create accidentally.
- Given the exposed endpoints include config import/export, manual control writes, schedule updates, scanner execution, and service restart, this is a significant deployment risk.

### Token handling leaks through URLs and persistent browser storage

- `dv-control-webapp/server.js` accepts auth via `?token=` in the query string.
- `dv-control-webapp/public/common.js` copies `?token=` into `localStorage` and appends the token back onto generated API URLs.
- This pattern leaks secrets into browser history, screenshots, copied links, reverse-proxy logs, and potentially Referer-like operational traces even though `Referrer-Policy` is set.
- `localStorage` also keeps the token available to any successful script injection in the app origin.

### Config APIs expose the entire control-plane secret set

- `dv-control-webapp/server.js` returns both `config` and `effectiveConfig` from `/api/config`.
- Those objects can contain `apiToken`, `influx.token`, transport endpoints, and operational topology details from `CONFIG_PATH`.
- There is no role split between “can view dashboard” and “can extract or rewrite the whole installation config”.

### Privileged service actions expand blast radius

- `install.sh` writes a sudoers file that allows the service user to run `systemctl restart`, `is-active`, and `show`.
- The `show` rule uses a trailing wildcard, which is broader than necessary and should be treated carefully.
- `dv-control-webapp/server.js` exposes `/api/admin/service/restart`, so any authenticated API caller can trigger service restarts.
- This is useful operationally, but it couples the web UI directly to privileged host control.

### Installer trust chain is weak

- `install.sh` runs as root, pulls Node setup via `curl ... | bash`, clones/pulls the repository directly, and installs dependencies from the network without pinning or artifact verification.
- That is a pragmatic bootstrap path, but it is also a supply-chain risk and makes reproducible installs harder.

### Persistent XSS is possible through schedule rendering

- `dv-control-webapp/server.js` accepts arbitrary `rules` arrays on `/api/schedule/rules` with only a top-level array check.
- `dv-control-webapp/public/app.js` later interpolates `start`, `end`, and value fields into `tr.innerHTML` when rendering schedule rows.
- Because start/end are stringified during config sanitization rather than format-validated, crafted schedule data can become stored UI markup.
- If auth is disabled, this becomes unauthenticated stored XSS. If auth is enabled, it is still an authenticated persistent XSS path.

## Missing Safeguards Around Hardware Control

### Manual and integration writes lack strong bounds and interlocks

- `dv-control-webapp/server.js` accepts direct writes from `/api/control/write`, `/api/integration/eos/apply`, and `/api/integration/emhass/apply`.
- The current checks mostly verify “finite number” and known target name.
- There are no per-target min/max limits, no rate limiting, no write cooldown, no dry-run mode, no confirmation requirement for dangerous ranges, and no secondary interlock before writing to Victron control registers.
- A bad automation client, wrong unit assumption, or malicious caller can push unsafe values straight into the plant.

### Schedule semantics are fragile and partly surprising

- `dv-control-webapp/server.js` computes schedule matches from `start` and `end`, but `nowDay` is currently unused in `scheduleMatch()`.
- `dv-control-webapp/config-model.js` still sanitizes `days` and `oneTime`, so the config model advertises semantics the evaluator does not honor.
- `evaluateSchedule()` also auto-disables rules after they were once active and their window closes. That behavior is operationally surprising unless the user understands it in advance.
- This mismatch increases the chance of silent control drift and “why did the schedule stop?” incidents.

### Startup failure handling leaves the app half-alive

- `dv-control-webapp/server.js` only starts the polling and schedule intervals inside the successful `transport.init()` branch.
- If MQTT init fails, the catch block logs that polling/schedule should continue without transport, but it does not actually start those loops or retry initialization.
- The process stays up and serves the UI, but core automation can be inert.

## Reliability And Operability Concerns

### Transport paths do not have strong recovery behavior

- `dv-control-webapp/transport-mqtt.js` rejects init after a timeout, but does not provide a higher-level recovery path for the server once startup has failed.
- `dv-control-webapp/transport-modbus.js` serializes requests per connection but has no explicit queue bound or backpressure limit, so slow or failing devices can accumulate queued work.
- Both transports are acceptable for low traffic, but they are brittle under degraded network conditions.

### Polling and timers can overlap work

- `dv-control-webapp/server.js` uses multiple `setInterval()` loops for meter polling, schedule evaluation, EPEX refresh checks, Influx flushing, lease expiry, and energy persistence.
- There is no guard preventing a new `pollMeter()` or `evaluateSchedule()` run from starting before the prior one has completed.
- That creates a risk of overlapping writes, stale state races, and harder-to-debug timing bugs when the network is slow.

### Shutdown path is abrupt

- `dv-control-webapp/server.js` calls `transport.destroy()`, `scanTransport.destroy()`, `mbServer.close()`, `web.close()`, and then immediately `process.exit(0)`.
- Because shutdown is not awaited, outstanding writes, network flushes, or file operations may be interrupted.

## Performance Concerns

### The UI uses frequent polling with broad payloads

- `dv-control-webapp/public/app.js` polls `/api/status` and `/api/log` every 3 seconds.
- `/api/status` returns a large state tree including control status, meter state, victron values, schedule state, setup metadata, cost summary, and the full EPEX dataset.
- This is fine for one local operator, but it does not scale cleanly to multiple open dashboards or constrained hardware.

### Synchronous filesystem writes remain in the request/runtime path

- `dv-control-webapp/config-model.js` uses synchronous config reads/writes.
- `dv-control-webapp/server.js` uses synchronous energy state persistence.
- For this project size the impact is probably tolerable, but it still means file IO can block the single Node event loop during runtime and admin operations.

## Missing Safeguards And Validation Gaps

### Input validation is uneven across APIs

- `dv-control-webapp/server.js` has a body-size cap, which is good, but malformed JSON is silently coerced to `{}` in `parseBody()`.
- Several endpoints rely on shallow checks and then accept objects directly into runtime state.
- The scanner endpoint can launch expensive device reads from the API without rate limits or privilege separation.

### MQTT dependency and setup are fragile

- `dv-control-webapp/package.json` keeps `mqtt` in `optionalDependencies`.
- `dv-control-webapp/transport-mqtt.js` dynamically imports it at runtime.
- That means an installation can appear healthy until MQTT mode is selected, then fail only at runtime depending on install outcome and package resolution.

## Recommended Priority Order

1. Lock down auth and secret handling in `dv-control-webapp/server.js` and `dv-control-webapp/public/common.js`.
2. Add hard write guardrails for `/api/control/write` and integration apply endpoints in `dv-control-webapp/server.js`.
3. Split `dv-control-webapp/server.js` into smaller modules: routes, control logic, transports, integrations, and persistence.
4. Fix schedule contract mismatches between `dv-control-webapp/config-model.js`, `dv-control-webapp/server.js`, and `dv-control-webapp/public/app.js`.
5. Replace `innerHTML` schedule rendering in `dv-control-webapp/public/app.js` with safe DOM construction.
6. Add at least smoke tests for config normalization, auth checks, schedule evaluation, and control-write encoding before further feature growth.
