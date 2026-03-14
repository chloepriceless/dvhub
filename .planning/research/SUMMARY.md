# Project Research Summary

**Project:** DVhub v2 -- Modular HEMS / Energy Management System
**Domain:** Home Energy Management with Direktvermarktung (direct energy marketing)
**Researched:** 2026-03-14
**Confidence:** HIGH (with one gap: FEATURES.md missing)

## Executive Summary

DVhub is a single-site Home Energy Management System running on Raspberry Pi hardware, combining Direktvermarktung (DV) compliance, external optimizer orchestration (EOS, EMHASS), and real-time hardware control via Modbus/MQTT. The research consensus is clear: the system should evolve from its current monolithic `server.js` into a **layered modular monolith** within a single Node.js process, using EventEmitter-based decoupling, a Device HAL for multi-brand hardware support, and an intent-based arbitration layer for safe control resolution. This is the established pattern for resource-constrained IoT systems and matches the Pi deployment constraint perfectly.

The recommended stack stays deliberately minimal: **SQLite (enhanced with WAL + tiered retention)** for data, **Preact + HTM (no build step, ~5KB)** for the UI, and **hybrid deployment** where DVhub runs natively via systemd while external optimizers (EOS, EMHASS, EVCC) run in Docker containers. No new server-side dependencies are introduced. The existing codebase already handles ~86,400 telemetry rows/day well within SQLite's capabilities on Pi. PostgreSQL is documented as an optional upgrade path for server deployments but should not be the default.

The primary risks are: (1) breaking the DV real-time measurement path during decomposition by introducing async boundaries between the poll loop and Modbus slave, (2) optimizer computation blocking the event loop, and (3) Docker containers starving the Pi of resources during concurrent optimization runs. All three are preventable through strict architectural rules -- synchronous state access for DV, fire-and-forget optimizer orchestration, and CPU/memory limits on containers. The decomposition must be incremental: extract Gateway first, then DV module, then Optimizer module, then formalize the arbitration layer.

## Key Findings

### Recommended Stack

The stack maximizes Pi compatibility by avoiding heavyweight dependencies. Every choice was validated against Raspberry Pi 4 resource constraints.

**Core technologies:**
- **SQLite (node:sqlite / better-sqlite3):** Primary database -- zero overhead, in-process, handles DVhub's modest write volume. Enhanced with WAL mode, monthly table partitioning for raw telemetry, and multi-resolution rollups (5-min, 15-min, daily).
- **Preact + HTM (~5KB gzipped):** UI framework with no build step. Loaded from vendored files, supports incremental migration from existing vanilla JS. Full component model (hooks, context, signals) without requiring Babel, Vite, or any transpiler.
- **Node.js EventEmitter:** Inter-module communication bus. Zero dependencies, native to Node.js, sufficient for single-process module decoupling.
- **Docker Compose:** Orchestrates external optimizers (EOS, EMHASS, EVCC) alongside native DVhub. All three have official ARM64 images.
- **systemd:** DVhub service management. Already in production, zero overhead.

**Critical version requirement:** Node.js >= 22.5 (for `node:sqlite` DatabaseSync).

**What NOT to use:** Express/Fastify (raw `node:http` suffices), TypeScript (requires build step), ORMs (raw SQL is faster and more transparent for this workload), Redis (in-memory state object handles live data), any dedicated TSDB (overkill for ~86K rows/day).

### Expected Features

**NOTE: FEATURES.md was not produced by the features researcher.** Feature priorities must be inferred from ARCHITECTURE.md and PITFALLS.md context, and validated during requirements definition.

**Inferred must-haves (table stakes for existing users):**
- Modbus/MQTT meter polling with sub-5-second latency
- DV Direktvermarkter interface (Modbus slave for LUOX and similar providers)
- Curtailment signal processing and compliance
- Live dashboard with real-time meter readings
- Telemetry storage with multi-resolution rollups
- Market price ingestion (EPEX day-ahead)
- Manual grid setpoint control

**Inferred should-haves (v2 differentiators):**
- Pluggable optimizer support (EOS + EMHASS via adapter pattern)
- EVCC integration for EV charging coordination
- Intent-based arbitration with priority resolution
- Multi-brand hardware support (Victron first, Deye later)
- Setup wizard / guided configuration
- History charts with configurable time ranges
- "Alles aus einer Box" Docker Compose deployment

**Inferred defer (v2+):**
- Multi-site management
- PostgreSQL/TimescaleDB backend
- Deye hardware support (needs real hardware testing)
- SaaS/cloud deployment mode

### Architecture Approach

The architecture is a single-process modular monolith with four layers: Gateway (always-on foundation), optional DV and Optimizer modules, and a cross-cutting Arbitration + Execution pipeline. Modules communicate via an EventEmitter bus and share a SQLite data layer with schema-prefixed tables. No module writes to hardware directly -- all control flows through intent-based arbitration with a fixed priority order (Safety > DV Curtailment > Manual Override > Optimizer > Fallback).

**Major components:**
1. **Gateway Module** -- Device HAL, telemetry collection, market data, HTTP server, config management. Always active, depends on nothing.
2. **DV Module** -- Direktvermarkter protocol handling, curtailment processing, measurement export. Optional, depends on Gateway.
3. **Optimizer Module** -- Adapter registry for EOS/EMHASS/EVCC, forecast broker, plan engine with scoring. Optional, depends on Gateway.
4. **Arbitration Layer** -- Priority-based conflict resolution between competing control intents from DV, Optimizer, and manual sources.
5. **Execution Layer** -- Hardware writes via Device HAL, command logging, readback verification. Single point of hardware contact.
6. **Data Layer (SQLite)** -- Shared storage with `shared_`, `dv_`, `opt_`, `exec_`, `telemetry_` table prefixes.

### Critical Pitfalls

1. **DV real-time path breakage (P1)** -- Module decomposition must NOT introduce async boundaries between the poll loop and DV Modbus slave. Keep synchronous in-process state access. Add staleness checks. Test that poll-to-controlValue completes in a single event loop tick.

2. **Optimizer blocking the event loop (P3)** -- Never await optimizer HTTP responses on the measurement hot path. Use fire-and-forget with callback pattern. Set 5-second HTTP timeouts on all outbound optimizer calls.

3. **Docker stack starving the Pi (P6)** -- Hybrid deployment is mandatory on Pi: DVhub native, optimizers containerized. Set CPU/memory limits on containers. Never run EOS and EMHASS simultaneously -- stagger optimization runs.

4. **Optimizer API contract drift (P7)** -- EOS and EMHASS APIs are evolving. Version-pin containers. Build adapter layer with schema validation. Never use `latest` tag.

5. **Modbus server security (P8)** -- The Modbus TCP proxy listens on `0.0.0.0:1502` with zero authentication. Implement IP allowlist, buffer size caps, and specific interface binding before expanding the system's attack surface.

## Implications for Roadmap

Based on research, the decomposition has clear dependency ordering. Phases 2 and 3 are independent of each other but both require Phase 1. Phase 4 requires intents from Phases 2 and 3.

### Phase 1: Foundation -- Gateway Core + Module Infrastructure

**Rationale:** Everything depends on the module system, event bus, Device HAL, and data layer being extracted from the monolithic `server.js`. This is the critical path -- get the boundaries right here and subsequent phases are straightforward. Get them wrong (especially the DV real-time path) and everything is compromised.
**Delivers:** Module registry with lifecycle hooks, internal event bus, Device HAL (Victron driver), extracted telemetry store with tiered retention, HTTP server with module-based route registration, config system with per-module schemas, ~200-line bootstrap `server.js`.
**Addresses:** Core platform stability, DV measurement continuity, data retention management.
**Avoids:** P1 (DV real-time breakage), P10 (sync file I/O), P11 (god object state), P12 (node:sqlite version check), P14 (lockfile).

### Phase 2: DV Module Extraction

**Rationale:** DV functionality is in production and legally binding. It is simpler than the optimizer module and must maintain uninterrupted operation. Extracting it second (after Gateway) validates the module boundary pattern with the most safety-critical code.
**Delivers:** Standalone DV module under `modules/dv/`, DV provider adapters (LUOX), curtailment signal processing, measurement export, DV-specific routes, intent emission for arbitration.
**Addresses:** DV compliance, curtailment handling, negative-price protection.
**Avoids:** P1 (latency budget enforcement), P8 (Modbus security hardening).

### Phase 3: Optimizer Module + External Integrations

**Rationale:** Independent of Phase 2 but requires the Phase 1 module infrastructure. This is the most complex phase with the most external dependencies (EOS, EMHASS, EVCC APIs). Needs the adapter pattern rigorously applied.
**Delivers:** Optimizer adapter registry, EOS adapter, EMHASS adapter, EVCC bridge, plan engine with canonical plan format, plan scoring and selection, forecast broker, Small Market Automation as built-in optimizer, optimizer-specific routes.
**Addresses:** "Alles aus einer Box" vision, multi-optimizer support, economic optimization.
**Avoids:** P3 (event loop blocking), P7 (API contract drift), P13 (timezone bugs), P15 (EOS config volatility).

### Phase 4: Arbitration + Execution Pipeline

**Rationale:** Requires both DV and Optimizer modules to emit intents. This phase formalizes the control pipeline that currently lives as ad-hoc `applyControlTarget` calls throughout the codebase.
**Delivers:** Priority-based arbitration layer, execution layer with command logging, readback verification, deviation alerting, full audit trail for backtesting.
**Addresses:** Safe conflict resolution between DV curtailment and optimizer plans, operational transparency.
**Avoids:** P1 (competing hardware writers), P4 (hardware abstraction leaks).

### Phase 5: Deployment + UI Modernization

**Rationale:** With the module architecture in place, formalize the deployment model (hybrid native + Docker) and begin migrating the dashboard to Preact + HTM.
**Delivers:** Docker Compose stack for optimizers, compose-manager in DVhub, deployment mode selection (native-only / hybrid / full-Docker), Preact + HTM component library, modernized dashboard pages, setup wizard.
**Addresses:** User experience, deployment simplicity, "alles aus einer Box" packaging.
**Avoids:** P6 (Docker Pi starvation -- resource limits, staggered runs), P9 (storage bloat -- LTTB downsampling for charts).

### Phase Ordering Rationale

- **Phase 1 first** because every other phase depends on the module infrastructure, event bus, and clean state ownership model. The existing `server.js` cannot absorb new features without collapsing under its own weight.
- **Phase 2 before Phase 3** because DV is in production, legally binding, and simpler. It validates the module pattern with less risk. If something goes wrong with the boundary, the blast radius is smaller than with the optimizer.
- **Phase 3 is the longest phase** due to multiple external system integrations (EOS, EMHASS, EVCC), each with its own API contract, data format, and timezone behavior.
- **Phase 4 after 2 + 3** because arbitration needs both DV intents and optimizer intents to be meaningful. Building it earlier would mean testing with mock intents only.
- **Phase 5 last** because deployment and UI are not blocking factors -- the current systemd + vanilla JS setup works. Modernization can happen incrementally.

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 3 (Optimizer Module):** EOS and EMHASS APIs are evolving. Need to verify current API contracts against latest releases. EVCC REST API needs validation for loadpoint control. Timezone handling across all three systems needs explicit testing.
- **Phase 4 (Arbitration):** The intent-based control pattern is well-described in academic papers but there are few Node.js reference implementations. The priority model needs validation against real operational scenarios (e.g., what happens when DV curtails during an active battery discharge cycle?).

Phases with standard patterns (skip research-phase):
- **Phase 1 (Gateway Core):** Modular monolith with EventEmitter is a well-documented Node.js pattern. SQLite WAL optimization has extensive community documentation.
- **Phase 2 (DV Module):** The DV functionality already works -- this is extraction, not invention.
- **Phase 5 (Deployment + UI):** Docker Compose orchestration and Preact + HTM are both well-documented with proven patterns.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All recommendations validated against Pi hardware constraints. SQLite benchmarks, Preact bundle sizes, Docker ARM64 support all verified with primary sources. |
| Features | LOW | FEATURES.md was not produced. Feature priorities are inferred from architecture and pitfalls context. Must be validated during requirements definition. |
| Architecture | HIGH | Modular monolith pattern is well-established. Component boundaries, data flow, and event bus design are thoroughly documented with code examples. Decomposition strategy has clear phase ordering. |
| Pitfalls | HIGH | 15 pitfalls identified with real-world citations (FrostyGoop Modbus attack, Raspberry Pi Docker benchmarks, EOS/EMHASS API evolution). Phase-specific warnings are actionable. |

**Overall confidence:** MEDIUM-HIGH (would be HIGH if FEATURES.md existed)

### Gaps to Address

- **FEATURES.md missing:** The features researcher did not produce output. Feature prioritization (table stakes vs. differentiators vs. defer) must be established during requirements definition. The roadmapper should treat the inferred features above as a starting point, not a validated list.
- **Deye hardware specifics:** The pitfalls research identifies Deye as having fundamentally different Modbus semantics than Victron, but no real Deye hardware testing has been done. Defer Deye support and validate with actual hardware before committing to an adapter design.
- **EMHASS standalone API maturity:** GitHub issue #572 (Aug 2025) shows the EMHASS API for non-Home-Assistant use is still being discussed. Verify current state before building the EMHASS adapter.
- **EOS v0.3.0 API changes:** EOS is planning a v0.3.0 release. The adapter should be built against a pinned v0.2.x and updated when v0.3.0 stabilizes.
- **Multi-site scaling:** The architecture intentionally defers multi-site support. If this becomes a requirement, the PostgreSQL upgrade path and `shared.sites` schema are documented but untested.

## Sources

### Primary (HIGH confidence)
- [Akkudoktor EOS Documentation](https://akkudoktor-eos.readthedocs.io/en/latest/) -- REST API, optimization endpoints, integration guide
- [EMHASS Documentation](https://emhass.readthedocs.io/) -- Optimization API, standalone usage
- [EVCC REST API Documentation](https://docs.evcc.io/docs/integrations/rest-api) -- Loadpoint control
- [Victron GX Modbus-TCP Manual](https://www.victronenergy.com/live/ccgx:modbustcp_faq) -- Register documentation
- [SQLite Performance Tuning](https://phiresky.github.io/blog/2020/sqlite-performance-tuning/) -- WAL, PRAGMA optimization
- [SQLite Ultra High Performance](https://www.powersync.com/blog/sqlite-optimizations-for-ultra-high-performance) -- Write batching, partitioning

### Secondary (MEDIUM confidence)
- [HEMS Architecture Survey (Springer)](https://link.springer.com/article/10.1007/s12667-019-00364-w) -- Academic HEMS patterns
- [Cloud Architecture for HEMS (Springer)](https://link.springer.com/article/10.1186/s42162-025-00599-1) -- Event-driven HEMS design
- [EOS Connect Reference Implementation](https://github.com/ohAnd/EOS_connect) -- EOS orchestration patterns
- [Preact + HTM No-Build Approach](https://mfyz.com/react-best-parts-preact-htm-5kb) -- Frontend stack validation
- [FrostyGoop Modbus TCP Attack](https://rhisac.org/threat-intelligence/frostygoop/) -- Real-world Modbus security risk
- [Docker Performance on Raspberry Pi](https://dl.acm.org/doi/fullHtml/10.1145/3616480.3616485) -- Container overhead benchmarks
- [TimescaleDB on Raspberry Pi](https://ideia.me/time-series-benchmark-timescaledb-raspberry-pi) -- TSDB Pi performance

### Tertiary (LOW confidence)
- [EMHASS Standalone API Issue #572](https://github.com/davidusb-geek/emhass/issues/572) -- API design for non-HA use cases (still in discussion)
- [Deye Modbus Registers (HA Community)](https://community.home-assistant.io/t/deye-inverters-and-modbus-registers/935485) -- Community-documented register map

---
*Research completed: 2026-03-14*
*Ready for roadmap: yes (pending FEATURES.md gap resolution)*
