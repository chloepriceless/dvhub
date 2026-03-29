# Roadmap: DVhub

## Milestones

- ✅ **v1.0 Server.js Monolith Decomposition** -- Phases 1-5 (shipped 2026-03-27)
- ✅ **v0.4.2 Security & Stability Hardening** -- Phases 6-7 (shipped 2026-03-29)
- 🚧 **v0.4.3 Stability, Quality & Cleanup** -- Phases 8-12 (in progress)

## Phases

<details>
<summary>v1.0 Server.js Monolith Decomposition (Phases 1-5) -- SHIPPED 2026-03-27</summary>

- [x] Phase 1: Foundation and Leaf Module (2/2 plans) -- completed 2026-03-26
- [x] Phase 2: I/O Modules (2/2 plans) -- completed 2026-03-26
- [x] Phase 3: Polling (2/2 plans) -- completed 2026-03-27
- [x] Phase 4: Automation Core (2/2 plans) -- completed 2026-03-27
- [x] Phase 5: HTTP Layer and Orchestrator Cleanup (3/3 plans) -- completed 2026-03-27

Full details: `.planning/milestones/v1.0-ROADMAP.md`

</details>

<details>
<summary>v0.4.2 Security & Stability Hardening (Phases 6-7) -- SHIPPED 2026-03-29</summary>

- [x] Phase 6: Server-Side Security Hardening (2/2 plans) -- completed 2026-03-27
- [x] Phase 7: Frontend Security & Monitoring Fix (3/3 plans) -- completed 2026-03-29

Full details: `.planning/milestones/v0.4.2-ROADMAP.md`

</details>

## v0.4.3 Phases

### Phase 8: Stability & Bug Fixes

**Goal:** Aktive Produktionsfehler beheben bevor neue Fläche hinzugefügt wird.

**Requirements:** STAB-01, STAB-02, FE-01

**Delivers:**
- Prozess den systemd nach unhandledRejection neu starten kann
- Dashboard-Polling ohne 429-Fehler im LAN
- Korrekte dvCostEur-Anzeige in der Historie

**Plan structure:**
- `08-01`: server.js + routes-api.js + history.js Bug-Fixes (3 Änderungen, ~10 Zeilen)

**Files:** `server.js:895-906`, `routes-api.js:186-224`, `public/history.js:208`

**skip_research:** true — alle Integration-Points sind exakt bekannt (Zeilen, Code-Pattern)

---

### Phase 9: HTTP Enhancements & Caching

**Goal:** /health Endpoint, korrekte Content-Length Header (Umlaut-safe), Access Logging, Browser-Caching.

**Requirements:** HTTP-01, HTTP-02, HTTP-03, FE-03

**Plans:** 2/2 plans complete

Plans:
- [ ] 09-01-PLAN.md — /health endpoint + Content-Length via Buffer.byteLength in json/text/downloadJson helpers
- [ ] 09-02-PLAN.md — Access logging via res.on('finish') + Cache-Control headers for static assets

**Delivers:**
- Öffentlicher `/health` Endpoint für Uptime Kuma
- Korrekter Content-Length Header via `Buffer.byteLength(body, 'utf8')` (Umlaute!)
- Access Logs via `res.on('finish')` in server.js
- Cache-Control Header für Static Assets

**Files:** `routes-api.js:114-122,539-580`, `server.js:717-753`

**Critical pitfall:** HTTP-02 muss `Buffer.byteLength(body, 'utf8')` nutzen, NICHT `body.length` — deutsche Umlaute sind 2 UTF-8 Bytes aber 1 JS-Zeichen. `setup.html` muss `no-store` bekommen.

**skip_research:** true — alle Patterns exakt spezifiziert in SUMMARY.md

---

### Phase 10: Frontend & UI Restructure

**Goal:** Accessibility, compact Topbar, vereinfachte Navigation, DVhub Branding API.

**Requirements:** FE-02, UI-01, UI-02, UI-03

**Delivers:**
- aria-labels für kritische interaktive Elemente
- Kompakte Topbar (CSS-Klasse `compact-topbar`)
- Navigation: Leitstand / Einrichtung / Wartung
- `window.DVhubCommon` in common.js (Token-Storage, apiFetch, `dvhub:unauthorized` Event)
- Macht ~40 branding/nav Tests grün

**Plan structure:**
- `10-01`: common.js DVhub Branding API + Kompakte Topbar HTML/CSS für alle public pages
- `10-02`: Nav-Umbenennung (Einrichtung/Wartung), Setup-Copy, Settings-Compact-Bar + FE-02 aria-labels

**Files:** `public/common.js`, `public/index.html`, `public/settings.html`, `public/tools.html`, `public/setup.html`, `public/styles.css`, `public/setup.js`

**skip_research:** false — test/branding.test.js und test/dashboard-*.test.js vor Planung lesen um genaue Änderungen zu verstehen

---

### Phase 11: Code Quality

**Goal:** Duplikate entfernen, orphaned API-Surface entfernen, totes Holz aufräumen.

**Requirements:** QUAL-01, QUAL-02, QUAL-03

**Delivers:**
- Kanonische round2/effectiveBatteryCostCtKwh/isSmallMarketAutomationRule in server-utils.js
- `ctx.buildSmallMarketAutomationRules` entfernt
- _old/ Verzeichnis entfernt

**Plan structure:**
- `11-01`: QUAL-01 Dedup (server-utils.js Import in config-model.js, history-runtime.js, history-import.js, small-market-automation.js) + QUAL-02 + QUAL-03

**Files:** `server-utils.js`, `config-model.js`, `history-runtime.js`, `history-import.js`, `small-market-automation.js`, `server.js:566`

**Critical check:** Vor QUAL-01: `node --check server.js` — config-model.js hat bewusst zero imports; bei Circular-Dep diesen Skip überspringen

**skip_research:** true — alle Dateien und Funktionen sind bekannt

---

### Phase 12: Tests & Documentation

**Goal:** Alle 71 Test-Failures beheben, JSDoc, Hot-Reload verifizieren.

**Requirements:** TEST-01, DOC-01, DOC-02

**Delivers:**
- 29 history-runtime Tests: async/await hinzufügen
- 2 system-discovery Tests: buildSystemDiscoveryPayload aus system-discovery.js exportieren
- Config-Model Tests: telemetry.dbPath + Interval-Normalisierung Felder hinzufügen
- Verbleibende Tests (nach Phase 10): sollten grün sein
- JSDoc für kritische Funktionen
- Hot-Reload Verifikation

**Plan structure:**
- `12-01`: TEST-01 — async/await in history-runtime.test.js, buildSystemDiscoveryPayload Export, Config-Model Felder
- `12-02`: DOC-01 + DOC-02 — JSDoc in server.js/routes-api.js/schedule-eval.js, Hot-Reload Test

**Files:** `test/history-runtime.test.js`, `system-discovery.js`, `config-model.js`, `test/config-telemetry.test.js`, `server.js`, `routes-api.js`, `schedule-eval.js`

**skip_research:** true — Test-Failures sind analysiert und kategorisiert

---

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1-5 | v1.0 | 11/11 | Complete | 2026-03-27 |
| 6. Server-Side Security | v0.4.2 | 2/2 | Complete | 2026-03-27 |
| 7. Frontend Security & Monitoring | v0.4.2 | 3/3 | Complete | 2026-03-29 |
| 8. Stability & Bug Fixes | v0.4.3 | 1/1 | Complete   | 2026-03-29 |
| 9. HTTP Enhancements & Caching | v0.4.3 | 0/2 | Complete    | 2026-03-29 |
| 10. Frontend & UI Restructure | v0.4.3 | 2/2 | Complete    | 2026-03-29 |
| 11. Code Quality | v0.4.3 | 0/1 | Complete    | 2026-03-29 |
| 12. Tests & Documentation | v0.4.3 | 0/2 | Pending | -- |
