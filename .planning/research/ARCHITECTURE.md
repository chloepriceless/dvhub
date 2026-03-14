# Architecture Patterns

**Domain:** Modular Home Energy Management System (HEMS) with Direktvermarktung
**Researched:** 2026-03-14

## Recommended Architecture

DVhub should evolve from its current monolith into a **layered modular architecture** with three runtime modules sharing a common data layer, connected through an internal event bus and a central arbitration layer. This is not a microservices split -- all modules run in the same Node.js process but with strict code boundaries, separate namespaces, and dependency-direction rules.

### Why In-Process Modules, Not Microservices

The target hardware is a Raspberry Pi with limited RAM (1-4 GB) and limited CPU. Microservices with separate processes, message queues, and service discovery add overhead that is unjustifiable on this platform. The existing runtime-worker IPC split already shows the complexity cost of even a two-process model. Instead, use **ES module boundaries with explicit interfaces** -- the same pattern that the Node.js ecosystem uses effectively (e.g., Fastify plugins, NestJS modules).

### Component Architecture

```
+------------------------------------------------------------------+
|                        DVhub Process                              |
|                                                                   |
|  +------------------+  +----------------+  +-------------------+  |
|  |   Gateway Module |  |   DV Module    |  | Optimizer Module  |  |
|  |   (always-on)    |  |   (optional)   |  |   (optional)      |  |
|  |                  |  |                |  |                   |  |
|  |  - Device HAL    |  |  - DV Provider |  |  - Adapter: EOS   |  |
|  |  - Telemetry     |  |    Adapters    |  |  - Adapter: EMHASS|  |
|  |  - Meter Polling |  |  - Curtailment |  |  - Forecast Broker|  |
|  |  - Market Data   |  |    Logic       |  |  - Plan Engine    |  |
|  |  - HTTP Server   |  |  - Measurement |  |  - Plan Scoring   |  |
|  |  - Config        |  |    Export       |  |  - EVCC Bridge    |  |
|  +--------+---------+  +-------+--------+  +---------+---------+  |
|           |                     |                     |           |
|  +--------v---------------------v---------------------v--------+  |
|  |                    Internal Event Bus                        |  |
|  |  (EventEmitter or lightweight pub/sub, in-process)          |  |
|  +------------------------------+------------------------------+  |
|                                 |                                 |
|  +------------------------------v------------------------------+  |
|  |                   Arbitration Layer                          |  |
|  |  Priority: Safety > DV > Manual > Optimizer > Fallback      |  |
|  |  Produces: Effective control intents                        |  |
|  +------------------------------+------------------------------+  |
|                                 |                                 |
|  +------------------------------v------------------------------+  |
|  |                   Execution Layer                            |  |
|  |  Writes to hardware via Device HAL                          |  |
|  |  Logs every command + readback                              |  |
|  +-------------------------------------------------------------+  |
|                                                                   |
|  +-------------------------------------------------------------+  |
|  |                   Data Layer (SQLite)                        |  |
|  |  Tables: shared.*, dv.*, opt.*, exec.*                      |  |
|  |  (schema prefixes via table naming, not separate DBs)       |  |
|  +-------------------------------------------------------------+  |
+------------------------------------------------------------------+
```

### Component Boundaries

| Component | Responsibility | Communicates With | Dependency Direction |
|-----------|---------------|-------------------|---------------------|
| **Gateway Module** | Device communication, telemetry collection, market data fetching, HTTP server, config management | All modules (provides data) | Foundation -- depends on nothing |
| **DV Module** | Direktvermarkter protocol handling, curtailment signal processing, measurement export to DV provider | Gateway (reads telemetry), Arbitration (emits intents) | Depends on Gateway only |
| **Optimizer Module** | Optimizer adapter management, forecast ingestion, plan generation/scoring, EVCC bridge | Gateway (reads telemetry + market data), Arbitration (emits intents) | Depends on Gateway only |
| **Arbitration Layer** | Priority resolution between competing control intents | All modules (receives intents), Execution (emits commands) | Receives from DV + Optimizer |
| **Execution Layer** | Hardware writes via Device HAL, command logging, readback verification | Gateway Device HAL (writes), Arbitration (receives commands) | Receives from Arbitration only |
| **Data Layer** | Persistent storage for telemetry, plans, decisions, commands | All modules (shared read/write with schema boundaries) | Shared infrastructure |
| **Internal Event Bus** | Decoupled communication between modules | All modules | Shared infrastructure |

### Module Activation Rules

- Gateway Module: **always active** -- it is the platform foundation
- DV Module: **optional** -- activated in config, requires Gateway
- Optimizer Module: **optional** -- activated in config, requires Gateway
- At least one of DV or Optimizer must be active (enforced at config validation)
- Arbitration + Execution layers are always active but adapt behavior to active modules

## Data Flow

### Primary Data Pipeline

```
Hardware (Inverter/Meter)
    |
    v
[1] Gateway: Device HAL polls via Modbus/MQTT
    |
    v
[2] Gateway: Telemetry Store writes raw samples (high-res, ~1s)
    |                                    |
    v                                    v
[3a] DV Module:                    [3b] Optimizer Module:
     Reads live meter values             Reads 15-min rollups
     Answers DV provider queries         Reads market prices
     Detects curtailment signals         Reads forecasts (PV, load)
    |                                    |
    v                                    v
[4a] DV Module:                    [4b] Optimizer Module:
     Emits control intents               Sends canonical input to
     (curtailment, export limits)        EOS/EMHASS adapters
                                         |
                                         v
                                    [4c] Optimizer receives plans,
                                         normalizes to canonical slots,
                                         scores, selects winner
                                         |
                                         v
                                    [4d] Optimizer emits control
                                         intents (battery schedule,
                                         grid setpoints, EV targets)
    |                                    |
    +------------------------------------+
    |
    v
[5] Arbitration Layer:
    Collects all active intents
    Applies priority rules
    Produces effective plan
    |
    v
[6] Execution Layer:
    Writes to hardware via Device HAL
    Logs command + readback
    Reports deviations
```

### Data Resolution Strategy

| Data Type | Resolution | Storage | Consumer |
|-----------|-----------|---------|----------|
| Live meter readings | ~1s poll | In-memory ring buffer + SQLite raw | Dashboard, DV measurement export |
| Telemetry rollups | 5 min | SQLite aggregated | Charts, history |
| Optimizer input | 15 min slots | SQLite snapshot | EOS, EMHASS adapters |
| Market prices | 15 min / 1 hour | SQLite + file cache | Optimizer, Small Market Automation |
| Plans | 15 min slots | SQLite | Arbitration, dashboard |
| Execution log | Per-command | SQLite | Audit, backtesting |

### Event Flow (Internal Bus)

The internal event bus uses Node.js `EventEmitter` (or a thin typed wrapper). Events are the primary mechanism for module decoupling.

**Key events:**

| Event | Emitter | Consumers | Payload |
|-------|---------|-----------|---------|
| `telemetry:sample` | Gateway | DV, Optimizer, Dashboard | `{ ts, meter, victron, quality }` |
| `telemetry:rollup` | Gateway | Optimizer | `{ slotStart, slotEnd, aggregates }` |
| `market:prices-updated` | Gateway | Optimizer, Small Market Auto | `{ source, slots[] }` |
| `dv:curtailment-signal` | DV | Arbitration | `{ provider, exportAllowed, limitW }` |
| `dv:measurement-request` | DV | Gateway | `{ provider, ts }` |
| `optimizer:plan-ready` | Optimizer | Arbitration, Dashboard | `{ planId, source, slots[] }` |
| `arbitration:effective-plan` | Arbitration | Execution, Dashboard | `{ planId, commands[] }` |
| `execution:command-sent` | Execution | Audit log | `{ target, value, success }` |
| `config:changed` | Gateway | All modules | `{ changedPaths[], restartRequired }` |

## Patterns to Follow

### Pattern 1: Module Registry with Lifecycle Hooks

Each module exports a factory function that receives a shared context and returns a module instance with lifecycle hooks.

**What:** Modules are registered at startup with `init()`, `start()`, `stop()` lifecycle. The Gateway always initializes first. Other modules register only if enabled in config.

**When:** Always -- this is the foundational pattern for the modular architecture.

**Example:**
```javascript
// dvhub/modules/dv/index.js
export function createDvModule({ gateway, eventBus, dataLayer, config }) {
  // Validate dependencies
  if (!gateway) throw new Error('DV module requires Gateway');

  return {
    name: 'dv',
    async init() { /* set up DV provider connections, register event listeners */ },
    async start() { /* begin listening for DV queries, start curtailment monitor */ },
    async stop() { /* clean up connections, flush pending measurements */ },
    getRoutes() { /* return HTTP route handlers for /api/dv/* and /dv/* */ },
    getStatus() { /* return module health for dashboard */ }
  };
}
```

```javascript
// dvhub/module-registry.js
export function createModuleRegistry({ gateway, eventBus, dataLayer, config }) {
  const modules = new Map();

  return {
    register(createFn) {
      const mod = createFn({ gateway, eventBus, dataLayer, config });
      modules.set(mod.name, mod);
    },
    async initAll() {
      for (const mod of modules.values()) await mod.init();
    },
    async startAll() {
      for (const mod of modules.values()) await mod.start();
    },
    async stopAll() {
      for (const mod of [...modules.values()].reverse()) await mod.stop();
    },
    getModule(name) { return modules.get(name); },
    getActiveModules() { return [...modules.keys()]; }
  };
}
```

### Pattern 2: Device Hardware Abstraction Layer (HAL)

**What:** A manufacturer-independent interface for reading meter data and writing control commands. Each manufacturer provides a "driver" that translates between the canonical interface and manufacturer-specific Modbus registers or MQTT topics.

**When:** Always required for multi-manufacturer support.

**Why this pattern:** The existing `hersteller/victron.json` profile is already 80% of this pattern -- it defines register addresses, scaling, and function codes. The HAL formalizes this into a driver interface that all control code uses uniformly.

**Example:**
```javascript
// dvhub/device-hal/driver-interface.js
// Every manufacturer driver must implement this interface:

/**
 * @typedef {Object} DeviceDriver
 * @property {string} manufacturer
 * @property {string[]} supportedTransports - ['modbus', 'mqtt', 'http']
 * @property {() => Promise<MeterReading>} readMeter
 * @property {() => Promise<DeviceState>} readState
 * @property {(target: string, value: number) => Promise<WriteResult>} writeControl
 * @property {() => Promise<HealthStatus>} checkHealth
 */

// dvhub/device-hal/victron-driver.js
export function createVictronDriver({ transport, profile }) {
  const points = profile.points;
  const controlWrite = profile.controlWrite;

  return {
    manufacturer: 'victron',
    supportedTransports: ['modbus', 'mqtt'],

    async readMeter() {
      const raw = await transport.mbRequest(
        profile.meter.fc, profile.meter.address, profile.meter.quantity
      );
      return decodeMeterReading(raw, profile);
    },

    async writeControl(target, value) {
      const spec = controlWrite[target];
      if (!spec?.enabled) return { success: false, reason: 'target_disabled' };
      const scaled = Math.round(value / (spec.scale || 1));
      await transport.mbWriteSingle(spec.address, scaled);
      return { success: true, target, value, scaledValue: scaled };
    }
  };
}
```

**Driver loading from config:**
```javascript
// dvhub/device-hal/index.js
import { readFile } from 'node:fs/promises';

export async function loadDriver(manufacturerName, transport) {
  const profilePath = `dvhub/hersteller/${manufacturerName}.json`;
  const profile = JSON.parse(await readFile(profilePath, 'utf-8'));

  // Dynamic import of manufacturer-specific driver
  const driverModule = await import(`./drivers/${manufacturerName}-driver.js`);
  return driverModule.createDriver({ transport, profile });
}
```

### Pattern 3: Optimizer Adapter Pattern (Strategy + Adapter)

**What:** Each external optimizer (EOS, EMHASS, future solvers) gets an adapter that translates between DVhub's canonical input/output format and the optimizer's specific API. Adapters are registered in a provider registry and invoked in parallel.

**When:** Always required for pluggable optimizer support.

**Example:**
```javascript
// dvhub/modules/optimizer/adapters/adapter-interface.js
/**
 * @typedef {Object} OptimizerAdapter
 * @property {string} name
 * @property {(config) => Promise<boolean>} checkAvailability
 * @property {(canonicalInput) => Promise<RawPlan>} optimize
 * @property {(rawPlan) => CanonicalPlan} normalizePlan
 */

// dvhub/modules/optimizer/adapters/eos-adapter.js
export function createEosAdapter({ config }) {
  const baseUrl = config.eos?.url || 'http://localhost:8503';

  return {
    name: 'eos',

    async checkAvailability() {
      try {
        const res = await fetch(`${baseUrl}/v1/ping`);
        return res.ok;
      } catch { return false; }
    },

    async optimize(canonicalInput) {
      const eosInput = translateToEosFormat(canonicalInput);
      const res = await fetch(`${baseUrl}/optimize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(eosInput)
      });
      if (!res.ok) throw new Error(`EOS returned ${res.status}`);
      return await res.json();
    },

    normalizePlan(rawPlan) {
      // Translate EOS-specific output to canonical 15-min slot plan
      return rawPlan.result.map(slot => ({
        slotStart: new Date(slot.start),
        slotEnd: new Date(slot.end),
        gridImportWh: slot.grid_import_wh || 0,
        gridExportWh: slot.grid_export_wh || 0,
        batteryChargeWh: slot.battery_charge_wh || 0,
        batteryDischargeWh: slot.battery_discharge_wh || 0,
        targetSocPct: slot.target_soc,
        evChargeWh: slot.ev_charge_wh || 0
      }));
    }
  };
}
```

### Pattern 4: Intent-Based Control with Priority Arbitration

**What:** No module writes directly to hardware. Instead, modules emit "control intents" with a priority level and time validity. The arbitration layer collects all active intents, resolves conflicts using a fixed priority order, and produces effective commands for the execution layer.

**When:** Always -- this is the core safety and correctness pattern.

**Priority order (highest to lowest):**

| Priority | Source | Example | Rationale |
|----------|--------|---------|-----------|
| 1 (highest) | **Safety** | Hardware fault detection, overcurrent | Physical protection, non-negotiable |
| 2 | **DV Curtailment** | Direktvermarkter says "curtail to 0%" | Legal/contractual obligation |
| 3 | **Manual Override** | Operator sets grid setpoint via dashboard | Human authority |
| 4 | **Optimizer Plan** | EOS says "discharge at 5kW" | Economic optimization |
| 5 (lowest) | **Fallback** | Self-consumption default | Safe baseline |

**Example:**
```javascript
// dvhub/arbitration/arbitrator.js
export function createArbitrator({ eventBus, executionLayer }) {
  const activeIntents = new Map(); // key: target (e.g., 'gridSetpointW')

  function resolveTarget(target) {
    const intents = [...activeIntents.values()]
      .filter(i => i.target === target && !isExpired(i))
      .sort((a, b) => a.priority - b.priority); // lower number = higher priority

    if (intents.length === 0) return null;

    const winner = intents[0];
    return {
      target,
      value: winner.value,
      source: winner.source,
      priority: winner.priority,
      overridden: intents.slice(1).map(i => ({
        source: i.source, value: i.value, priority: i.priority
      }))
    };
  }

  eventBus.on('intent:submit', (intent) => {
    activeIntents.set(intent.id, {
      ...intent,
      receivedAt: Date.now()
    });
    // Re-evaluate arbitration for affected targets
    const resolution = resolveTarget(intent.target);
    if (resolution) {
      eventBus.emit('arbitration:effective-command', resolution);
    }
  });

  return { resolveTarget, getActiveIntents: () => [...activeIntents.values()] };
}
```

**Conflict example -- DV curtailment vs optimizer export:**

When DV says "curtail to 0%" (priority 2) and the optimizer says "export at 5kW" (priority 4), the arbitrator selects DV's intent. The optimizer's plan is logged as "overridden by DV curtailment" for backtesting purposes. When DV releases the curtailment, the optimizer's plan automatically becomes the effective command if it is still within its time window.

### Pattern 5: Hybrid Polling + Event-Driven Data Collection

**What:** Use polling for hardware communication (Modbus TCP requires request-response) but event-driven patterns for internal data flow and module communication. MQTT transport is natively event-driven. The Gateway normalizes both into the same event stream.

**When:** Always -- this matches the physical constraints of the hardware protocols.

**Rationale:** Modbus TCP is inherently request-response; you cannot avoid polling for Victron/Deye hardware over Modbus. But MQTT (Victron's alternative) is natively push-based. The Gateway should abstract this difference:

```javascript
// Gateway handles both:
// Modbus: poll every cfg.meterPollMs -> emit telemetry:sample
// MQTT:   on message -> emit telemetry:sample

// All consumers only see events, never poll hardware directly
eventBus.on('telemetry:sample', (sample) => {
  // DV module: update measurement buffer for DV provider queries
  // Optimizer module: accumulate for 15-min rollup
  // Dashboard: push via SSE/WebSocket
});
```

**Resource-constrained optimization:**
- Poll interval: 1000ms for Modbus (existing default) -- sufficient for DV measurement accuracy
- Telemetry buffer flush: 5s (existing) -- avoids SQLite write amplification
- Rollup interval: 5 min (existing) -- sufficient for charts
- Optimizer input resolution: 15 min -- matches EPEX slot grid
- Event bus: synchronous `EventEmitter` with no serialization overhead

## Anti-Patterns to Avoid

### Anti-Pattern 1: Shared Mutable State Object

**What:** The current `state` object in `server.js` is a single mutable object accessed by all code paths -- schedule evaluation, DV control, API handlers, telemetry, dashboard.

**Why bad:** Module boundaries become meaningless if all modules read/write the same global object. Changes in one module's state can break another. Testing requires mocking the entire state tree.

**Instead:** Each module owns its state slice. The Gateway exposes read-only accessors for shared data (meter readings, market prices). Modules emit events rather than mutating shared state.

### Anti-Pattern 2: Direct Hardware Writes from Business Logic

**What:** The current `applyControlTarget()` function is called directly from schedule evaluation, DV control, EOS API handler, EMHASS API handler, and manual API writes -- all writing to the same transport with no coordination.

**Why bad:** Race conditions between competing writers. No audit trail of which source "won." No way to enforce priority ordering between DV curtailment and optimizer commands.

**Instead:** All control requests flow through the arbitration layer. No module calls `transport.mbWriteSingle()` directly.

### Anti-Pattern 3: Optimizer-Specific Code in Core Server

**What:** The current `server.js` has EOS-specific and EMHASS-specific API routes (`POST /api/eos/apply`, `POST /api/emhass/apply`) baked into the main HTTP handler.

**Why bad:** Adding a new optimizer requires modifying the core server. Optimizer-specific data formats leak into the routing layer.

**Instead:** The Optimizer Module registers its own routes via `getRoutes()`. Each optimizer adapter handles its own API surface. The core server only knows about the module registry.

### Anti-Pattern 4: Monolithic Config Object

**What:** The current `config-model.js` manages all configuration sections (transport, DV, schedule, market, telemetry) as one flat namespace.

**Why bad:** Module configuration is not scoped. Enabling/disabling a module cannot cleanly add/remove config sections. Config validation must know about all modules.

**Instead:** Each module declares its config schema. The config model merges module schemas at startup based on which modules are active.

## Decomposition Strategy: From Monolith to Modules

The key challenge is decomposing the existing ~2800-line `server.js` without breaking production functionality. This must be done incrementally, not as a big-bang rewrite.

### Phase 1: Extract Foundation (Gateway Core)

**Goal:** Extract the always-needed infrastructure from `server.js` into separate modules without changing behavior.

**Steps:**
1. Extract Device HAL (formalize the existing transport + hersteller pattern)
2. Extract Telemetry Store into a standalone data-layer module (already partially done)
3. Extract HTTP server setup + routing infrastructure
4. Extract config management as a module-aware system
5. Create the internal event bus
6. Create the module registry with lifecycle hooks

**After Phase 1:** `server.js` shrinks to ~200 lines of bootstrap code that initializes the Gateway and registers modules.

### Phase 2: Extract DV Module

**Goal:** Move all DV-specific logic into `modules/dv/`.

**Steps:**
1. Move DV provider connection handling (Modbus slave for LUOX)
2. Move curtailment signal detection and processing
3. Move measurement export logic
4. Move DV-specific config sections
5. Move negative-price protection (it is a DV concern, not a schedule concern)
6. Register DV routes as module routes
7. Emit DV intents to the arbitration layer instead of calling `applyControlTarget` directly

**After Phase 2:** DV functionality works when enabled, has zero code footprint when disabled.

### Phase 3: Extract Optimizer Module

**Goal:** Move all optimization logic into `modules/optimizer/`.

**Steps:**
1. Create the optimizer adapter interface
2. Move EOS integration into an EOS adapter
3. Move EMHASS integration into an EMHASS adapter
4. Move Small Market Automation into the optimizer module (it is a simple built-in optimizer)
5. Create the plan engine (canonical plan format, scoring, selection)
6. Create the forecast broker (PV forecast ingestion, normalization)
7. Add EVCC bridge as an optimizer sub-module
8. Register optimizer routes as module routes
9. Emit optimizer intents to the arbitration layer

**After Phase 3:** Full modular architecture is operational.

### Phase 4: Arbitration + Execution Layer

**Goal:** Formalize the control pipeline.

**Steps:**
1. Build the arbitration layer with priority resolution
2. Build the execution layer with command logging
3. Migrate all `applyControlTarget` calls to emit intents instead
4. Add readback verification (write, then read back to confirm)
5. Add deviation alerting

**After Phase 4:** Complete intent-based control pipeline with full audit trail.

### Build Order Dependencies

```
Phase 1 (Gateway Core)
  |
  +---> Phase 2 (DV Module)        -- can start after Phase 1
  |
  +---> Phase 3 (Optimizer Module)  -- can start after Phase 1
  |
  +---> Phase 4 (Arbitration)       -- needs Phase 2 + Phase 3 intents
```

Phases 2 and 3 are independent of each other and could theoretically be built in parallel. However, the DV module is simpler and more critical for existing production use, so it should be completed first.

## Scalability Considerations

| Concern | At 1 site (current) | At 10 sites (future) | At 100 sites (SaaS) |
|---------|---------------------|---------------------|---------------------|
| Data volume | SQLite is fine (single-digit GB/year) | SQLite per site, or migrate to PostgreSQL | PostgreSQL + TimescaleDB with partitioning |
| Module isolation | In-process modules | In-process modules per site instance | Service-per-module possible |
| Arbitration latency | <1ms (in-process) | <1ms (in-process) | Needs careful design |
| Hardware connectivity | Direct Modbus/MQTT | VPN or cloud relay per site | Cloud gateway pattern |

**Recommendation:** Design for the single-site case now. The module boundary pattern naturally supports future extraction into separate services if multi-site scaling is ever needed. Do not over-engineer for multi-site today -- the `shared.sites` table from the PostgreSQL blueprint is sufficient preparation.

## SQLite vs PostgreSQL Decision

**Recommendation: Stay with SQLite for v2, using schema-prefixed table names.**

| Factor | SQLite | PostgreSQL |
|--------|--------|------------|
| Deployment complexity | Zero -- built into Node.js 22.5+ | Requires separate process, ARM support varies |
| Raspberry Pi resource usage | Negligible | 50-200 MB RAM baseline |
| Schema separation | Table name prefixes (`shared_`, `dv_`, `opt_`, `exec_`) | True schema isolation |
| Time-series performance | Good to 10M rows with proper indexes | Better with TimescaleDB at scale |
| Concurrent writes | WAL mode handles the load at 1 site | Better under heavy write concurrency |
| Migration path | Can export to PostgreSQL later | N/A |

The existing PostgreSQL blueprint in `db/postgres/migrations/` is valuable as a **future reference** but should not be the v2 target. The module boundary pattern works equally well with SQLite table prefixes.

## Sources

- [HEMS Architecture Survey - Springer](https://link.springer.com/article/10.1007/s12667-019-00364-w) -- MEDIUM confidence: academic survey of HEMS concepts
- [Cloud Architecture for HEMS - Springer Energy Informatics](https://link.springer.com/article/10.1186/s42162-025-00599-1) -- MEDIUM confidence: event-driven + microservices patterns for HEMS
- [Akkudoktor EOS GitHub](https://github.com/Akkudoktor-EOS/EOS) -- HIGH confidence: primary optimizer target, REST API at `/optimize`
- [EMHASS Documentation](https://emhass.readthedocs.io/) -- HIGH confidence: second optimizer target, REST API
- [EOS Connect](https://github.com/ohAnd/EOS_connect) -- MEDIUM confidence: reference implementation for EOS orchestration layer
- [EVCC REST API Documentation](https://docs.evcc.io/docs/integrations/rest-api) -- HIGH confidence: loadpoint control API
- [Victron dbus-fronius](https://github.com/victronenergy/dbus-fronius) -- HIGH confidence: multi-brand inverter abstraction via SunSpec
- [Rule-Based Modular EMS for Microgrids](https://www.mdpi.com/2071-1050/17/3/867) -- MEDIUM confidence: academic paper on modular EMS with arbitration
- [Event-Driven Architecture for IoT](https://dzone.com/articles/event-driven-architecture-real-world-iot) -- MEDIUM confidence: patterns for resource-constrained IoT
- [SMA Modbus Protocol Interface](https://www.sma.de/en/products/product-features-interfaces/modbus-protocol-interface) -- HIGH confidence: SMA register standardization
- [Deye Modbus Registers - HA Community](https://community.home-assistant.io/t/deye-inverters-and-modbus-registers/935485) -- MEDIUM confidence: community register documentation
- [EMHASS GitHub](https://github.com/davidusb-geek/emhass) -- HIGH confidence: EMHASS architecture and API details

---

*Architecture analysis: 2026-03-14*
