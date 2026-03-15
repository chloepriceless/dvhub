---
phase: 12
type: context
created: 2026-03-15
---

# Phase 12: Dashboard Data & Controls — Context

## Decision 1: KPI-Karten Layout
**Choice:** Eigene Karten in neuer Row 2
**Details:** Drei neue Panel-Karten als Row 2 im Dashboard-Grid:
- **EPEX-Preise (span-4):** Aktueller Slot-Preis, naechster Slot-Preis, heute Min/Max in ct/kWh
- **Kosten (span-4):** Import-Kosten, Export-Erloese, Netto-Kosten mit Farbcodierung (gruen=Gewinn, rot=Kosten). Zeitraum: Heute (seit Mitternacht), aus costSummary()
- **System-Status (span-4):** 3-Phasen Netzleistung (L1/L2/L3), DV-Feedback (DC/AC Flags), Neg-Preis-Status, Modbus Keepalive Timestamp

**Layout:**
```
Row 1: PowerFlow(6) | Kennzahlen(3) | Steuerung(3)   [bestehend]
Row 2: EPEX-Preise(4) | Kosten(4) | System-Status(4)  [NEU]
Row 3: Price Chart(12)                                 [bestehend]
...
```

## Decision 2: Control Panel Interaktion
**Choice:** Min SOC Slider mit Blink-Animation + Ladestrom freies Zahlenfeld
**Details:**
- **Min SOC Slider:** Range-Slider 0-100%. Nach Aenderung blinkt der Wert orange bis API 200 zurueckgibt. Dann gruen fuer 2s, dann normal. Bei Fehler rot + Fehlermeldung.
- **Ladestrom Input:** Freies Zahlenfeld, Min/Max dynamisch aus Config-Model (NICHT hardcoded). Anlagengroessen variieren stark (0-1000A+). Enter zum Senden.
- **EPEX Refresh Button:** Einfacher Button "EPEX aktualisieren" im Control Panel, loest POST /api/control/epex-refresh aus.
- Alle Schreibvorgaenge nutzen die bestehende sendControl()-Infrastruktur mit controlMsg Signal.

## Decision 3: Schedule Inline-Editing
**Choice:** Inline-Editing in Tabelle + Default-Inputs oben im Panel
**Details:**
- **Inline-Edit:** Klick auf Tabellenzeile macht Felder editierbar (Inputs statt Text). Speichern/Abbrechen-Buttons erscheinen. Loeschen-Button pro Zeile.
- **Neue Regel:** '+' Button unter der Tabelle fuegt leere editierbare Zeile hinzu.
- **Default-Inputs:** Zwei Eingabefelder OBERHALB der Regel-Tabelle im Schedule-Panel: "Standard Netz-Sollwert (W)" und "Standard Ladestrom (A)". Schreiben via POST /api/config/save.
- **API:** Regeln via POST /api/schedule/rules (create/update/delete). Defaults via config-save.

## Decision 4: Aktive Schedule-Werte Platzierung
**Choice:** Im Schedule-Panel unter den Defaults
**Details:**
- Zwischen Default-Inputs und Regel-Tabelle eine "Aktive Werte"-Sektion:
  - Grid Setpoint: aktueller Wert + welche Regel ihn setzt
  - Ladestrom: aktueller Wert
  - Min SOC: aktueller Wert
  - Letzte Aenderung: Timestamp des letzten control-write
- Daten kommen aus WebSocket telemetry (ctrl + schedule Felder)

## Code Context
**Bestehende Dateien (zu erweitern):**
- `dvhub/public/components/dashboard/dashboard-page.js` — Grid-Layout, Component-Imports
- `dvhub/public/components/dashboard/kpi-cards.js` — Bestehende 4 Metriken (unveraendert)
- `dvhub/public/components/dashboard/control-panel.js` — DV-Steuerung + Buttons
- `dvhub/public/components/dashboard/schedule-panel.js` — Read-only Regel-Tabelle
- `dvhub/public/components/shared/use-signal-store.js` — Signal-Store mit telemetry, prices, etc.
- `dvhub/public/components/shared/format.js` — Formatierungshilfsfunktionen

**Neue Dateien:**
- `dvhub/public/components/dashboard/epex-card.js` — EPEX-Preis-KPI-Karte
- `dvhub/public/components/dashboard/cost-card.js` — Kosten-Karte (heute)
- `dvhub/public/components/dashboard/status-card.js` — System-Status-Karte

**API-Endpunkte (bestehend, genutzt):**
- GET /api/status — Alle Telemetrie + Kosten + Schedule
- POST /api/control/write — Steuerbefehle (switch, setpoint, minSoc, chargeCurrent)
- POST /api/config/save — Config-Aenderungen (defaults)
- GET /api/schedule — Schedule-Regeln
- WebSocket telemetry — Live-Updates inkl. costs, ctrl, keepalive (Phase 11)

## Deferred Ideas
- Monatliche Kostenansicht (gehoert zu Phase 16: History Parity)
- Chart-basierte Schedule-Erstellung per Drag (Phase 13: Chart Interactivity)
