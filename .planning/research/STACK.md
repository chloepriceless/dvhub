# Technology Stack

**Project:** DVhub v2 -- Modular HEMS / Energy Management System
**Researched:** 2026-03-14

## Recommended Stack

### Database: SQLite (enhanced) + PostgreSQL (optional upgrade path)

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| node:sqlite (DatabaseSync) | Node 22.5+ built-in | Primary time-series + relational store | Already in production, zero dependencies, excellent Pi performance, no separate process |
| better-sqlite3 | ^11.x | Drop-in replacement if node:sqlite perf insufficient | ~20% faster than node:sqlite in benchmarks, mature, battle-tested |
| PostgreSQL 17 | 17.x | Optional upgrade for multi-site or high-scale deployments | Only when SQLite's single-writer becomes a bottleneck or multi-process access needed |
| TimescaleDB | 2.23+ (PG extension) | Optional: hypertables for high-volume time-series if PostgreSQL chosen | Adds automatic partitioning, compression, continuous aggregates on top of PostgreSQL |

**Decision rationale -- why NOT a dedicated TSDB:**

The existing codebase already runs SQLite for telemetry. The actual data volume for a single-site HEMS is modest: ~1 sample/sec polling = ~86,400 rows/day of raw telemetry, plus ~96 rows/day of 15-min slots. This is well within SQLite's capabilities even on a Raspberry Pi 4.

| Option | Pi 4 RAM Overhead | ARM64 Docker | Complexity | Verdict |
|--------|-------------------|--------------|------------|---------|
| **SQLite (keep)** | ~0 MB (in-process) | N/A (built-in) | Minimal | **RECOMMENDED** |
| PostgreSQL | ~50-100 MB idle | Official ARM64 image | Moderate -- separate process, migrations | Good upgrade path |
| TimescaleDB | ~100-200 MB idle | Official ARM64 image | High -- PG + extension, tuning needed | Only if PG and need partitioning |
| QuestDB | ~200-500 MB (JVM) | No official ARM64 Docker; requires Java 17 binary install | High -- JVM dependency, no Docker on ARM | **REJECT** -- JVM on Pi is wasteful |
| InfluxDB 3 Core | ~150-300 MB | Official ARM64 Docker since 2025 | High -- Rust engine, new/immature, line protocol API | **REJECT** -- overkill, different query paradigm |

**SQLite optimization strategy for time-series (HIGH confidence):**

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;
PRAGMA cache_size = -20000;  -- 20MB cache
PRAGMA mmap_size = 268435456; -- 256MB mmap
PRAGMA page_size = 8192;
```

Key patterns:
- Batch writes in transactions (the existing `TelemetryWriteBuffer` already does this)
- Monthly partitioned tables for raw telemetry (e.g., `telemetry_2026_03`) with `UNION ALL` view
- Rollup tables at 5-min and 15-min resolution (already implemented)
- WAL checkpoint management in a background interval

**Multi-resolution data architecture (stays in SQLite):**

| Resolution | Table Pattern | Retention | Purpose |
|------------|--------------|-----------|---------|
| Raw (~1s) | `telemetry_raw_YYYY_MM` | 7 days | Live charts, debugging |
| 5-min rollups | `telemetry_5min` | 90 days | Dashboard charts |
| 15-min slots | `telemetry_15min` | 2 years | DV reporting, optimizer input, billing |
| Daily aggregates | `telemetry_daily` | Forever | History analytics, financial reporting |

**Schema separation via table prefixes (SQLite has no schemas):**

| Prefix | Domain | Examples |
|--------|--------|---------|
| `shared_` | Cross-module | `shared_sites`, `shared_assets`, `shared_config` |
| `dv_` | Direktvermarktung | `dv_readings`, `dv_curtailments`, `dv_contracts` |
| `opt_` | Optimizer | `opt_plans`, `opt_slots`, `opt_scores`, `opt_runs` |
| `exec_` | Execution | `exec_commands`, `exec_control_log` |
| `telemetry_` | Time-series | `telemetry_raw_*`, `telemetry_5min`, `telemetry_15min` |

**PostgreSQL upgrade path:** The existing schema blueprint (docs/plans/2026-03-10-dvhub-postgres-schema-blueprint.md) with 4 schemas (`shared`, `dv`, `opt`, `exec`) is well-designed. If DVhub ever needs multi-process DB access, multi-site support, or concurrent write-heavy workloads, migrate to PostgreSQL using that blueprint. The table-prefix convention in SQLite maps cleanly to PostgreSQL schemas.

**Confidence: HIGH** -- SQLite is proven in the codebase, data volumes are modest, and the Pi resource constraint strongly favors in-process databases.

---

### UI Framework: Preact + HTM (no build step)

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| Preact | 10.x | Component model, reactive UI updates | 4 KB gzipped, React-compatible API, huge ecosystem |
| HTM | 3.x | JSX-like tagged templates without transpilation | 1 KB gzipped, no build step needed, works with CDN |

**Total bundle: ~5 KB gzipped (Preact + HTM)**

**Decision rationale:**

| Option | Bundle (gzip) | Build Step? | Component Model | Pi Impact | Verdict |
|--------|---------------|-------------|-----------------|-----------|---------|
| **Preact + HTM** | ~5 KB | NO | Full (hooks, context, signals) | Negligible | **RECOMMENDED** |
| Vanilla JS (keep) | 0 KB framework | NO | None -- manual DOM | Negligible | Scales poorly as UI grows |
| Alpine.js | ~15 KB | NO | Declarative attributes | Low | Slow in benchmarks, poor for data-heavy dashboards |
| Svelte | ~2-3 KB runtime | YES (compiler) | Full | Negligible | Requires build tooling -- breaks "no build" philosophy |
| Lit | ~5.7 KB | Optional | Web Components | Negligible | Web Components add complexity for internal-only UI |

**Why Preact + HTM and not staying Vanilla:**

1. The dashboard is growing (live data, history charts, settings, setup wizard, module config). Vanilla JS DOM manipulation becomes unmaintainable past ~2000 lines of UI code.
2. Preact + HTM requires NO build step -- load from CDN or vendor the 5 KB file. Edit, refresh, done. This matches the current development workflow exactly.
3. HTM uses standard JavaScript tagged templates -- no JSX transpiler, no Babel, no Vite. The existing `dvhub/public/` directory structure stays unchanged.
4. Migration can be incremental: new pages/components use Preact+HTM, old pages stay vanilla until refactored.

**Usage pattern (no build step):**

```html
<script type="module">
  import { h, render } from 'https://esm.sh/preact@10';
  import { useState, useEffect } from 'https://esm.sh/preact@10/hooks';
  import htm from 'https://esm.sh/htm@3';
  const html = htm.bind(h);

  function Dashboard({ apiBase }) {
    const [meter, setMeter] = useState(null);
    useEffect(() => {
      const poll = setInterval(async () => {
        const r = await fetch(`${apiBase}/api/status`);
        setMeter(await r.json());
      }, 5000);
      return () => clearInterval(poll);
    }, []);

    return html`<div class="dashboard">
      <h2>Grid Power: ${meter?.gridPowerW ?? '...'} W</h2>
    </div>`;
  }

  render(html`<${Dashboard} apiBase="" />`, document.getElementById('app'));
</script>
```

**For production deployment, vendor the files locally** (no CDN dependency on Pi):
```bash
# Download once, serve from dvhub/public/vendor/
curl -o dvhub/public/vendor/preact.mjs "https://esm.sh/preact@10?bundle"
curl -o dvhub/public/vendor/preact-hooks.mjs "https://esm.sh/preact@10/hooks?bundle"
curl -o dvhub/public/vendor/htm.mjs "https://esm.sh/htm@3?bundle"
```

**Confidence: HIGH** -- Preact+HTM is proven for no-build dashboards, the bundle is tiny, and incremental migration from vanilla JS is straightforward.

---

### Module Architecture: Modular Monolith with Event Bus

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| Node.js EventEmitter | Built-in | Inter-module event bus | Zero dependencies, native to Node.js, proven pattern |
| Custom module loader | N/A | Module registration, activation, lifecycle | Simple factory pattern, config-driven activation |

**Architecture pattern: Single-process modular monolith**

The system stays as ONE deployable Node.js process. Modules are directories under `dvhub/modules/` with a defined interface. The module loader reads config to determine which modules to activate.

```
dvhub/
  modules/
    gateway/          # Always active
      index.js        # Module entry: exports { name, init, destroy, routes, events }
      transport-modbus.js
      transport-mqtt.js
      telemetry-collector.js
      device-registry.js
    dv/               # Activatable
      index.js
      dv-interface.js
      dv-luox.js
      curtailment.js
    optimizer/        # Activatable
      index.js
      eos-adapter.js
      emhass-adapter.js
      evcc-adapter.js
      plan-engine.js
      plan-scorer.js
  core/
    module-loader.js  # Loads modules, manages lifecycle
    event-bus.js      # Typed EventEmitter singleton
    config.js         # Shared config management
    db.js             # Database access (shared across modules)
    http-server.js    # HTTP server, route registration
```

**Module interface contract:**

```javascript
// Each module exports:
export default {
  name: 'dv',
  requires: ['gateway'],      // dependency declaration

  async init(ctx) {            // ctx = { bus, db, config, registerRoutes }
    // Setup module state, register event listeners, register HTTP routes
  },

  async destroy() {
    // Cleanup: close connections, flush buffers
  },

  routes: [
    { method: 'GET', path: '/api/dv/status', handler: dvStatusHandler },
    { method: 'POST', path: '/api/dv/reading', handler: dvReadingHandler },
  ],
};
```

**Inter-module communication via EventEmitter bus:**

| Pattern | When to Use | Example |
|---------|-------------|---------|
| Event bus (fire-and-forget) | Module A notifies, Module B reacts | `bus.emit('meter:sample', sample)` -- optimizer listens |
| Event bus (request/response) | Module needs data from another | `bus.emit('gateway:read-register', { asset, register }, callback)` |
| Direct import (shared services) | Shared utilities, DB access | `import { db } from '../core/db.js'` |
| HTTP API (external) | External systems (EOS, EMHASS, EVCC) | REST calls to optimizer containers |

**Why NOT other patterns:**

| Pattern | Why Not |
|---------|---------|
| Message queue (Redis, RabbitMQ) | Massive overkill for single-process. Adds infrastructure dependency on Pi. |
| IPC / child_process.fork | Already exists for runtime-worker split. Module communication within the same process doesn't need IPC. |
| Microservices | Deployment complexity explosion on Pi. DVhub must stay "install and run." |
| Plugin system (npm packages) | Over-engineered. Modules are first-party code, not third-party plugins. |

**Module activation config:**

```json
{
  "modules": {
    "gateway": { "enabled": true },
    "dv": { "enabled": true, "provider": "luox" },
    "optimizer": { "enabled": true, "backends": ["eos", "emhass"] }
  }
}
```

**Confidence: HIGH** -- Modular monolith with EventEmitter is the standard Node.js pattern. It matches the project's constraints perfectly: single-process, Pi-friendly, maintainable.

---

### Deployment: Docker Compose (orchestration) + Native (DVhub itself)

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| systemd | OS-native | DVhub service management | Already in use, proven, zero overhead |
| Docker Compose | v2.x | Orchestrate EOS + EMHASS + EVCC alongside DVhub | Standard for multi-service stacks on Pi |
| Docker Engine | 24.x+ | Container runtime for optimizer services | ARM64 support mature, all targets have images |

**Deployment strategy: Hybrid**

DVhub runs natively (systemd service) because:
1. It needs direct hardware access (Modbus TCP, low-latency polling)
2. It's a single Node.js process with minimal dependencies
3. Native install is simpler for non-technical users (the existing `install.sh` works)
4. No Docker overhead on resource-constrained Pi

External optimizers run in Docker because:
1. EOS is Python with scientific dependencies (numpy, scipy) -- containerized is cleaner
2. EMHASS is Python with its own dependency tree
3. EVCC is a Go binary with its own config
4. Containers provide isolation and easy updates

**Compose stack layout:**

```yaml
# /opt/dvhub/docker-compose.yml
version: "3.8"

services:
  eos:
    image: akkudoktor/eos:latest
    restart: unless-stopped
    ports:
      - "8503:8503"
    volumes:
      - eos-data:/data
    environment:
      - EOS_SERVER__PORT=8503

  emhass:
    image: davidusb/emhass-docker-standalone:latest
    restart: unless-stopped
    ports:
      - "5000:5000"
    volumes:
      - emhass-data:/app/data
    environment:
      - LOCAL_COSTFUN=profit

  evcc:
    image: evcc/evcc:latest
    restart: unless-stopped
    ports:
      - "7070:7070"
    volumes:
      - ./evcc.yaml:/etc/evcc.yaml
    network_mode: host  # needed for mDNS device discovery

volumes:
  eos-data:
  emhass-data:
```

**Three deployment modes:**

| Mode | DVhub | Optimizers | Target User |
|------|-------|-----------|-------------|
| Native-only | systemd | Not installed | DV-only users, minimal setup |
| Hybrid (recommended) | systemd | Docker Compose | Full HEMS users |
| Full Docker | Docker container | Docker Compose | x86 server users, advanced |

**DVhub manages the Compose stack** via a simple wrapper:

```javascript
// dvhub/core/compose-manager.js
import { execFile } from 'node:child_process';

export function startOptimizers() {
  return execFile('docker', ['compose', '-f', '/opt/dvhub/docker-compose.yml', 'up', '-d']);
}
```

**Confidence: HIGH** -- This hybrid approach is proven in the home automation ecosystem (Home Assistant uses the same pattern). EOS, EMHASS, and EVCC all have official Docker images with ARM64 support.

---

### Communication with External Optimizers

| Technology | Protocol | Purpose | Why |
|------------|----------|---------|-----|
| HTTP/REST | JSON over HTTP | EOS API, EMHASS API | Both optimizers expose REST APIs natively |
| Node.js fetch | Built-in | HTTP client for optimizer calls | Already used throughout codebase, zero dependencies |
| EVCC API | REST + WebSocket | EVCC state and control | EVCC exposes REST API at port 7070 |

**Optimizer adapter pattern:**

```javascript
// dvhub/modules/optimizer/eos-adapter.js
export function createEosAdapter(config) {
  const baseUrl = config.eos?.url ?? 'http://localhost:8503';

  return {
    name: 'eos',
    async optimize(input) {
      const res = await fetch(`${baseUrl}/api/optimize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      return res.json();
    },
    async health() {
      const res = await fetch(`${baseUrl}/api/health`);
      return res.ok;
    },
  };
}
```

**Confidence: HIGH** -- All three external systems (EOS, EMHASS, EVCC) provide documented REST APIs.

---

### Supporting Libraries

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| mqtt | ^5.10 | MQTT transport for Victron Venus OS | When `victron.transport = "mqtt"` (already in use) |
| multicast-dns | ^7.2 | mDNS device discovery | Victron system discovery (already in use) |
| Preact | ^10.x | UI component framework | All new frontend components |
| HTM | ^3.x | Tagged template JSX alternative | All new frontend components |

**No new server-side dependencies added.** The modular architecture uses only Node.js built-ins (EventEmitter, fetch, node:sqlite, node:http, node:net, node:crypto).

---

## Alternatives Considered

| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| Database | SQLite (enhanced) | PostgreSQL + TimescaleDB | Overkill for single-site HEMS; adds 100-200MB RAM on Pi; requires separate process |
| Database | SQLite (enhanced) | QuestDB | No ARM64 Docker image; requires JVM (200-500MB RAM); overkill for ~86K rows/day |
| Database | SQLite (enhanced) | InfluxDB 3 | Different query paradigm (line protocol); new/immature; adds infrastructure complexity |
| UI | Preact + HTM | Svelte | Requires build step (compiler); breaks no-build philosophy |
| UI | Preact + HTM | Alpine.js | 3x larger bundle; poor performance in benchmarks for data-heavy UIs |
| UI | Preact + HTM | Vanilla JS (keep) | Doesn't scale past current dashboard complexity; no component model |
| UI | Preact + HTM | Lit (Web Components) | Web Component ceremony adds complexity for internal-only UI |
| Modules | EventEmitter bus | Redis pub/sub | Adds infrastructure dependency; overkill for single-process |
| Modules | EventEmitter bus | Message queue (RabbitMQ) | Massive overkill; adds container and RAM on Pi |
| Deployment | Hybrid (native + Docker) | Full Docker | Adds Docker overhead to DVhub; complicates hardware access |
| Deployment | Hybrid (native + Docker) | Full native | EOS/EMHASS have complex Python dependencies; harder to install/update |

---

## Installation

### DVhub Core (no new dependencies)

```bash
# Existing install -- no changes needed for server-side
cd /opt/dvhub && npm install
```

### Frontend (vendor Preact + HTM locally)

```bash
# One-time download of frontend libraries
mkdir -p dvhub/public/vendor
curl -L -o dvhub/public/vendor/preact.mjs "https://esm.sh/stable/preact@10.25.4/es2022/preact.mjs"
curl -L -o dvhub/public/vendor/preact-hooks.mjs "https://esm.sh/stable/preact@10.25.4/es2022/hooks.js"
curl -L -o dvhub/public/vendor/htm.mjs "https://esm.sh/stable/htm@3.1.1/es2022/htm.mjs"
```

### External Optimizers (Docker Compose)

```bash
# Install Docker + Compose on Pi (if not present)
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker dvhub

# Start optimizer stack
cd /opt/dvhub && docker compose up -d
```

---

## What NOT to Use

| Technology | Why Not |
|------------|---------|
| Express / Fastify / Koa | The codebase uses raw `node:http` and it works. Adding a framework for simple route matching is unnecessary overhead. |
| TypeScript | Would require a build step. The codebase runs raw JS and the added type safety doesn't justify the compilation pipeline on a Pi. |
| Webpack / Vite / esbuild | No build step philosophy. Preact + HTM eliminates the need for JSX transpilation. |
| ORM (Prisma, Drizzle, Knex) | SQLite with raw SQL is faster and more transparent. The query patterns are simple enough to not need abstraction. |
| GraphQL | REST endpoints are simpler, the API surface is manageable, and all consumers are first-party. |
| Redis | No caching layer needed. In-memory state object handles all live data. |
| MongoDB | Document DB is wrong fit for time-series telemetry and relational config data. |
| Electron / Tauri | This is a server-side application accessed via browser. No desktop wrapper needed. |

---

## Sources

### Database
- [QuestDB Raspberry Pi 5 Benchmark](https://questdb.com/blog/raspberry-pi-5-benchmark/)
- [QuestDB vs TimescaleDB vs InfluxDB Comparison](https://questdb.com/blog/comparing-influxdb-timescaledb-questdb-time-series-databases/)
- [TimescaleDB TSBS Benchmark on Raspberry Pi](https://ideia.me/time-series-benchmark-timescaledb-raspberry-pi)
- [PostgreSQL Raspberry Pi Performance](https://blog.rustprooflabs.com/2019/04/postgresql-pgbench-raspberry-pi)
- [SQLite Performance Tuning (WAL, PRAGMA)](https://phiresky.github.io/blog/2020/sqlite-performance-tuning/)
- [SQLite Optimizations for Ultra High Performance](https://www.powersync.com/blog/sqlite-optimizations-for-ultra-high-performance)
- [better-sqlite3 vs node:sqlite Discussion](https://github.com/WiseLibs/better-sqlite3/discussions/1245)
- [InfluxDB 3 ARM64 Docker Image](https://hub.docker.com/r/arm64v8/influxdb/)
- [QuestDB ARM64 Docker Issue](https://github.com/questdb/questdb/issues/844)

### UI Framework
- [Preact + HTM No-Build Approach](https://mfyz.com/react-best-parts-preact-htm-5kb)
- [Preact Without Build Tools (Jason Miller)](https://gist.github.com/developit/3631edd9033df8df5975786b19f16bd8)
- [Preact Server-Side Rendering Guide](https://preactjs.com/guide/v10/server-side-rendering/)
- [Frontend Framework Bundle Size Comparison 2025](https://www.frontendtools.tech/blog/reduce-javascript-bundle-size-2025)
- [Alpine.js Performance Issues (Ryan Solid comment)](https://dev.to/ryansolid/comment/1712l)

### Module Architecture
- [Node.js Modular Monolith (mgce)](https://github.com/mgce/modular-monolith-nodejs)
- [Modular Monolith Patterns (Chris Richardson)](https://microservices.io/post/architecture/2024/09/09/modular-monolith-patterns-for-fast-flow.html)
- [EventBus Pattern in JS](https://yaron-galperin.medium.com/eventbus-pattern-event-driven-communication-in-js-2f29c3875982)
- [Event-Based Architectures in JavaScript (freeCodeCamp)](https://www.freecodecamp.org/news/event-based-architectures-in-javascript-a-handbook-for-devs/)

### Deployment / External Systems
- [Akkudoktor EOS Documentation](https://akkudoktor-eos.readthedocs.io/en/latest/)
- [Akkudoktor EOS Docker Hub](https://hub.docker.com/r/akkudoktor/eos)
- [EMHASS Documentation](https://emhass.readthedocs.io/en/latest/)
- [EMHASS GitHub](https://github.com/davidusb-geek/emhass)
- [EVCC Documentation](https://docs.evcc.io/en/)
- [EVCC Optimizer Docker Discussion](https://github.com/evcc-io/evcc/discussions/23045)
