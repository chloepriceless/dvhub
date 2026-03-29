# Requirements: DVhub v0.4.3 Stability, Quality & Cleanup

**Defined:** 2026-03-29
**Core Value:** Automatische Batterie-Optimierung basierend auf EPEX Day-Ahead Preisen

## v0.4.3 Requirements

Alle offenen Punkte aus v1.0 Audit und v0.4.2 Review.
Gruppiert nach Attack Surface für maximale Parallelisierung.

### Stability

- [x] **STAB-01**: Server hat unhandledRejection / uncaughtException Handler im Hauptprozess — `process.exit(1)` in unhandledRejection, damit systemd den Prozess neu starten kann
- [x] **STAB-02**: Rate Limiter exemptiert LAN-IPs (127.0.0.1, 192.168.x.x) — Bug-Fix: `isLocalNetworkRequest()` existiert bereits in routes-api.js aber wird in `checkRateLimit()` nicht aufgerufen; Dashboard-Polling über 120 req/min triggert aktuell 429-Fehler

### HTTP Enhancements

- [x] **HTTP-01**: GET /health Endpoint antwortet ohne Auth mit 200 und JSON-Status — kompatibel mit Uptime Kuma und Docker HEALTHCHECK (`{ ok: bool, uptimeSec: N, version: string|null }`)
- [x] **HTTP-02**: JSON/Text Responses enthalten Content-Length Header via `Buffer.byteLength(body, 'utf8')` — korrektes Content-Framing inkl. Umlaute (NICHT `body.length` verwenden)
- [x] **HTTP-03**: Alle HTTP Requests werden geloggt (Methode, Pfad, Status, Dauer) via `res.on('finish')` — für Debugging und Monitoring

### Frontend

- [x] **FE-01**: dvCostEur wird korrekt angezeigt — Negations-Bug behoben (1-Zeichen-Fix in `public/history.js:208`)
- [x] **FE-02**: Kritische interaktive Elemente haben aria-labels und keyboard-navigierbar — Accessibility-Basics
- [x] **FE-03**: Static Assets (JS, CSS) werden mit Cache-Control Headers ausgeliefert — Browser-Caching aktiviert (`no-store` für setup.html, `no-cache` für index.html, `max-age=3600` für JS/CSS)

### UI & Branding

- [x] **UI-01**: Alle public pages nutzen compact-topbar statt page-topbar — neue CSS-Klasse `compact-topbar`
- [x] **UI-02**: Navigation vereinfacht zu Leitstand / Einrichtung / Wartung — Umbenennung Einstellungen→Einrichtung, Setup+Tools→Wartung
- [x] **UI-03**: `common.js` exponiert DVhub Branding API — `window.DVhubCommon` mit `getStoredApiToken()`, `apiFetch()`, `dvhub:unauthorized` Event

### Code Quality

- [x] **QUAL-01**: `round2`, `effectiveBatteryCostCtKwh` und `isSmallMarketAutomationRule` sind nicht dupliziert — eine kanonische Implementierung in server-utils.js
- [x] **QUAL-02**: `ctx.buildSmallMarketAutomationRules` ist entfernt — keine orphaned public API surface in market-automation-builder.js
- [x] **QUAL-03**: _old/ Verzeichnis ist entfernt — kein totes Holz im Repository

### Tests & Documentation

- [ ] **TEST-01**: 71 pre-existing Test-Failures sind behoben — Kategorien: (A) async/await für 29 history-runtime Tests, (B) `buildSystemDiscoveryPayload` Export aus system-discovery.js, (C) UI/branding/nav Tests nach UI-01/02/03 Implementierung, (D) Config-Model Felder für telemetry
- [ ] **DOC-01**: Kritische Funktionen in server.js, routes-api.js und schedule-eval.js haben JSDoc-Kommentare mit Parameter- und Return-Typen
- [ ] **DOC-02**: getCfg() Hot-Reload ist durch einen Live-Server-Test verifiziert — nicht nur Code-Inspektion

## Future Requirements

Deferred to future release.

### Performance
- **PERF-01**: Input-Validation /api/epex/backfill (I10) — niedrigere Priorität
- **PERF-02**: TypeScript Migration — eigenes Projekt

### Deferred from v0.4.3
- **STAB-03**: Energy State Schreibzugriffe File-Locking — NICHT NÖTIG: SerialTaskRunner in polling.js serialisiert bereits alle Schreibzugriffe; Node.js Single-Thread eliminiert Race Conditions

## Out of Scope

| Feature | Reason |
|---------|--------|
| TypeScript Migration | Eigenes Projekt, zu groß für Patch-Milestone |
| server.js weitere Aufteilung | v1.0 Refactoring abgeschlossen, Architektur stabil |
| OAuth / externe Auth | Nicht im Scope dieser App |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| STAB-01 | Phase 8 | Complete |
| STAB-02 | Phase 8 | Complete |
| FE-01 | Phase 8 | Complete |
| HTTP-01 | Phase 9 | Complete |
| HTTP-02 | Phase 9 | Complete |
| HTTP-03 | Phase 9 | Complete |
| FE-03 | Phase 9 | Complete |
| FE-02 | Phase 10 | Complete |
| UI-01 | Phase 10 | Complete |
| UI-02 | Phase 10 | Complete |
| UI-03 | Phase 10 | Complete |
| QUAL-01 | Phase 11 | Complete |
| QUAL-02 | Phase 11 | Complete |
| QUAL-03 | Phase 11 | Complete |
| TEST-01 | Phase 12 | Pending |
| DOC-01 | Phase 12 | Pending |
| DOC-02 | Phase 12 | Pending |

**Coverage:**
- v0.4.3 requirements: 17 total
- Mapped to phases: 17
- Unmapped: 0

---
*Requirements defined: 2026-03-29*
*Last updated: 2026-03-29 — revised after investigation: STAB-03 N/A, STAB-02 is bug-fix, TEST-01 breakdown clarified (async/await + export + UI + config), UI-01/02/03 added*
