# DVhub v2 — Modulares Energie-Management-System

## What This Is

DVhub ist ein modulares Energie-Management-System fuer Direktvermarktung und Preisoptimierung von PV-Speicher-Anlagen. Es verbindet Wechselrichter, Batteriespeicher, E-Auto-Ladestationen und weitere Geraete ueber ein universelles Gateway und steuert diese basierend auf Boersenpreisen, Fahrplaenen und DV-Signalen. Zielgruppe sind Betreiber von PV-Anlagen mit Batteriespeicher, die an der Stromboerse teilnehmen und ihren Ertrag maximieren wollen.

## Core Value

Das System muss zuverlaessig und in Echtzeit die Direktvermarktungs-Schnittstelle bedienen (Messwert-Lieferung an den Direktvermarkter, Abregelungssignale umsetzen) UND gleichzeitig durch intelligente Preisoptimierung den Boersenertrag und Strombezug optimieren — alles aus einer Box.

## Requirements

### Validated

<!-- Shipped and confirmed valuable — existing functionality from v1. -->

- ✓ Victron ESS Anbindung per ModbusTCP und MQTT — existing
- ✓ DV-Schnittstelle mit LUOX-Direktvermarkter (Modbus Slave, Messwert-Read, Abregelung) — existing
- ✓ Boersenpreis-Anzeige (EPEX Day-Ahead via energy-charts.info) — existing
- ✓ Zeitplan-basierte Anlagensteuerung (Schedule Rules) — existing
- ✓ Kleine Boersenautomatik (automatische Lade-/Entladezeitfenster) — existing
- ✓ Live-Dashboard mit Anlagenzustaenden und Steuerung — existing
- ✓ History-Daten mit VRM-Backfill in 15-Min-Bloecken — existing
- ✓ Telemetrie-Speicherung in SQLite — existing
- ✓ Hersteller-Profile als externe JSON-Config (victron.json) — existing
- ✓ Optional: InfluxDB-Export — existing
- ✓ API-Token-Authentifizierung — existing
- ✓ Systemd-basierte Installation (install.sh) — existing

### Active

<!-- Current scope — the v2 architectural redesign. -->

**Modul-Architektur:**
- [ ] Aufteilung in drei Module: Gateway-Basis, DV-Modul, Optimierungs-Modul
- [ ] Gateway-Basis ist immer vorhanden, mindestens ein weiteres Modul muss aktiv sein
- [ ] Module koennen im Setup/Einrichtungsmenue einzeln aktiviert/deaktiviert werden
- [ ] Klare Modul-Grenzen mit definierten internen APIs/Schnittstellen
- [ ] Shared Endpunkte wo sinnvoll, eigene Modul-Endpunkte wo noetig

**Gateway-Basis-Modul:**
- [ ] Universelle Geraete-Anbindung: ModbusTCP, MQTT, HTTP-Endpunkte, Webhooks
- [ ] Hersteller-Configs externalisiert (jeder Hersteller eigene Config-Datei mit Registern)
- [ ] Unterstuetzung fuer Victron, Deye, und generische Modbus/MQTT-Geraete
- [ ] Telemetrie-Sammlung in konfigurierbarer Aufloesung (hoch fuer Charts, 15min fuer Optimierung)
- [ ] Messpunkt-Verwaltung: Erfassung, Verarbeitung, Speicherung, Abruf
- [ ] Steuerungssignal-Weiterleitung an alle verbundenen Geraete (Speicher, Wechselrichter, etc.)
- [ ] IP-AllowList und optionale Token-Absicherung pro Schnittstelle

**DV-Modul:**
- [ ] Anbindung an verschiedene Direktvermarkter (aktuell LUOX, erweiterbar)
- [ ] Messwert-Uebermittlung an den Direktvermarkter (Read-Signal beantworten)
- [ ] Abregelungssignal-Verarbeitung (0%/100%, offen fuer Zwischenwerte)
- [ ] Steuerungsbefehle an verbundene Anlagen weiterleiten (Abschaltung/Freigabe)
- [ ] Unabhaengig vom Optimierungs-Modul betreibbar

**Optimierungs-Modul (HEMS):**
- [ ] EOS-Integration: Datenversorgung, Fahrplan-Empfang, Optimierungsvorschlaege
- [ ] EMHASS-Integration: Datenversorgung, Fahrplan-Empfang, Optimierungsvorschlaege
- [ ] EVCC-Integration: E-Auto-Planungsdaten und Ladedaten in Datenbasis
- [ ] Boersenertrag-Optimierung mit Fahrplaenen aus EOS/EMHASS
- [ ] Strombezug-Optimierung: Dynamische Tarife, Mehrzeitfenster-Tarife (Octopus), fixe Preise
- [ ] Zeitvariable Netzentgelte (Paragraph 14a, Modul 3)
- [ ] Vorbereitung fuer MISPEL/Pauschaloption (Graustrom-Bezug aus dem Netz)
- [ ] Fahrplan-Engine: Optimierte Plaene umsetzen (PV, Batterie, E-Auto, Waermepumpe, Netzbezug)
- [ ] Dashboard: Live-Daten, DV-Zustaende, Boersenpreise, Planungsengine, Schaltstatus
- [ ] History-Daten mit breiter Datenbasis von allen Endpunkten
- [ ] Plan-Scoring, Vergleich, automatische Winner-Auswahl zwischen Optimierern

**Datenarchitektur:**
- [ ] Austauschbare DB-Schicht (Database Adapter Pattern): TimescaleDB als Default, SQLite als Lightweight-Fallback
- [ ] TimescaleDB-Backend (Default): Hypertables, Continuous Aggregates, native Compression, Retention Policies
- [ ] SQLite-Backend (Fallback): WAL-Optimierung, manuelles Partitioning, eigene Rollup-Engine
- [ ] Multi-Resolution-Datenhaltung: Raw ~1s (7d), 5min (90d), 15min (2y), Daily (forever)
- [ ] Schema-Trennung per Table-Prefix: shared_, dv_, opt_, exec_, telemetry_
- [ ] Monthly partitioned raw-telemetry tables (telemetry_raw_YYYY_MM bei SQLite, Hypertables bei TimescaleDB)
- [ ] Rollup-Engine fuer automatische Aggregation (SQLite manuell, TimescaleDB Continuous Aggregates)
- [ ] Sichere, leistungsfaehige, schnelle Datenstruktur

**Deployment:**
- [ ] Laeuft auf Raspberry Pi (ARM) und x86
- [ ] Container-Deployment moeglich (DVhub + EOS/EMHASS/EVCC als Compose-Stack)
- [ ] Native Installation weiterhin unterstuetzt
- [ ] Hybrid-Modus: DVhub nativ, Optimizer als Container
- [ ] EOS, EMHASS als mitgelieferte Installation ("alles aus einer Box")
- [ ] Minimaler Maintenance-Aufwand ueber alle Deployment-Varianten

**UI/Frontend:**
- [ ] Preact + HTM als UI-Framework (Research-Ergebnis: 5KB, kein Build-Step, inkrementelle Migration)
- [ ] Einstellungs-Oberflaeche fuer alle Stellschrauben
- [ ] Modul-Aktivierung im Setup-Menue
- [ ] Animiertes Power-Flow-Diagramm (PV → Batterie → Haus → Netz)
- [ ] EPEX 15-Minuten-Aufloesung (Markt seit 2025-10-01 auf 96 Preise/Tag umgestellt)
- [ ] Mobile-Responsive Layout
- [ ] Preis-Overlay auf Energy-Timeline
- [ ] Autarkiegrad und Eigenverbrauchsquote als Kennzahlen
- [ ] Forecast-Anzeige (PV + Last aus EOS/EMHASS)

**Sicherheit:**
- [ ] Modbus-TCP-Proxy: IP-AllowList, Interface-Binding, Buffer-Size-Caps
- [ ] Adapter-Pattern fuer externe APIs mit Schema-Validierung (EOS/EMHASS API-Drift)
- [ ] Container-Version-Pinning (nie :latest Tag)
- [ ] User-Rollen-System: readonly, user, admin mit unterschiedlichen Berechtigungen
- [ ] Auth-Token fuer WebSocket-Handshake (Remote-Zugriff via VPN)

**Arbitrierung + Execution:**
- [ ] Intent-basierte Steuerung: Safety > DV > Manual > Optimizer > Fallback
- [ ] Execution-Layer: Hardware-Writes nur ueber Device HAL
- [ ] Command-Logging mit Readback-Verification
- [ ] Deviation-Alerting und Audit-Trail

### Out of Scope

<!-- Explicit boundaries — these come later or are deliberately excluded. -->

- GPIO-Pins fuer Funkrundsteuerempfaenger — spaeter, ueber Modbus RTU I/O-Module (DIN-Hutschiene) oder x86-SBC GPIO oder ESP32+MQTT
- CLS-Steuerboxen — spaeter
- EEBUS-Kommunikation — spaeter
- Blend-Modus (Optimizer-Mixing auf Slot-Ebene) — erst nach genug Evidenz
- Weitere DV-Anbieter neben LUOX — erst wenn Schnittstellen bekannt
- SMA-Wechselrichter — v1 fokussiert auf Victron, Deye, generisch

## Context

**Bestehende Codebase:** Monolithischer Node.js Server (~2800 Zeilen server.js), ES Modules, kein Framework, node:sqlite fuer Telemetrie, Vanilla HTML/JS Frontend. Funktioniert produktiv mit Victron-Hardware und LUOX-Direktvermarkter.

**Zielplattform:** Primaer x86 (Server, VM, NAS, Mini-PC). Pi bleibt als Edge-Option, treibt aber nicht die Architektur-Entscheidungen. GPIO-Zugriff (Funkrundsteuerempfaenger, CLS) ueber externe Modbus-RTU-I/O-Module (DIN-Hutschiene + USB-RS485-Adapter), nicht ueber onboard GPIO. Alternativ: x86-SBCs mit GPIO (Radxa X4, LattePanda Mu) oder ESP32+MQTT fuer verteilte I/O.

**Neue Dependencies (v2):** Fastify (HTTP + Ajv Validierung + Pino Logging), @fastify/websocket (ws), RxJS (interner Event-Bus mit BehaviorSubject), pg (PostgreSQL-Treiber fuer TimescaleDB Default). Optional: node:sqlite als Fallback-Backend.

**Vorhandene Architektur-Dokumente:** Vier detaillierte Design-Dokumente existieren unter `docs/plans/2026-03-10-*`:
- PostgreSQL Schema Blueprint (4 Schemas: shared, dv, opt, exec) — dient als Referenz fuer TimescaleDB-Backend
- Optimizer Orchestrator Implementation Plan (12 Tasks)
- Optimizer Orchestrator Design (6-Layer Architektur)
- Data Architecture Masterlist (MVP + Phase 2 Tabellen)

Diese Dokumente dienen als Referenz. DB ist austauschbar: TimescaleDB/PostgreSQL (Default) oder SQLite (Lightweight-Fallback).

**Codebase-Map:** Detaillierte Analyse unter `.planning/codebase/` (7 Dokumente, 1360 Zeilen).

**Externe Systeme:**
- EOS (Energieoptimierungssystem) — externer Optimizer, soll mitgeliefert werden
- EMHASS (Energy Management for Home Assistant) — zweiter Optimizer
- EVCC (Electric Vehicle Charge Controller) — EV-Ladedaten und -Steuerung
- Victron VRM API — groesste Datenbasis fuer Backfill
- energy-charts.info — EPEX Day-Ahead Preise
- Bundesnetzagentur — Anzulegender Wert

## Constraints

- **Platform**: Primaer x86 (Server, VM, NAS, Mini-PC). Pi als Edge-Option unterstuetzt aber nicht Architektur-treibend. GPIO extern ueber Modbus RTU I/O-Module
- **Node.js**: Node.js >= 22.5 als Runtime (wegen node:sqlite), Wechsel nur wenn Research Phase bessere Alternative zeigt
- **Echtzeit**: DV-Messwert-Lieferung und Abregelung muessen in Echtzeit funktionieren — keine Verzoegerung durch Optimizer-Logik
- **Wartbarkeit**: Modulare Struktur, keine zu komplexe Codestruktur, einzelne Teile austauschbar
- **Best Practices**: Jede Technologie und jeder Endpunkt nach Best Practices implementiert
- **Abwaertskompatibilitaet**: Bestehende Funktionalitaet (DV, Schedule, Dashboard) darf nicht brechen

## Key Decisions

<!-- Decisions that constrain future work. Add throughout project lifecycle. -->

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| 3 Module: Gateway + DV + Optimierung | Universalitaet und unabhaengiger Betrieb, mindestens ein Modul neben Gateway aktiv | ✓ Confirmed — In-Process Modular Monolith (kein Microservice) |
| Hersteller-Configs externalisiert | Keine hart-verdrahteten Register im Code, User kann eigene Configs anlegen | ✓ Confirmed — Device HAL mit Driver-Interface |
| DB: TimescaleDB als Default | TimescaleDB/PostgreSQL Default (x86), SQLite als Lightweight-Fallback. Database Adapter Pattern | ✓ Decided — TimescaleDB Default + SQLite Fallback |
| UI: Preact + HTM (kein Build-Step) | 5KB total, React-API, tagged templates statt JSX, inkrementelle Migration. Beste Wahl nach Vergleich mit Vue, Svelte, Alpine, Lit, Solid | ✓ Decided — Preact 10.x + HTM 3.x |
| Deployment: Hybrid als Default | DVhub nativ via systemd, EOS/EMHASS/EVCC als Docker Container mit CPU/Mem Limits | ✓ Decided — Hybrid Default, Full-Docker optional |
| Modul-Trennung als erste Prioritaet | Architektur-Fundament muss stehen bevor Features drauf gebaut werden | ✓ Confirmed |
| Victron + Deye + generisch fuer v1 | Victron als Hauptplattform, Deye als zweiter Hersteller, generisch fuer alles andere | ✓ Confirmed — Fronius als bester erster Non-Victron Kandidat |
| Interner Bus: RxJS BehaviorSubject | Synchrone Reads via getValue() fuer DV-Echtzeit-Pfad, Operatoren fuer komplexe Event-Flows, 1 npm-Paket | ✓ Decided — RxJS statt EventEmitter |
| HTTP-Framework: Fastify | Ersetzt 50 if/else-Routing-Branches, bringt Ajv (Validierung) + Pino (Logging) mit. Bester Wert pro Dependency | ✓ Decided — Fastify + @fastify/websocket |
| WebSocket: ws (via @fastify/websocket) | Standard-WebSocket, universell, kein eigenes Protokoll. Socket.io Overkill fuer LAN+VPN Use Case | ✓ Decided — ws, kein Socket.io |
| DV-Echtzeit-Pfad: synchron in-process | DV-Messwert darf NICHT async werden — Vertragliche Pflicht, Latenz-Budget 2x pollInterval | ✓ Architectural Rule |
| Dependencies: Strategisch minimal | Fastify + RxJS + ws + pg als Kern-Dependencies. node:sqlite nur bei Fallback. Keine Express, Socket.io, Winston, PM2 | ✓ Decided |
| Zielplattform: x86 primaer | x86 (Server/VM/NAS/Mini-PC) als primaere Plattform. Pi nur Edge-Option, treibt nicht die Architektur | ✓ Decided |
| GPIO: Extern ueber Modbus RTU | GPIO-Zugriff (FRE, CLS) ueber DIN-Hutschienen Modbus-I/O-Module + USB-RS485. Kein onboard GPIO noetig | ✓ Decided — Alternativ: x86-SBC (Radxa X4), ESP32+MQTT |
| User-Rollen | readonly / user / admin — Grundstruktur fuer Remote-Zugriff via VPN vorbereiten | ✓ Decided — Auth-Token bei WS-Handshake |
| MQTT nur fuer Geraetekommunikation | MQTT (Mosquitto) bleibt fuer Hardware-Anbindung. Interner Bus ist RxJS, nicht MQTT | ✓ Decided |

## Traceability

| Requirement | Description | Phase | Status |
|-------------|-------------|-------|--------|
| ARCH-01 | Three modules: Gateway, DV, Optimizer | Phase 1 | Pending |
| ARCH-02 | Gateway always present, at least one other active | Phase 1 | Pending |
| ARCH-03 | Module activation/deactivation in setup menu | Phase 8 | Pending |
| ARCH-04 | Clear module boundaries with defined internal APIs | Phase 1 | Pending |
| ARCH-05 | Shared endpoints where universal, own where needed | Phase 1 | Pending |
| GW-01 | Universal device connectivity (ModbusTCP, MQTT, HTTP, Webhooks) | Phase 1 | Pending |
| GW-02 | Externalized manufacturer configs | Phase 1 | Pending |
| GW-03 | Support Victron, Deye, generic Modbus/MQTT | Phase 1 | Pending |
| GW-04 | Multi-resolution telemetry collection | Phase 2 | Pending |
| GW-05 | Messpunkt management (capture, process, store, retrieve) | Phase 1 | Pending |
| GW-06 | Control signal forwarding to connected devices | Phase 1 | Pending |
| GW-07 | IP AllowList and optional token auth per interface | Phase 1 | Pending |
| DV-01 | Multiple DV provider support (LUOX, extensible) | Phase 3 | Pending |
| DV-02 | Measurement delivery to DV provider (Read signal) | Phase 3 | Pending |
| DV-03 | Curtailment signal processing (0%/100%, intermediate) | Phase 3 | Pending |
| DV-04 | Control commands to connected systems | Phase 3 | Pending |
| DV-05 | Operable independently from Optimizer module | Phase 3 | Pending |
| OPT-01 | EOS integration | Phase 4 | Pending |
| OPT-02 | EMHASS integration | Phase 4 | Pending |
| OPT-03 | EVCC integration | Phase 5 | Pending |
| OPT-04 | Market price optimization with schedules | Phase 4 | Pending |
| OPT-05 | Grid import optimization (dynamic/multi-window/fixed tariffs) | Phase 5 | Pending |
| OPT-06 | Time-variable network charges (Paragraph 14a, Module 3) | Phase 5 | Pending |
| OPT-07 | MISPEL/Pauschaloption preparation | Phase 5 | Pending |
| OPT-08 | Schedule engine (PV, battery, EV, heat pump, grid) | Phase 4 | Pending |
| OPT-09 | Dashboard: live data, DV states, prices, planning, switches | Phase 5 | Pending |
| OPT-10 | History data from all endpoints | Phase 5 | Pending |
| OPT-11 | Plan scoring, comparison, winner selection | Phase 4 | Pending |
| DATA-01 | Database Adapter Pattern (TimescaleDB Default, SQLite Fallback) | Phase 2 | Pending |
| DATA-02 | Multi-resolution data retention | Phase 2 | Pending |
| DATA-03 | Schema separation via table prefix | Phase 2 | Pending |
| DATA-04 | Monthly partitioned raw telemetry (SQLite) / Hypertables (TimescaleDB) | Phase 2 | Pending |
| DATA-05 | Rollup engine (manual for SQLite, Continuous Aggregates for TimescaleDB) | Phase 2 | Pending |
| DATA-06 | Secure, performant, fast data structure | Phase 2 | Pending |
| DEPLOY-01 | Runs on Raspberry Pi (ARM) and x86 | Phase 7 | Pending |
| DEPLOY-02 | Container deployment possible (Docker Compose) | Phase 7 | Pending |
| DEPLOY-03 | Native installation supported | Phase 7 | Pending |
| DEPLOY-04 | Hybrid mode (DVhub native, Optimizer as container) | Phase 7 | Pending |
| DEPLOY-05 | EOS/EMHASS as bundled installation | Phase 7 | Pending |
| DEPLOY-06 | Minimal maintenance overhead | Phase 7 | Pending |
| UI-01 | Preact + HTM as UI framework | Phase 8 | Pending |
| UI-02 | Settings UI for all configuration | Phase 8 | Pending |
| UI-03 | Module activation in setup menu | Phase 8 | Pending |
| UI-04 | Animated power flow diagram | Phase 8 | Pending |
| UI-05 | EPEX 15-minute resolution | Phase 8 | Pending |
| UI-06 | Mobile-responsive layout | Phase 8 | Pending |
| UI-07 | Price overlay on energy timeline | Phase 8 | Pending |
| UI-08 | Autarky and self-consumption metrics | Phase 8 | Pending |
| UI-09 | Forecast display (PV + load from EOS/EMHASS) | Phase 8 | Pending |
| SEC-01 | Modbus TCP Proxy security (AllowList, binding, caps) | Phase 1 | Pending |
| SEC-02 | Adapter pattern with schema validation | Phase 4 | Pending |
| SEC-03 | Container version pinning (never :latest) | Phase 4 | Pending |
| SEC-04 | User roles: readonly, user, admin with permissions | Phase 1 | Pending |
| SEC-05 | Auth token for WebSocket handshake (VPN remote access) | Phase 1 | Pending |
| EXEC-01 | Intent-based control (priority chain) | Phase 6 | Pending |
| EXEC-02 | Execution layer: writes only through Device HAL | Phase 6 | Pending |
| EXEC-03 | Command logging with readback verification | Phase 6 | Pending |
| EXEC-04 | Deviation alerting and audit trail | Phase 6 | Pending |

---
*Last updated: 2026-03-14 after roadmap creation*
