# Plexlite Integrations

## Overview
- Plexlite bridges an external direct-marketing ecosystem to Victron ESS systems. The central integration logic lives in `dv-control-webapp/server.js`, with protocol adapters in `dv-control-webapp/transport-modbus.js` and `dv-control-webapp/transport-mqtt.js`.
- Integration settings are modeled in `dv-control-webapp/config-model.js` and exemplified in `dv-control-webapp/config.example.json`.

## External Devices And Protocols
- Victron GX / Venus OS is the core upstream system. Plexlite can talk to it over Modbus TCP using `dv-control-webapp/transport-modbus.js` or over MQTT using `dv-control-webapp/transport-mqtt.js`.
- The app itself exposes a Modbus TCP server for the direct marketer on `modbusListenHost:modbusListenPort`; the server implementation is in `dv-control-webapp/server.js`.
- Default Modbus register mappings for SOC, PV, battery power, grid setpoint, minimum SOC, and DV-control writes are defined in `dv-control-webapp/config-model.js` and `dv-control-webapp/config.example.json`.
- MQTT integration follows Victron Venus OS topic conventions with `N/`, `R/`, and `W/` topic prefixes in `dv-control-webapp/transport-mqtt.js`.
- The repo includes firewall/VPN forwarding glue in `20-dv-modbus.sh`, which DNATs VPN traffic on port 502 to Plexlite's Modbus listener on port 1502.

## Third-Party Services And APIs
- EPEX day-ahead pricing is fetched from the public Energy Charts API at `https://api.energy-charts.info/price` in `dv-control-webapp/server.js`.
- InfluxDB is supported as an outbound metrics sink. `dv-control-webapp/server.js` writes line protocol to either `/api/v2/write` or `/api/v3/write_lp`, depending on `influx.apiVersion`.
- EOS (Akkudoktor) is supported through Plexlite-owned compatibility endpoints in `dv-control-webapp/server.js`:
  - `GET /api/integration/eos` exposes measurement, system, and price payloads.
  - `POST /api/integration/eos/apply` accepts optimization results and converts them into Victron control writes.
- EMHASS is supported similarly in `dv-control-webapp/server.js`:
  - `GET /api/integration/emhass` exposes current power and forecast arrays.
  - `POST /api/integration/emhass/apply` accepts optimization targets and applies them.
- Home Assistant and Loxone are served by lightweight export endpoints in `dv-control-webapp/server.js`:
  - `GET /api/integration/home-assistant` returns JSON state.
  - `GET /api/integration/loxone` returns a line-based text payload.

## Auth And Access Control
- There is no user database, session store, or OAuth/OpenID flow anywhere in the repository.
- API protection is a single optional shared secret, `apiToken`, defined in `dv-control-webapp/config-model.js` and validated in `checkAuth()` within `dv-control-webapp/server.js`.
- Authenticated API access accepts either `Authorization: Bearer <token>` headers or a `?token=<token>` query parameter in `dv-control-webapp/server.js`.
- If `apiToken` is blank, API endpoints under `/api/*` and `/dv/*` are effectively unauthenticated.

## Persistence And Datastores
- There is no relational or document database in the codebase.
- Primary configuration persistence is JSON on local disk: the app loads and saves `config.json` via `loadConfigFile()` and `saveConfigFile()` in `dv-control-webapp/config-model.js`.
- Short-term operational state is held in memory in `dv-control-webapp/server.js`.
- Energy totals are checkpointed to the local file `dv-control-webapp/energy_state.json` from `dv-control-webapp/server.js`.
- Optional time-series persistence is delegated to external InfluxDB, configured through the `influx` section in `dv-control-webapp/config.example.json`.

## OS And Service Integrations
- The admin health/service area integrates with systemd using `systemctl` calls wrapped by `execFile()` and detached `spawn()` helpers in `dv-control-webapp/server.js`.
- Installer-created sudoers entries in `install.sh` allow the service user to run `systemctl restart`, `systemctl is-active`, and `systemctl show` for the Plexlite service.
- Runtime behavior for those service actions is toggled by environment variables documented in `install.sh` and consumed in `dv-control-webapp/server.js`: `DV_ENABLE_SERVICE_ACTIONS`, `DV_SERVICE_NAME`, and `DV_SERVICE_USE_SUDO`.

## Network Boundaries
- Inbound HTTP traffic terminates on the app's `httpPort` and serves both the UI and JSON APIs from `dv-control-webapp/server.js`.
- Inbound Modbus TCP traffic terminates on `modbusListenPort` in `dv-control-webapp/server.js`, representing the LUOX/direct-marketer-facing side of the bridge described in `README.md`.
- Outbound Modbus TCP traffic goes to the Victron GX target defined under `victron.host`, `victron.port`, and `victron.unitId` in `dv-control-webapp/config.example.json`.
- Outbound MQTT traffic goes to `victron.mqtt.broker`, using the Victron portal ID to derive topic paths in `dv-control-webapp/transport-mqtt.js`.
- Outbound HTTP traffic is used for Energy Charts price fetches and InfluxDB writes in `dv-control-webapp/server.js`.

## Webhooks And Push Patterns
- There are no webhook subscriptions or third-party callback registrations in the repository.
- The closest webhook-like behavior is inbound POST handling on Plexlite-owned endpoints such as `POST /api/integration/eos/apply`, `POST /api/integration/emhass/apply`, `POST /api/control/write`, and `POST /api/epex/refresh` in `dv-control-webapp/server.js`.
- MQTT is the only true push-style upstream protocol in the stack, with subscription caching and keepalive publishes implemented in `dv-control-webapp/transport-mqtt.js`.

## Frontend Third-Party Usage
- The browser UI pulls Google-hosted fonts from `fonts.googleapis.com` and `fonts.gstatic.com` in `dv-control-webapp/public/index.html`, `dv-control-webapp/public/settings.html`, `dv-control-webapp/public/setup.html`, and `dv-control-webapp/public/tools.html`.
- The browser frontend talks only to the local Plexlite HTTP API via `fetch()` wrappers in `dv-control-webapp/public/common.js`; it does not call third-party APIs directly.

## What Is Not Present
- No SQL server, Redis, message broker, webhook dispatcher, or cloud SDK is integrated in the repository.
- No built-in VPN client configuration exists in the app code; OpenVPN/LUOX setup is documented operationally in `README.md`, with firewall automation delegated to `20-dv-modbus.sh`.
