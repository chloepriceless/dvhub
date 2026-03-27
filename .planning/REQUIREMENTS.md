# Requirements: DVhub v0.4.2 Security & Stability Hardening

**Defined:** 2026-03-27
**Core Value:** Automatische Batterie-Optimierung basierend auf EPEX Day-Ahead Preisen

## v0.4.2 Requirements

Requirements for this security/stability release. Each maps to roadmap phases.

### Security Hardening

- [x] **SEC-01**: Git Update-Endpoint speichert aktuelle Revision vor Update und fuehrt vollstaendigen Rollback (git checkout + npm install) durch wenn npm install fehlschlaegt
- [x] **SEC-02**: LAN Auth-Bypass beschraenkt sich auf read-only Endpoints -- Hardware-Steuerung und Admin-Endpoints (Update, Restart) erfordern Token auch im LAN
- [x] **SEC-03**: Frontend-Code nutzt textContent/DOM-API statt innerHTML fuer dynamischen Content um XSS zu verhindern
- [x] **SEC-04**: PostgreSQL-Queries in telemetry-store-pg.js nutzen ausschliesslich parameterized Queries -- keine Template-Literal-Interpolation fuer Tabellennamen/Spalten ohne assertSqlIdentifier-Validierung

### Bugfix

- [ ] **BUG-01**: Monitoring Heartbeat zeigt korrekten SOC-Wert (state.victron.soc statt state.battery?.soc)

## Future Requirements

Deferred to future release. Tracked but not in current roadmap.

### Stability

- **STAB-01**: unhandledRejection / uncaughtException Handler im Hauptprozess (C2)
- **STAB-02**: Rate Limiting auf allen Endpoints (I2)
- **STAB-03**: Energy State Race Condition mit File-Locking (I5)

### Code Quality

- **QUAL-01**: Code-Duplikation bereinigen (round2, effectiveBatteryCostCtKwh, isSmallMarketAutomationRule) (I8)

### Suggestions

- **SUGG-01**: Health-Check Endpoint ohne Auth fuer Monitoring/Docker (S1)
- **SUGG-02**: Content-Length Header fuer JSON Responses (S2)
- **SUGG-03**: Accessibility Improvements (S3)
- **SUGG-04**: HTTP Access Logging (S4)
- **SUGG-05**: Cache-Headers fuer Static Assets (S5)
- **SUGG-06**: _old/ Verzeichnis entfernen (S6)
- **SUGG-07**: JSDoc/TypeScript fuer kritische Pfade (S7)
- **SUGG-08**: dvCostEur Display-Fix (S8)

## Out of Scope

| Feature | Reason |
|---------|--------|
| server.js weitere Aufteilung | v1.0 Refactoring abgeschlossen, Architektur stabil |
| CORS-Konfiguration (I3) | Bereits in v1.0 implementiert |
| Duplikat-Dateien loeschen (I6) | Separater Cleanup, kein Security-Thema |
| Input-Validation /api/epex/backfill (I10) | Niedrigere Prioritaet, future milestone |
| TypeScript Migration | Eigenes Projekt |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| SEC-01 | Phase 6 | Complete |
| SEC-02 | Phase 6 | Complete |
| SEC-03 | Phase 7 | Complete |
| SEC-04 | Phase 6 | Complete |
| BUG-01 | Phase 7 | Pending |

**Coverage:**
- v0.4.2 requirements: 5 total
- Mapped to phases: 5
- Unmapped: 0

---
*Requirements defined: 2026-03-27*
*Last updated: 2026-03-27 after roadmap creation*
