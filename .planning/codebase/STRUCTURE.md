# PlexLite Structure

## Repository Layout

The repository is shallow. Most product code lives in one application directory, with docs and deployment helpers at the root.

```text
.
|-- 20-dv-modbus.sh
|-- install.sh
|-- README.md
|-- docs/
|-- dv-control-webapp/
|   |-- package.json
|   |-- server.js
|   |-- config-model.js
|   |-- transport-modbus.js
|   |-- transport-mqtt.js
|   `-- public/
`-- .planning/codebase/
```

## Key Locations

### Root-Level Operational Files

- `README.md`: product overview, installation notes, operating assumptions, and screenshots
- `install.sh`: production install path for Debian/systemd deployments
- `20-dv-modbus.sh`: optional firewall/NAT helper for forwarding external port 502 traffic to PlexLite
- `LICENSE.md` and `COMMERCIAL_LICENSE.md`: licensing split
- `CONTRIBUTING.md`: contributor guidance
- `docs/`: image assets used by the repository documentation

The root is used for repository-wide concerns, not for app source organization.

### Application Root

`dv-control-webapp/` is the actual deployable service directory:

- `package.json`: package metadata and start script
- `server.js`: main executable and primary backend implementation
- `config-model.js`: config defaults, normalization, field metadata, and restart detection
- `transport-modbus.js`: Modbus client adapter
- `transport-mqtt.js`: MQTT adapter
- `config.example.json`: sample config artifact for manual installs
- `BRAND_GUIDELINES.md`: product branding collateral for the UI

This folder currently mixes runtime entry, domain logic, transport helpers, and config schema at the same level instead of further splitting into `src/`, `lib/`, or feature directories.

### Static Frontend Assets

`dv-control-webapp/public/` holds all browser-delivered files:

- `index.html` + `app.js`: dashboard page
- `settings.html` + `settings.js`: full config editor page
- `setup.html` + `setup.js`: first-run setup wizard
- `tools.html` + `tools.js`: diagnostics and schedule JSON editor
- `common.js`: shared token-aware API helper
- `styles.css`: shared stylesheet for every page
- `assets/`: UI-only image assets such as the PlexLite logo

The placement pattern is page-centric: every major screen has its own HTML file and a same-name JS controller, with `common.js` as the only shared browser module.

### Planning Output

- `.planning/codebase/`: generated mapping documents, including `ARCHITECTURE.md` and `STRUCTURE.md`

This directory is tooling/output space rather than product code.

## Naming and Placement Patterns

### Backend Naming

- Transport helpers use `transport-*.js` naming for protocol-specific adapters.
- The config authority is named `config-model.js`, reflecting that it combines defaults, normalization, and UI field definitions.
- The backend entry file is simply `server.js`, and the current layout assumes that file is the orchestration center for the whole application.

### Frontend Naming

- Screen files use parallel names: `index.html`/`app.js`, `settings.html`/`settings.js`, `setup.html`/`setup.js`, `tools.html`/`tools.js`.
- Shared browser functionality is pulled into `common.js`.
- Styling is centralized in a single `styles.css` rather than page-specific CSS files.

### Script Naming

- Root scripts are task-oriented and shell-first: `install.sh` for installation and `20-dv-modbus.sh` for network forwarding setup.
- There is no `scripts/` directory yet; operational scripts sit directly at repository root.

## Practical Boundaries in the Tree

The tree suggests these effective boundaries:

- repo root: documentation, licensing, installation, and environment helpers
- `dv-control-webapp/`: deployable Node application
- `dv-control-webapp/public/`: browser assets and page controllers
- `.planning/`: generated planning and mapping artifacts

There are not yet separate folders for tests, reusable domain modules, or integration-specific code. Instead, those concerns are either absent from the tree or embedded in `dv-control-webapp/server.js`.

## Where Behavior Lives Today

- HTTP routes, Modbus server behavior, timers, schedule logic, EPEX handling, Influx writes, and service admin behavior live in `dv-control-webapp/server.js`
- Config defaults and settings-page schema live in `dv-control-webapp/config-model.js`
- Victron protocol mechanics live in `dv-control-webapp/transport-modbus.js` and `dv-control-webapp/transport-mqtt.js`
- Browser workflow logic lives in `dv-control-webapp/public/*.js`

If someone is looking for a specific concern, the fastest heuristic is:

- network/API/runtime issue: start in `dv-control-webapp/server.js`
- config or form-field issue: start in `dv-control-webapp/config-model.js`
- Victron communication issue: start in `dv-control-webapp/transport-modbus.js` or `dv-control-webapp/transport-mqtt.js`
- UI interaction issue: start in the matching file under `dv-control-webapp/public/`

## Structural Characteristics

- Small file count and shallow depth
- One dominant backend file
- No build step or transpilation layer
- No framework-specific source tree
- Static assets served directly from `dv-control-webapp/public/`
- Deployment scripts kept beside product docs instead of under a dedicated ops folder

This structure optimizes for directness and low ceremony, but it also means architectural boundaries are enforced more by convention than by directory separation.
