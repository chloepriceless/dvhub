# Project Research Summary

**Project:** PlexLite
**Domain:** Brownfield beginner-friendly UX overhaul for a technical local control webapp
**Researched:** 2026-03-08
**Confidence:** HIGH

## Executive Summary

PlexLite ist bereits funktional stark, aber fuer neue und unerfahrene Nutzer in Setup und Settings zu komplex strukturiert. Die Forschung bestaetigt, dass dieses Problem nicht mit mehr Features oder einem Framework-Wechsel geloest wird, sondern mit klarerer Informationsarchitektur, progressiver Offenlegung und einem gefuehrten Einstieg. Der richtige Ansatz ist deshalb ein inkrementeller Brownfield-Umbau auf Basis der bestehenden Node.js-/Vanilla-JS-Webapp.

Die empfohlene Richtung ist eine Settings-Shell mit linker Seitenleiste, fokussierten Bereichsansichten statt einer Endlosseite, eingeklappten Expertenoptionen und einem Setup-Wizard mit wenigen Entscheidungen pro Schritt. Die groessten Risiken liegen nicht in der Optik, sondern in inkonsistenten Quellen fuer Config-Logik, in zu schwacher Validierung und in riskanten Saves, die Ports, Tokens oder Transport-Konfigurationen veraendern. Roadmap und spaetere Phasen sollten deshalb zuerst Struktur und Sicherheit stabilisieren und erst dann Komfortfunktionen erweitern.

## Key Findings

### Recommended Stack

Die Forschung spricht klar fuer Beibehalten statt Ersetzen: Node.js-Backend, statische HTML/CSS/JS-Seiten und browser-native UI-Primitiven sind fuer diesen Milestone ausreichend und passend. Die groesste technische Verbesserung ist nicht eine neue Runtime, sondern bessere Modulgrenzen, starke Validierung und minimale Testabdeckung fuer Setup-/Settings-Flows.

**Core technologies:**
- Node.js LTS - Runtime und bestehendes Deployment-Modell beibehalten
- Multi-page HTML/CSS/JavaScript - passt direkt zu Setup, Settings, Dashboard und Tools
- Native UI primitives (`<details>`, `<dialog>`, HTML validation) - ideal fuer progressive Offenlegung und gefuehrte UX ohne Rewrite
- `node:test` und optional Playwright - kleinste sinnvolle Absicherung fuer die geplanten UI-Aenderungen

### Expected Features

Die wichtigsten UX-Merkmale fuer diese Produktart sind task-orientierte Navigation, gefuehrtes Setup, versteckte Expertenoptionen, starke Hilfetexte und sichere Save-/Restart-Kommunikation. Differenzieren kann PlexLite vor allem durch eine sehr klare Seitenleisten-Struktur, transportbezogene Vorpruefungen und saubere Uebergaenge zwischen Beginner- und Expertensicht.

**Must have (table stakes):**
- Task-orientierte Settings-Navigation - Nutzer muessen die richtige Einstellungsgruppe schnell finden
- Guided setup wizard - Einsteiger brauchen einen klaren ersten Pfad
- Progressive disclosure - Experten- und Registerdetails muessen standardmaessig verborgen sein
- Save-/Restart-Klarheit - riskante Aenderungen duerfen nicht wie harmlose Textedits wirken
- Transport-spezifische Sichtbarkeit - Modbus und MQTT duerfen nicht gleichzeitig als unkommentierte Feldwolke erscheinen

**Should have (competitive):**
- Sidebar mit klaren Abschnittsbezeichnungen und aktiver Orientierung
- Inherited/default value summaries fuer versteckte Detailwerte
- Transport preflight vor dem eigentlichen Setup
- Diagnostics-Links an den passenden Stellen

**Defer (v2+):**
- Settings-Suche
- Beginner-/Expert-Mode-Switch
- Vorkonfigurierte Setup-Profile

### Architecture Approach

Architektonisch sollte PlexLite bei seiner heutigen Form bleiben, aber die Frontend-Logik unter `dv-control-webapp/public/` intern aufteilen: gemeinsamer Config-Draft-Store, History-/Navigation-State, schema-getriebene Section-Renderer, disclosure metadata und ein Wizard, der dieselbe Config-Quelle wie die Settings-Seite verwendet. Der Fokus liegt auf einem Shared-Model-Ansatz, nicht auf einem SPA-Router.

**Major components:**
1. `config-model.js` als Quelle fuer Defaults, Felddefinitionen und Sichtbarkeitsmetadaten
2. Settings shell mit Sidebar, aktiver Section und Advanced-Disclosures
3. Setup wizard als gefilterte, schrittweise Sicht auf dieselbe Config
4. Validation-/save flow mit Risiko- und Restart-Kommunikation

### Critical Pitfalls

1. **Wizard und Settings driften auseinander** - vermeiden durch gemeinsame Schema-Metadaten und einen geteilten Draft-Store
2. **Wichtige Voraussetzungen werden als "advanced" versteckt** - zuerst Eligibility/Transport klarmachen, erst dann Details einklappen
3. **Riskante Saves wirken zu harmlos** - Token-, Port- und Transportaenderungen brauchen Review- und Recovery-UX
4. **Frontend validiert oberflaechlich, Backend zu schwach** - serverseitige Validierung und Feldfehler sind Pflicht
5. **Vereinfachung versteckt Protokollrealitaet** - Expertendiagnose und technische Escape-Hatches muessen erhalten bleiben

## Implications for Roadmap

Based on research, suggested phase structure:

### Phase 1: Settings Information Architecture Foundation
**Rationale:** Alles Weitere haengt davon ab, dass Setup und Settings nicht laenger zwei unkoordinierte Oberflaechen ueber derselben Config sind.
**Delivers:** section metadata, sidebar-ready structure, audience levels for fields, compact section rendering baseline
**Addresses:** task-oriented navigation, progressive disclosure, schema consistency
**Avoids:** source-of-truth drift and ad hoc hiding logic

### Phase 2: Guided Setup Flow
**Rationale:** Sobald die gemeinsame Struktur steht, kann der bisherige Setup-Assistent auf wenige, klare Schritte reduziert werden.
**Delivers:** wizard-based first-run flow with transport-specific steps and stronger help text
**Uses:** shared schema metadata and validation contracts
**Implements:** beginner-first onboarding without duplicating config logic

### Phase 3: Safe Save and Recovery UX
**Rationale:** Nach besserer Struktur muss das Produkt erklaeren, wann Aenderungen riskant sind und wie man sich bei Zugangsaenderungen wieder verbindet.
**Delivers:** review step, restart-required guidance, reconnect/recovery messaging
**Uses:** restart-sensitive path detection and config diff visibility
**Avoids:** lockout and "saved but broken" scenarios

### Phase 4: Diagnostics and Expert Escapes
**Rationale:** Einsteigerfreundlichkeit darf Experten nicht einsperren; technische Fehlersuche braucht einen klaren, aber nicht dominanten Weg.
**Delivers:** diagnostics links, expert panels, transport checks, bridge from beginner screens to deep detail
**Uses:** existing tools, health endpoints, and transport knowledge
**Implements:** safe expert access without cluttering the primary UX

### Phase 5: Regression Hardening and Polish
**Rationale:** Nach mehreren UX-Eingriffen braucht die Webapp Schutz gegen stillen Funktionsverlust.
**Delivers:** smoke tests for setup/settings/save/import/restart-required flows and final UX polish
**Uses:** node:test and/or Playwright
**Implements:** confidence for future UI work

### Phase Ordering Rationale

- Gemeinsame Struktur kommt vor visueller Verfeinerung, weil sonst Setup und Settings weiter auseinanderlaufen.
- Guided setup baut auf section- und audience-Metadaten auf.
- Safe save/recovery muss nach der neuen Struktur kommen, weil die neue UX sonst riskante Aenderungen zu nett verpackt.
- Diagnostics und Expertensichten sollten gezielt folgen, nicht zuerst, damit sie die neue Beginner-IA nicht ueberlagern.
- Tests kommen spaet genug, um das reale Zielsystem abzudecken, aber noch frueh genug, um Folgearbeit abzusichern.

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 2:** transport preflight and setup step design because Modbus/MQTT and plant prerequisites are domain-specific
- **Phase 3:** reconnect/recovery UX because auth and port changes can break access to a local appliance-style app
- **Phase 4:** diagnostics surfacing because it must serve experts without collapsing beginner simplicity

Phases with standard patterns (skip research-phase):
- **Phase 1:** section-based settings IA, sidebar navigation, and field audience metadata are well-understood patterns
- **Phase 5:** smoke-test hardening is standard once flows are identified

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Existing repo shape already matches the recommended incremental path |
| Features | HIGH | User goals and official UX pattern sources align strongly |
| Architecture | HIGH | The codebase already exposes the seams needed for a shared-schema refactor |
| Pitfalls | HIGH | The main risks are visible directly in current `settings.js`, `setup.js`, and config/save behavior |

**Overall confidence:** HIGH

### Gaps to Address

- Exact section taxonomy for the new sidebar should still be validated during roadmap creation against current field groups and labels.
- The degree of transport preflight automation vs manual explanation should be decided during planning for the setup phase.
- Recovery UX for auth and port changes may need a small implementation spike before finalizing the phase plan.

## Sources

### Primary (HIGH confidence)
- [PatternFly: Navigation](https://www.patternfly.org/components/navigation/) - central navigation guidance for complex application structure
- [PatternFly: Wizard](https://www.patternfly.org/components/wizard/) - guided multi-step flow pattern
- [GOV.UK Design System: Question pages](https://design-system.service.gov.uk/patterns/question-pages/) - one-question-at-a-time and focused journeys
- [GOV.UK Design System: Check a service is suitable](https://design-system.service.gov.uk/patterns/check-a-service-is-suitable/) - preflight and suitability flow guidance
- [W3C WAI-ARIA APG: Accordion Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/accordion/) - accessible progressive disclosure for multi-section content

### Secondary (HIGH confidence within repo)
- [STACK.md](/Volumes/My%20Shared%20Files/CODEX/Plexlite/.planning/research/STACK.md)
- [ARCHITECTURE.md](/Volumes/My%20Shared%20Files/CODEX/Plexlite/.planning/research/ARCHITECTURE.md)
- [PITFALLS.md](/Volumes/My%20Shared%20Files/CODEX/Plexlite/.planning/research/PITFALLS.md)
- [PROJECT.md](/Volumes/My%20Shared%20Files/CODEX/Plexlite/.planning/PROJECT.md)

---
*Research completed: 2026-03-08*
*Ready for roadmap: yes*
