# Domain Pitfalls

**Domain:** Modular HEMS / Energy Management System (DVhub v2 refactoring)
**Researched:** 2026-03-14

## Critical Pitfalls

Mistakes that cause rewrites, data loss, or production outages in a system that controls real energy hardware.

---

### Pitfall 1: Monolith Decomposition Breaks the DV Real-Time Path

**What goes wrong:** When splitting the 2800-line `server.js` into Gateway, DV, and Optimization modules, developers introduce async boundaries (event emitters, message queues, separate import chains) between the Modbus poll loop and the DV control-value endpoint. The DV Direktvermarkter reads the control value via Modbus slave (registers 0/1/3/4) every few seconds. If the module boundary adds even 200ms of latency or introduces a race condition where the DV module reads stale `state.meter` data, the Direktvermarkter sees incorrect measurements. This triggers compliance issues -- the DV interface is contractually required to deliver accurate, timely readings.

**Why it happens:** The current architecture has zero-cost data sharing: `pollMeter()` writes to `state.meter`, and `controlValue()` reads from the same object in the same event loop tick. Any decomposition that moves these into separate modules with copied state or event-based propagation introduces a propagation delay and potential data staleness.

**Consequences:**
- Direktvermarkter receives stale or zero power readings, leading to incorrect settlement
- Abregelung (curtailment) signals applied late, violating grid operator requirements
- In worst case, contractual penalties from the DV provider

**Prevention:**
- Keep the DV measurement read path and the hardware poll loop in the same process and same event-loop context. Module boundaries should be at the code/import level (separate files, shared in-memory state via dependency injection), NOT at the process level.
- The Gateway module owns the `state` object and exposes it to DV and Optimization modules via a synchronous getter, never via IPC or message passing for real-time values.
- Establish a hard latency budget: DV control-value must reflect a reading no older than `meterPollMs` (currently 2-5 seconds). Add a staleness check to `controlValue()` that logs a warning if the last poll timestamp exceeds 2x the poll interval.
- Write an integration test that verifies: poll -> state update -> controlValue read completes within a single event loop tick.

**Detection:** Monitor the delta between `state.meter.lastPollTs` and the timestamp when the DV Modbus slave serves the value. If this exceeds 10 seconds, alert.

**Phase:** Must be addressed in the very first decomposition phase (module boundary definition). Get this wrong and everything built on top is compromised.

---

### Pitfall 2: Database Migration Data Loss During SQLite-to-New-DB Transition

**What goes wrong:** Migrating from `node:sqlite` (DatabaseSync) to PostgreSQL or TimescaleDB introduces multiple failure modes:

1. **Type coercion surprises:** SQLite uses dynamic typing. The current telemetry store writes numbers as JavaScript numbers without explicit type casting. PostgreSQL enforces strict types -- a value stored as `"123.4"` (string) in SQLite will fail an `INSERT` into a `DOUBLE PRECISION` column in PostgreSQL. The `timeseries_samples` table stores JSON blobs in `snapshot_json` (TEXT in SQLite), which maps to `TEXT` or `JSONB` in PostgreSQL with different validation rules.

2. **AUTOINCREMENT vs SERIAL:** SQLite `INTEGER PRIMARY KEY` auto-increments implicitly. PostgreSQL requires explicit `SERIAL` or `GENERATED ALWAYS AS IDENTITY`. The existing migration files (`db/postgres/migrations/`) use `SERIAL`, but the ORM layer or raw queries in `telemetry-store.js` may assume SQLite behavior.

3. **WAL checkpoint semantics vanish:** The current system relies on SQLite WAL mode with `PRAGMA synchronous = NORMAL` for performance. PostgreSQL has entirely different durability semantics (fsync, WAL archiving). Code that calls `PRAGMA wal_checkpoint(PASSIVE)` will fail silently or error on PostgreSQL.

4. **Historical data migration:** The existing SQLite database contains production telemetry data (samples, rollups, price slots, optimizer runs, market values). A botched migration loses operational history that cannot be regenerated -- VRM backfill only covers the last 365 days.

**Why it happens:** Developers test the new DB schema with fresh data but forget to write and test a one-time migration script for the existing SQLite data. SQLite's lax typing masks data quality issues that only surface on PostgreSQL.

**Consequences:**
- Loss of historical telemetry data (months of energy measurements, price slots, optimizer run history)
- Runtime crashes on INSERT due to type mismatches
- Performance regression if PostgreSQL is not tuned for the Pi's I/O characteristics (see Pitfall 5)

**Prevention:**
- Write the migration script BEFORE implementing the new DB layer. Test it against a copy of a real production SQLite database.
- Implement a dual-write period: new code writes to both SQLite and the new DB for 1-2 weeks. Compare row counts and checksums daily. Only cut over when confidence is high.
- Add explicit type casting in all `INSERT` statements (never rely on implicit coercion).
- Keep SQLite as a fallback: the system should be able to run on SQLite indefinitely for users who do not want PostgreSQL complexity. Make the DB backend configurable, not a forced migration.

**Detection:** After migration, run a validation query comparing row counts, date ranges, and spot-check values between old SQLite and new DB.

**Phase:** Database architecture phase. Must be completed and validated before any module depends on the new DB.

---

### Pitfall 3: Optimizer Computation Blocks the Measurement Path

**What goes wrong:** EOS uses a genetic algorithm that can run for seconds (or longer on a Pi). EMHASS uses linear programming (CVXPY). When DVhub calls the optimizer API (`POST /optimize` for EOS, optimization endpoints for EMHASS) and waits for the response synchronously in the main event loop, it blocks `schedulePollLoop` and `scheduleEvaluateLoop`. During this blockage:
- Modbus poll stops, `state.meter` goes stale
- DV Modbus slave serves stale values
- Schedule evaluation skips cycles
- The system appears "frozen" to the dashboard

**Why it happens:** The current `POST /api/integration/eos/apply` and `POST /api/integration/emhass/apply` endpoints are inbound (the optimizer pushes results to DVhub), which is safe. But when DVhub actively orchestrates optimizers (planned "alles aus einer Box" feature), the temptation is to make synchronous HTTP calls to the optimizer containers and await results. Even with `async/await`, a long-running `fetch()` to a local optimizer that takes 30 seconds ties up the logical flow and can delay other async operations if not carefully architected.

**Consequences:**
- DV measurement delivery interrupted (compliance risk)
- Dashboard shows stale data for 10-60 seconds during optimization runs
- Users perceive the system as hung

**Prevention:**
- Keep the optimizer orchestration strictly fire-and-forget: DVhub sends data to EOS/EMHASS, then the optimizer calls back with results via the existing `/apply` endpoints. Never block on optimizer response.
- If active polling of optimizer results is needed, use a background interval (e.g., check every 5 seconds) that is independent of the measurement poll loop.
- The poll loop (`schedulePollLoop`) must NEVER `await` anything related to optimizer communication. Use `Promise.resolve().then()` or `setImmediate()` to defer optimizer work.
- Set HTTP timeouts on all outbound optimizer calls (5 second max). If the optimizer is slow, log it and move on.

**Detection:** Log the duration of each `evaluateSchedule` cycle. If it exceeds 2x the normal duration (typically <50ms), flag it. Monitor `state.meter.lastPollTs` age.

**Phase:** Optimization module phase. Must be enforced as an architectural rule before any optimizer integration code is written.

---

### Pitfall 4: Multi-Brand Hardware Abstraction That Leaks

**What goes wrong:** Victron and Deye have fundamentally different communication architectures:

| Aspect | Victron | Deye/Sunsynk |
|--------|---------|-------------|
| Protocol | Modbus TCP via GX device | Modbus RTU (RS485) or TCP direct |
| Architecture | Centralized: all devices behind GX | Direct: talk to inverter |
| Register map | Well-documented Excel sheets | Poorly translated Chinese docs |
| Unit ID scheme | Per-device (100=system, 246=battery, etc.) | Typically fixed (1) |
| Control method | ESS setpoint registers (37, 40, 41) | Different register set entirely |
| SOC reporting | Via GX battery service | Direct inverter register |

The temptation is to build a "universal" register abstraction (`hersteller/*.json` config files) that maps both brands to the same internal data model. But the differences are deeper than register addresses:

- **Victron reports system-level aggregates** (total grid power, total PV) via the GX device. Deye reports per-MPPT and per-phase values that must be summed.
- **Control semantics differ:** Victron ESS mode uses a grid setpoint in watts. Deye uses charge/discharge current limits and mode registers. You cannot map one to the other with a simple register translation.
- **Error handling differs:** Victron returns `0xFFFF` for unavailable registers. Deye returns `0x0000` or does not respond.

**Why it happens:** Developers generalize too early, creating an abstraction before understanding both brands deeply. The abstraction leaks when edge cases emerge, leading to brand-specific `if (manufacturer === 'deye')` checks scattered throughout the codebase -- worse than no abstraction at all.

**Consequences:**
- Wrong control commands sent to Deye (e.g., setting a grid setpoint in watts when Deye expects charge current in amps)
- Silent data errors (SOC reported as 0 because the wrong register is read)
- Maintenance burden doubles: every new feature must be tested against both brands

**Prevention:**
- Use a **Strategy pattern**, not a configuration-driven register mapper. Each manufacturer gets its own transport adapter class with a defined interface: `readSystemState(): SystemState`, `applyControlTarget(target: ControlTarget): void`. The adapter handles all brand-specific logic internally.
- Define the **internal data model** (SystemState, ControlTarget) based on what DVhub needs, not on what any single inverter exposes. Let each adapter do the translation.
- Ship Victron support first (it works today). Add Deye support as a separate adapter in a later phase, informed by real hardware testing. Do NOT try to abstract both brands in the initial refactoring.
- The `hersteller/*.json` config approach is fine for register addresses but must NOT be the sole abstraction layer. Business logic differences (aggregation, control semantics) belong in code, not config.

**Detection:** If you see `if (manufacturer === ...)` checks outside of the transport adapter layer, the abstraction is leaking.

**Phase:** Gateway module phase. Define the adapter interface early, implement Victron adapter first, defer Deye to a subsequent phase with real hardware access.

---

### Pitfall 5: PostgreSQL/TimescaleDB Overwhelms the Raspberry Pi

**What goes wrong:** PostgreSQL is a heavyweight database designed for servers. On a Raspberry Pi 4 (4GB RAM, SD card or USB SSD, ARM Cortex-A72):

- **Memory:** PostgreSQL's default `shared_buffers` (128MB), `work_mem` (4MB per operation), and background workers consume 200-400MB at idle. Combined with Node.js (~100-200MB), EOS (Python + genetic algorithm), and EMHASS (Python + CVXPY), the Pi runs out of RAM. The OOM killer starts terminating processes -- often the database itself.

- **Disk I/O:** SD cards have limited write endurance and poor random I/O. PostgreSQL's WAL writes, autovacuum, and checkpointing create constant write pressure. TimescaleDB's chunk management adds further I/O. Research confirms that Docker + database on SD card creates I/O bottlenecks severe enough to freeze the Pi entirely.

- **ARM performance:** Academic benchmarks show PostgreSQL on Raspberry Pi performs acceptably for reads but struggles with concurrent writes. TimescaleDB adds overhead on top. For DVhub's write pattern (1 insert every 2-5 seconds + 5-minute rollups), SQLite is actually faster and lighter.

**Why it happens:** TimescaleDB looks attractive on paper (hypertables, continuous aggregates, compression). But the decision is made based on feature set, not deployment reality. Nobody benchmarks on actual Pi hardware until too late.

**Consequences:**
- System becomes unresponsive during autovacuum or heavy query periods
- OOM kills take down the entire energy management stack
- SD card degradation leads to filesystem corruption and data loss
- Users on Pi (the primary deployment target) have a worse experience than the current SQLite setup

**Prevention:**
- **Default to SQLite for Pi deployments.** The current `node:sqlite` setup handles DVhub's workload well. Enhance it with proper WAL checkpoint management (the CONCERNS.md already identifies this) and add a tiered retention policy.
- **Offer PostgreSQL/TimescaleDB as an optional backend for x86/server deployments** where resources are abundant. Make the DB backend configurable, not a forced upgrade.
- If PostgreSQL on Pi is desired, use **aggressive tuning**: `shared_buffers = 64MB`, `work_mem = 1MB`, `max_connections = 10`, `autovacuum_max_workers = 1`, `maintenance_work_mem = 32MB`. Disable TimescaleDB background workers.
- **Never run PostgreSQL on SD card.** Require an external SSD for any PostgreSQL deployment on Pi.
- Benchmark the actual workload (2-5s inserts, 5-min rollups, dashboard queries) on Pi hardware before committing to the DB choice.

**Detection:** Monitor Pi memory usage (`free -m`) and I/O wait (`iostat`). If memory usage exceeds 80% or I/O wait exceeds 20%, the setup is unsustainable.

**Phase:** Database architecture phase. Benchmark BEFORE committing. The decision here constrains every subsequent phase.

---

### Pitfall 6: Docker Compose Stack Starves the Pi

**What goes wrong:** The planned "alles aus einer Box" deployment runs DVhub + EOS + EMHASS + EVCC as a Docker Compose stack on a Raspberry Pi. Each container carries overhead:

| Component | Estimated Memory | CPU Profile |
|-----------|-----------------|-------------|
| DVhub (Node.js) | 100-200MB | Low, event-driven |
| EOS (Python + genetic algo) | 200-400MB during optimization | CPU-intensive bursts |
| EMHASS (Python + CVXPY + HiGHS) | 150-300MB | CPU-intensive bursts |
| EVCC (Go) | 50-100MB | Low |
| PostgreSQL (if used) | 200-400MB | I/O-intensive |
| Docker daemon overhead | 50-100MB | Constant |
| **Total** | **750MB - 1.5GB** | Concurrent bursts problematic |

On a Pi 4 with 4GB RAM, this leaves 2.5-3.25GB for the OS and buffers. Seems okay -- until EOS and EMHASS run optimizations simultaneously. Both are CPU-bound: EOS's genetic algorithm and EMHASS's LP solver will saturate all 4 cores. During these bursts, DVhub's poll loop gets starved, causing measurement gaps.

Docker on Pi also has specific pathologies:
- `iptables` rule management by Docker slows down networking
- Container layer filesystem (overlay2) adds I/O overhead on already-slow storage
- Docker pull operations for multi-arch images can fill the SD card (images are 500MB-1GB each)

**Why it happens:** Developers test on x86 with 16GB RAM where everything runs fine. The Pi deployment is tested with idle containers, not under optimization load.

**Consequences:**
- Measurement gaps during optimizer runs (DV compliance risk)
- Pi becomes unresponsive via SSH during optimization bursts
- SD card fills up with Docker images and logs
- Users experience random service restarts from OOM killer

**Prevention:**
- **Hybrid deployment as default:** DVhub runs natively (systemd), optimizers run as containers. This gives DVhub priority access to CPU and memory for the real-time measurement path.
- Set **CPU and memory limits** on optimizer containers: `deploy.resources.limits.cpus: '2'` and `deploy.resources.limits.memory: 512M` in docker-compose.yml. This ensures DVhub always has 2 cores and sufficient RAM.
- **Stagger optimizer runs:** Never run EOS and EMHASS simultaneously. Use a scheduler that runs them sequentially with a cooldown period between.
- **Use `nice` or cgroup CPU weights** to give DVhub's poll loop priority over container workloads.
- Store Docker data on an external SSD, never on the SD card.
- Set `log-driver: json-file` with `max-size: 10m` and `max-file: 3` to prevent log bloat.

**Detection:** Monitor with `docker stats` (after enabling cgroup memory accounting in `/boot/cmdline.txt`). Alert if any container exceeds 80% of its memory limit.

**Phase:** Deployment phase. Must be tested on actual Pi hardware under realistic load (concurrent optimization + live polling).

---

### Pitfall 7: Optimizer API Contract Drift

**What goes wrong:** EOS and EMHASS are independent open-source projects with their own release cycles. Their APIs change without notice:

- **EOS** is at v0.2.0 (Nov 2025) with v0.3.0 planned for 2026. The REST API (`/v1/prediction/*`, `POST /optimize`) is still in active development. The genetic algorithm's output format (schedule slots, grid setpoint, charge targets) may change between versions. The existing DVhub integration (`GET /api/integration/eos`, `POST /api/integration/eos/apply`) was built against a specific EOS response format.

- **EMHASS** has been re-engineered (v0.17.0) with a new CVXPY-based optimization engine. The API for standalone use (outside Home Assistant) is still evolving -- GitHub issue #572 from August 2025 shows ongoing discussion about API design for non-HA use cases. Fields like `soc_init`, power arrays, and price arrays in the DVhub EMHASS integration may not match future EMHASS versions.

- **Data format mismatches:** EOS expects 15-minute slots with specific field names. EMHASS expects different field names and potentially different time slot granularity. Timezone handling differs between optimizers. Price units may differ (EUR/MWh vs ct/kWh).

**Why it happens:** Integration code is written against a snapshot of the optimizer API, tested once, and assumed stable. Optimizer projects iterate fast. No contract testing exists between DVhub and the optimizers.

**Consequences:**
- DVhub upgrade breaks optimizer integration silently (no schedule applied, falls back to manual mode)
- Optimizer upgrade breaks DVhub integration (wrong field names, wrong units, wrong time alignment)
- Users on "alles aus einer Box" cannot independently upgrade components

**Prevention:**
- **Version-pin optimizer containers** in docker-compose.yml. Never use `latest` tag.
- Build an **adapter layer** per optimizer with explicit input/output schema validation. When EOS returns a response, validate it against a known schema before applying. Log and reject malformed responses instead of crashing.
- Include **version detection:** On startup, DVhub should query the optimizer's version endpoint (EOS: likely in `/docs` or a health endpoint) and warn if the version is untested.
- Write **contract tests** that run against a mock of each optimizer's API. Include these in CI. When an optimizer releases a new version, update the mock and see what breaks.
- Keep the optimizer data transformation (unit conversion, field mapping, timezone alignment) in a single, well-tested module per optimizer. Never scatter format conversion across the codebase.

**Detection:** Log every optimizer request/response pair. Alert on HTTP errors or schema validation failures. Track optimizer response time (EOS genetic algorithm can be slow on Pi -- 30-60 seconds).

**Phase:** Optimization module phase. Adapter layer must be designed before implementing any optimizer orchestration.

---

## Moderate Pitfalls

---

### Pitfall 8: Modbus Server Exposed Without Authentication

**What goes wrong:** DVhub's Modbus TCP proxy server (`startModbusServer()`) listens on `0.0.0.0:1502` by default. Modbus has no authentication mechanism whatsoever -- any device on the network can read DV registers and, critically, write control signals via FC6/FC16. The `handleWriteSignal` function processes incoming write commands that control feed-in/off state of the energy system.

Real-world attacks on Modbus energy systems are documented: the FrostyGoop malware (2024) used Modbus TCP to cause a two-day heating outage in Lviv, Ukraine. CISA issued advisories in 2025 for Modbus authentication bypass vulnerabilities (CVE-2025-7731, CVSS 8.7).

**Why it happens:** Modbus was designed for isolated industrial networks in the 1970s. Energy systems deployed in residential settings share the network with consumer devices, IoT gadgets, and potentially compromised routers.

**Consequences:**
- Unauthorized actor sends write commands to disable PV feed-in or discharge battery
- Reconnaissance scan discovers the Modbus server and maps register values
- Man-in-the-middle attack injects false Abregelung signals

**Prevention:**
- Implement an **IP allowlist** for the Modbus server. Only the configured Direktvermarkter IP should be allowed to connect. Reject all other connections at the TCP level.
- Add a **buffer size cap** (1024 bytes max for Modbus TCP frames) to prevent memory exhaustion from malicious clients (already identified in CONCERNS.md).
- Bind to a **specific interface** instead of `0.0.0.0` when the Direktvermarkter IP is known. Better yet, bind to `127.0.0.1` and use a firewall rule to NAT the DV traffic.
- Log all Modbus write operations with source IP, register, and value. Alert on writes from unknown IPs.
- Document the **network isolation requirement** prominently in setup instructions.

**Detection:** Log connection attempts to the Modbus server. Any connection from an IP not in the allowlist is suspicious.

**Phase:** Gateway module phase (security hardening). Should be addressed early since the Modbus server already exists and is exposed.

---

### Pitfall 9: Mixed-Resolution Data Creates Storage Bloat and Query Confusion

**What goes wrong:** DVhub collects telemetry at 2-5 second intervals (live samples) but the optimization and DV settlement world operates on 15-minute slots. Storing everything at high resolution creates problems:

- **Storage bloat on Pi:** At 2-second intervals, one measurement point generates ~43,200 rows/day. With a 20-field snapshot JSON per row, this is ~50-100MB/day in SQLite. Over a year, that is 18-36GB -- more than most SD cards can hold.
- **Query performance:** Dashboard queries for "last 24 hours" at full resolution return 43,200 rows. Rendering this in a browser is slow. Queries for "last 30 days" at full resolution are unusable.
- **Semantic confusion:** The 5-minute rollup (`timeseries_rollups`) partially addresses this, but there is no automatic cleanup of raw samples. Over time, raw and rollup data diverge if retention policies are not enforced.

**Why it happens:** The current system already has rollups (5-minute aggregation) but lacks a retention policy for raw samples. The telemetry store creates raw and rollup tables but never deletes old raw data. Adding more data sources (Deye, EVCC, EOS results, EMHASS results) multiplies the storage problem.

**Consequences:**
- SD card fills up, SQLite database becomes corrupt
- Dashboard queries slow down as the database grows
- Users must manually delete old data or the system degrades

**Prevention:**
- Implement a **tiered retention policy**: raw samples kept for 48 hours, 5-minute rollups kept for 90 days, 15-minute aggregates kept indefinitely. Run cleanup on a daily schedule.
- Use **LTTB (Largest Triangle Three Buckets) downsampling** for chart rendering -- send at most 1000 points to the browser regardless of the time range.
- Add a `DELETE FROM timeseries_samples WHERE ts < ?` query to the existing 5-minute rollup job (after confirming rollup succeeded).
- For the optimization module, ONLY store 15-minute aggregates. Never feed raw 2-second data to optimizers.
- Monitor database file size and warn the user when it exceeds a configurable threshold (e.g., 500MB).

**Detection:** Track SQLite file size via `PRAGMA page_count * PRAGMA page_size`. Log a warning when it exceeds the threshold.

**Phase:** Database architecture phase. Must be solved before adding new data sources (Deye, EVCC, optimizer results).

---

### Pitfall 10: Synchronous File Writes Block the Event Loop Under Load

**What goes wrong:** The current codebase uses `fs.writeFileSync` for `persistConfig()` and `persistEnergy()` on the hot path (CONCERNS.md already identifies this). During the refactoring, if new modules add more synchronous file operations (e.g., per-module config files, module state persistence), the cumulative blocking time grows. On a Pi with an SD card, each `writeFileSync` can take 50-200ms when the filesystem is busy. Three synchronous writes in sequence = 150-600ms of event loop blocking. During this time, no Modbus responses are sent, no HTTP requests are served.

**Why it happens:** `writeFileSync` is the "easy" option. It guarantees the write completes before the function returns. Developers use it reflexively, especially during refactoring when "just get it working" pressure is high.

**Consequences:**
- DV Modbus slave fails to respond within the Direktvermarkter's timeout window
- Dashboard appears frozen during config saves
- Poll loop misses cycles, creating gaps in telemetry

**Prevention:**
- Replace all `writeFileSync` with async writes (`fs.promises.writeFile`) + debounce/coalesce. The CONCERNS.md already suggests this.
- Use a **write queue**: batch all file writes into a single `setImmediate` callback that runs after the current event loop tick.
- For `energy_state.json`, write at most once per minute (already the case) but make it async.
- For `config.json`, debounce writes with a 500ms window so rapid config changes (e.g., user clicking through settings) produce a single write.

**Detection:** Instrument `persistConfig` and `persistEnergy` with duration logging. Any write exceeding 50ms is a warning.

**Phase:** Early in the decomposition phase. Fix before adding new modules that might introduce additional file I/O.

---

### Pitfall 11: In-Memory State Object Becomes a God Object

**What goes wrong:** The current `state` object (lines 107-178 in `server.js`) holds everything: meter data, Victron readings, schedule rules, energy integrals, EPEX data, log entries, telemetry status, and DV control state. During modularization, the temptation is to pass this object (or a reference to it) to every module. This creates implicit coupling: every module can read and write any state, making it impossible to understand module boundaries or test modules in isolation.

**Why it happens:** It is the path of least resistance. The state object already exists and works. Passing it to new modules requires zero refactoring of existing code. The alternative (defining per-module interfaces with explicit data contracts) requires upfront design work.

**Consequences:**
- Module boundaries become meaningless: the DV module reads optimizer state, the optimizer reads DV state, everything is coupled through `state`
- Testing a module in isolation requires mocking the entire 70+ field state object
- Concurrent modifications create subtle bugs (e.g., optimizer module modifies `state.epex.data` while the DV module is iterating it)
- Future extraction to separate processes or microservices becomes impossible

**Prevention:**
- Define **per-module state slices** with explicit interfaces. The Gateway module owns `state.meter`, `state.victron`, `state.transport`. The DV module owns `state.dv`. The Optimizer module owns `state.optimizer`, `state.epex`.
- Modules access other modules' state through **read-only getters**, never direct property access. Use `Object.freeze()` on state snapshots passed across module boundaries.
- The Gateway module is the only module that writes to hardware state. Other modules request state changes through a defined command interface (similar to the existing `RuntimeCommandQueue` pattern).
- Introduce a **type definition** (JSDoc or TypeScript interface) for each module's state slice. This makes the contract explicit even without TypeScript compilation.

**Detection:** If a `grep` for `state.` in a module file shows access to state properties that belong to another module, the boundary is leaking.

**Phase:** First phase of decomposition. The state ownership model must be defined before any code is moved.

---

## Minor Pitfalls

---

### Pitfall 12: node:sqlite Experimental API Breakage

**What goes wrong:** `node:sqlite` (DatabaseSync) was introduced as experimental in Node.js 22 and is still evolving. The API surface could change between Node.js minor versions. The `package.json` claims `>=18.0.0` compatibility but `node:sqlite` requires `>=22.5`. A Node.js upgrade could change DatabaseSync behavior or deprecate it.

**Prevention:**
- Update `package.json` engines to `>=22.5.0` (already identified in CONCERNS.md).
- Wrap all SQLite access in the `telemetry-store.js` module -- never use `DatabaseSync` directly elsewhere. This isolates the blast radius of API changes.
- Add a startup version check that fails gracefully with a clear error message.
- Track Node.js release notes for `node:sqlite` stability status. Consider migrating to `better-sqlite3` if `node:sqlite` proves unstable.

**Phase:** Can be addressed at any point, but ideally early (low effort, high impact for deployment reliability).

---

### Pitfall 13: Timezone Boundary Bugs in Multi-System Integration

**What goes wrong:** DVhub, EOS, and EMHASS each handle timezones differently. DVhub uses `Europe/Berlin` throughout. EOS documentation does not specify timezone handling explicitly. EMHASS passes timestamps in various formats. When DVhub sends EPEX price data to EOS with Berlin-local timestamps but EOS interprets them as UTC, optimization schedules are shifted by 1-2 hours. This is particularly insidious during DST transitions (last Sunday of March / October) where a 1-hour shift can cause the optimizer to charge the battery during peak prices instead of off-peak.

**Prevention:**
- Standardize all optimizer communication on **UTC timestamps** (ISO 8601 with `Z` suffix). Convert to/from Berlin time only at the DVhub boundary.
- Add explicit timezone fields in all optimizer request/response payloads.
- Write DST transition tests: verify that the EPEX slot at 02:00 on the last Sunday of March (which does not exist in Berlin time) is handled correctly.
- The existing fragile timezone offset computation (CONCERNS.md: `buildSmallMarketAutomationRules` string-parsing) must be fixed before adding optimizer integrations.

**Phase:** Must be resolved before optimizer integration. The existing timezone fragility compounds with multi-system integration.

---

### Pitfall 14: No Package Lockfile Causes Non-Reproducible Deployments

**What goes wrong:** `.gitignore` excludes `package-lock.json` (already identified in CONCERNS.md). When deploying via `install.sh` (which runs `npm install`), the installed dependency versions vary based on when and where the install runs. A breaking patch release of `multicast-dns` or `mqtt` could break production deployments without any code change in DVhub.

**Prevention:**
- Commit `package-lock.json`. Use `npm ci` in the install script instead of `npm install`.
- Pin exact versions in `package.json` for critical dependencies (`mqtt`, `multicast-dns`).

**Phase:** Should be fixed immediately, before any refactoring increases the dependency count.

---

### Pitfall 15: EOS Configuration Volatility

**What goes wrong:** EOS configuration changes are updated in memory only -- all changes are lost upon restarting the EOS REST server if not saved to the configuration file. If DVhub sends configuration updates to EOS via API and EOS restarts (OOM kill, container restart, update), the configuration reverts to defaults. DVhub must then re-send all configuration, but if DVhub itself has restarted, it may not know what configuration EOS needs.

**Prevention:**
- DVhub should store the EOS configuration it expects as part of its own config. On startup (or on detecting EOS restart), DVhub re-sends the full configuration.
- Implement a health-check loop that verifies EOS is running and configured correctly. If EOS returns unexpected configuration, re-apply.
- Pin EOS container restart policy to `unless-stopped` with memory limits to reduce unexpected restarts.

**Phase:** Optimization module phase.

---

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation |
|-------------|---------------|------------|
| Module boundary definition | State object becomes god object (P11) | Define per-module state slices with read-only cross-module access |
| Module boundary definition | DV real-time path broken by async boundaries (P1) | Keep DV + poll loop in same event loop, synchronous state access |
| Database architecture | PostgreSQL overwhelms Pi (P5) | Default to SQLite on Pi, PostgreSQL optional for servers |
| Database architecture | Migration data loss (P2) | Dual-write period, migration script tested on production data |
| Database architecture | Storage bloat from high-frequency data (P9) | Tiered retention: 48h raw, 90d rollup, infinite 15-min |
| Gateway module | Modbus security exposure (P8) | IP allowlist, buffer cap, specific interface binding |
| Gateway module | Hardware abstraction leaks (P4) | Strategy pattern, ship Victron first, defer Deye |
| Optimizer integration | API contract drift (P7) | Version pinning, schema validation, adapter layer |
| Optimizer integration | Computation blocks measurement (P3) | Fire-and-forget pattern, no synchronous optimizer calls |
| Optimizer integration | Timezone boundary bugs (P13) | UTC normalization, DST transition tests |
| Deployment | Docker stack starves Pi (P6) | Hybrid deployment, CPU/memory limits, staggered optimizer runs |
| Deployment | Non-reproducible installs (P14) | Commit lockfile, use `npm ci` |
| All phases | Synchronous file I/O blocking (P10) | Async writes with debounce |

## Sources

- [SQLite to PostgreSQL Migration Guide](https://www.nihardaily.com/93-how-to-convert-sqlite-to-postgresql-step-by-step-migration-guide-for-developers) - Type mapping and migration pitfalls
- [Performance Evaluation of Docker on Raspberry Pi Models](https://dl.acm.org/doi/fullHtml/10.1145/3616480.3616485) - Container overhead benchmarks on ARM
- [Docker RAM issues on Raspberry Pi](https://forums.raspberrypi.com/viewtopic.php?t=379422) - Real-world OOM experiences
- [Docker Raspberry Pi slow I/O](https://forums.raspberrypi.com/viewtopic.php?t=275070) - SD card I/O bottlenecks
- [EMHASS API usage outside Home Assistant (Issue #572)](https://github.com/davidusb-geek/emhass/issues/572) - Standalone API challenges
- [Akkudoktor EOS Documentation](https://akkudoktor-eos.readthedocs.io/en/latest/) - REST API and integration architecture
- [EOS Integration Guide](https://akkudoktor-eos.readthedocs.io/en/latest/akkudoktoreos/integration.html) - Component integration requirements
- [Time Series Database Comparative Analysis on Raspberry Pi](https://link.springer.com/chapter/10.1007/978-3-030-50426-7_28) - PostgreSQL vs SQLite vs InfluxDB on ARM
- [TimescaleDB Benchmark on Raspberry Pi](https://ideia.me/time-series-benchmark-timescaledb-raspberry-pi) - Real-world TSDB performance on Pi
- [FrostyGoop Modbus TCP Attack](https://rhisac.org/threat-intelligence/frostygoop/) - Real-world Modbus attack on energy systems
- [CISA ICS Vulnerabilities Advisory 2025](https://industrialcyber.co/cisa/cisa-reports-critical-ics-vulnerabilities-across-mitsubishi-schneider-delta-ge-vernova-hitachi-energy-systems/) - CVE-2025-7731 Modbus authentication bypass
- [Modbus Security Issues and Mitigation](https://www.veridify.com/modbus-security-issues-and-how-to-mitigate-cyber-risks/) - Modbus protocol security overview
- [Victron GX Modbus-TCP Manual](https://www.victronenergy.com/live/ccgx:modbustcp_faq) - Victron register documentation
- [Deye Modbus Comms Discussion](https://diysolarforum.com/threads/modbus-comms-with-deye-inverter.46197/) - Deye register map challenges
- [Downsampling High-Frequency Metrics](https://oneuptime.com/blog/post/2026-02-06-interval-processor-downsample-high-frequency-metrics/view) - Tiered retention strategies
- [Pros and Cons of Downsampling](https://edgedelta.com/company/blog/pros-and-cons-of-downsampling-and-aggregating-metrics) - Data fidelity trade-offs
- [Modular Monolith in Node.js](https://thetshaped.dev/p/how-to-better-structure-your-nodejs-project-modular-monolith) - Module boundary patterns

---

*Pitfalls audit: 2026-03-14*
