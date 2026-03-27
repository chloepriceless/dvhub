# Requirements: DVhub Server.js Decomposition (C1)

**Defined:** 2026-03-26
**Core Value:** server.js von 3.669 Zeilen auf ~500 Zeilen reduzieren durch Extraktion in 7-8 fokussierte Module bei 100% API-Kompatibilität

## v1 Requirements

Requirements for the monolith decomposition. Each maps to roadmap phases.

### Foundation

- [x] **FOUND-01**: DI Context Object definiert — exakte Shape `{ state, getCfg, transport, pushLog, telemetrySafeWrite, persistConfig }` dokumentiert und als Template-Pattern etabliert
- [x] **FOUND-02**: getCfg() Getter Pattern implementiert — Module erhalten `getCfg: () => cfg` statt direkte cfg-Referenz, Config Hot-Reload propagiert korrekt
- [x] **FOUND-03**: server-utils.js extrahiert — Pure Utility-Funktionen (nowIso, fmtTs, berlinDateString, addDays, localMinutesOfDay, gridDirection, u16, s16, parseBody, roundCtKwh, resolveLogLimit, shared constants) in eigenes Modul

### Module Extraction

- [x] **MODX-01**: user-energy-pricing.js extrahiert — effectiveBatteryCostCtKwh, mixedCostCtKwh, slotComparison, resolveImportPriceCtKwhForSlot, userEnergyPricingSummary, costSummary als Pure Functions
- [x] **MODX-02**: modbus-server.js extrahiert — createModbusServer Factory mit start()/close() Lifecycle, processModbusFrame, Register Read/Write
- [x] **MODX-03**: epex-fetch.js extrahiert — createEpexFetcher Factory mit fetchEpexDay(), fetchVrmForecast(), epexNowNext()
- [x] **MODX-04**: polling.js extrahiert — createPoller Factory mit pollMeter(), pollPoint(), updateEnergyIntegrals(), start()/stop() Lifecycle. pollMeter + updateEnergyIntegrals bleiben zusammen (Mutation Ordering)
- [x] **MODX-05**: market-automation-builder.js extrahiert — createMarketAutomationBuilder Factory mit buildSmallMarketAutomationRules(), regenerateSmallMarketAutomationRules()
- [ ] **MODX-06**: schedule-eval.js extrahiert — createScheduleEvaluator Factory mit evaluateSchedule(), applyControlTarget(), setForcedOff(), clearForcedOff(), start()/stop()
- [ ] **MODX-07**: routes-api.js extrahiert — createApiRoutes Factory mit handleRequest(req, res, url) für alle ~60 API Endpoints

### Orchestrator

- [ ] **ORCH-01**: server.js ist ~500 Zeilen Orchestrator — Init, State, Config, Module-Wiring, HTTP Server, Polling Loops, Graceful Shutdown
- [ ] **ORCH-02**: Graceful Shutdown ruft alle Module stop()/close() Methoden auf — kein Timer/Socket-Leak bei SIGTERM

### Quality Gates

- [ ] **QUAL-01**: Alle 39 bestehenden Test-Dateien bleiben grün nach jeder Extraktion (`npm test`)
- [ ] **QUAL-02**: Alle API Endpoints behalten exakt ihre URLs, Request- und Response-Formate (100% Backward Compat)
- [ ] **QUAL-03**: Keine neuen npm Dependencies eingeführt
- [ ] **QUAL-04**: Keine zirkulären Import-Abhängigkeiten zwischen extrahierten Modulen
- [ ] **QUAL-05**: Config Hot-Reload funktioniert weiterhin — Änderungen über /api/config POST werden sofort von allen Modulen gesehen

## v2 Requirements

Deferred to future milestone. Tracked but not in current roadmap.

### Testing

- **TEST-01**: Unit Tests für jedes extrahierte Modul (isoliert mit Mock-State)
- **TEST-02**: Integration Test: Server starten → Poll → Schedule Eval → Verify End-to-End
- **TEST-03**: Circular Dependency Check in CI (madge --circular)

### Further Refactoring

- **REFAC-01**: routes-api.js in Sub-Router aufsplitten (routes-admin.js, routes-config.js, routes-telemetry.js)
- **REFAC-02**: Code-Duplikation round2/effectiveBatteryCostCtKwh deduplizieren (I8)
- **REFAC-03**: TypeScript Migration für kritische Pfade (S7)

## Out of Scope

| Feature | Reason |
|---------|--------|
| API Endpoint Umbenennung | Frontend-Änderungen nötig, Scope-Creep Risiko |
| EventEmitter State Pattern | Over-Engineering für Embedded Ein-Personen-Projekt |
| Shared State Singleton Modul | Implizite Kopplung, schlechtere Testbarkeit |
| Bug-Fixes (I1-I10) | Separates Milestone, nicht mit Refactoring mischen |
| Suggestions (S1-S8) | Separates Milestone |
| New Features | Rein internes Refactoring |
| TypeScript Migration | Eigenes Projekt |
| ES6 Classes | Codebase Convention ist Factory Functions |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| FOUND-01 | Phase 1 | Complete |
| FOUND-02 | Phase 1 | Complete |
| FOUND-03 | Phase 1 | Complete |
| MODX-01 | Phase 1 | Complete |
| MODX-02 | Phase 2 | Complete |
| MODX-03 | Phase 2 | Complete |
| MODX-04 | Phase 3 | Complete |
| MODX-05 | Phase 4 | Complete |
| MODX-06 | Phase 4 | Pending |
| MODX-07 | Phase 5 | Pending |
| ORCH-01 | Phase 5 | Pending |
| ORCH-02 | Phase 5 | Pending |
| QUAL-01 | All Phases | Pending |
| QUAL-02 | All Phases | Pending |
| QUAL-03 | All Phases | Pending |
| QUAL-04 | All Phases | Pending |
| QUAL-05 | All Phases | Pending |

**Coverage:**
- v1 requirements: 17 total
- Mapped to phases: 17
- Unmapped: 0

---
*Requirements defined: 2026-03-26*
*Last updated: 2026-03-26 after roadmap creation*
