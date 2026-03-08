# Plexlite Stack

## Overview
- The application is a small monorepo-style Node.js project centered on `dv-control-webapp/`, with installation and deployment helpers at the repository root such as `install.sh` and `20-dv-modbus.sh`.
- Runtime behavior is implemented almost entirely in plain ECMAScript modules in `dv-control-webapp/server.js`, `dv-control-webapp/transport-modbus.js`, `dv-control-webapp/transport-mqtt.js`, and `dv-control-webapp/config-model.js`.
- The UI is a static multi-page frontend built from hand-written HTML/CSS/JavaScript in `dv-control-webapp/public/index.html`, `dv-control-webapp/public/settings.html`, `dv-control-webapp/public/setup.html`, `dv-control-webapp/public/tools.html`, and companion scripts.

## Languages And Runtimes
- JavaScript is the only implementation language in the shipped application code: backend files live under `dv-control-webapp/*.js`, frontend files under `dv-control-webapp/public/*.js`, and installer scripts under `install.sh` plus `20-dv-modbus.sh`.
- The backend uses Node.js ESM mode via `"type": "module"` in `dv-control-webapp/package.json`.
- Declared runtime support is Node.js `>=18.0.0` in `dv-control-webapp/package.json`, while `install.sh` provisions Node.js 22 on Debian/Ubuntu hosts.
- Shell scripting is used for host setup and firewall/VPN forwarding, especially in `install.sh` and `20-dv-modbus.sh`.

## Backend Architecture
- There is no framework such as Express, Fastify, Nest, or Koa. The web API is built directly on Node core `http` in `dv-control-webapp/server.js`.
- The Modbus proxy server is implemented directly on Node core `net` in `dv-control-webapp/server.js`.
- File system persistence and process/service actions use Node core modules (`fs`, `path`, `child_process`, `util`, `url`) imported in `dv-control-webapp/server.js` and `dv-control-webapp/config-model.js`.
- Runtime state is kept in memory in the `state` object inside `dv-control-webapp/server.js`, with periodic flushes for energy counters to `dv-control-webapp/energy_state.json`.

## Frontend Stack
- The frontend is server-served static HTML, CSS, and browser JavaScript with no SPA framework and no bundler.
- Shared browser helpers are in `dv-control-webapp/public/common.js`; page-specific logic is split across `dv-control-webapp/public/app.js`, `dv-control-webapp/public/settings.js`, `dv-control-webapp/public/setup.js`, and `dv-control-webapp/public/tools.js`.
- Styling is plain CSS from `dv-control-webapp/public/styles.css`.
- The HTML pages load Google Fonts (`Manrope` and `Saira Condensed`) directly from `fonts.googleapis.com` and `fonts.gstatic.com` in `dv-control-webapp/public/index.html`, `dv-control-webapp/public/settings.html`, `dv-control-webapp/public/setup.html`, and `dv-control-webapp/public/tools.html`.

## Dependencies
- The only declared package dependency is optional: `mqtt@^5.10.0` in `dv-control-webapp/package.json`.
- MQTT support is lazy-loaded with dynamic `import('mqtt')` inside `dv-control-webapp/transport-mqtt.js`, so Modbus-only deployments can run without it.
- There are no declared devDependencies, test libraries, linters, formatters, or build-time toolchains in `dv-control-webapp/package.json`.
- Node built-ins provide most of the platform surface: HTTP serving, TCP sockets, filesystem access, process control, and fetch-based HTTP client calls.

## Build And Dev Tooling
- There is no compile step, transpilation step, bundling step, or container build definition in the repository root.
- The only package script is `npm start`, which runs `node server.js` from `dv-control-webapp/package.json`.
- Installation is operationalized through `install.sh`, which clones the repo, runs `npm install --omit=dev`, writes a systemd unit, and sets service-action sudoers rules.
- Manual deployment instructions in `README.md` also rely on `npm install` and direct Node execution; no alternate package manager is configured.

## Configuration Model
- Effective configuration is defined in `dv-control-webapp/config-model.js`, which exposes defaults, field metadata, deep merge behavior, change detection, and restart-sensitive keys.
- The main config file is JSON and defaults to `dv-control-webapp/config.json`, but production deployments are expected to point `DV_APP_CONFIG` at an external file such as `/etc/plexlite/config.json`.
- A sample configuration is provided in `dv-control-webapp/config.example.json`.
- The application exposes config import/export and setup flows over HTTP in `dv-control-webapp/server.js`, backed by the schema metadata from `dv-control-webapp/config-model.js`.

## Runtime And Host Tooling
- The primary service model is systemd. `install.sh` writes `${SERVICE_NAME}.service` and enables it at boot.
- Service-control behavior is driven by environment variables consumed in `dv-control-webapp/server.js`: `DV_APP_CONFIG`, `DV_ENABLE_SERVICE_ACTIONS`, `DV_SERVICE_NAME`, and `DV_SERVICE_USE_SUDO`.
- Host networking helpers assume Linux networking tools such as `iptables`, `ip`, and `awk` in `20-dv-modbus.sh`.
- The documented install path is Debian 12 / Debian-family systems using `apt-get`, `curl`, `git`, `sudo`, and NodeSource bootstrap logic in `install.sh` and `README.md`.

## Notable Omissions
- No database layer, ORM, or migration tooling is present; persistence is file-based plus optional InfluxDB writes.
- No test suite, CI config, lint config, formatter config, or typed language setup appears in the repository files inspected (`README.md`, `dv-control-webapp/package.json`, and the source tree under `dv-control-webapp/`).
- No Dockerfile, Compose file, or Kubernetes manifests are present in the repository root.
