# Phase 13: Chart Interactivity - Context

**Gathered:** 2026-03-15
**Status:** Ready for planning

<domain>
## Phase Boundary

Price chart supports interactive slot selection for schedule creation, detailed tooltips with margin comparisons, import price overlay, and a price comparison summary — matching the old system's chart functionality. No new chart types or history charts.

</domain>

<decisions>
## Implementation Decisions

### Slot-Selektion & Schedule-Erstellung
- Mousedown + Drag ueber Balken selektiert zusammenhaengenden Bereich. Einzelklick = 1 Slot.
- CSS-Klasse `is-selected` faerbt selektierte Balken (wie altes System: `chartSelectionState` pattern)
- Callout-Banner erscheint **im Chart-Panel direkt unter dem SVG** (kein Floating, kein Layout-Shift)
- Callout zeigt: "X Balken markiert | 08:00-12:00 | 14:00-16:00" + "Schedule erstellen" Button
- Button speichert **direkt als Regeln** via POST /api/schedule/rules (nicht erst ins Panel einfuegen)
- Neue Regeln bekommen automatisch die **Default-Werte** aus Schedule-Config (defaultGridSetpointW, defaultChargeCurrentA)
- Nach erfolgreichem Speichern wird die Selektion **automatisch geloescht** (auto-clear)
- Feedback: kurze controlMsg "X Regeln erstellt"

### Hover-Tooltip
- **Floating neben Cursor** (position: fixed, offset +12px X/Y), folgt der Maus
- Inhalt pro Slot: Zeitslot | Boerse X ct | Bezug X ct | PV +/-X ct | Akku +/-X ct | Gemischt +/-X ct
- Alle Margin-Daten kommen aus `slotComparison()` (Backend liefert: importPriceCtKwh, spreadToImportCtKwh, pvMarginCtKwh, batteryMarginCtKwh, mixedMarginCtKwh)
- Tooltip verschwindet bei mouseleave vom Chart

### Import-Preis-Overlay
- **Gestrichelte gruene Polyline** (stroke-dasharray, --chart-import: #22c55e) ueber den Balken
- Verbindet Import-Preise (Bezugskosten) pro Slot als Linienchart
- **Null-Baseline**: rote Referenzlinie bei 0 ct (--chart-negative, stroke-width 1.5)
- Import-Daten aus userEnergyPricing comparisons Array (per Slot-Timestamp gejoined)

### Margin-Zusammenfassung (oberhalb Chart)
- Platzierung: **oberhalb des SVG** im Chart-Panel
- Zeile 1: "Jetzt: Boerse X ct | Bezug X ct"
- Zeile 2: "Spread +/-X ct | PV +/-X ct | Akku +/-X ct | Gemischt +/-X ct | Beste Quelle: [Name]"
- **Dynamisches Hover-Update**: Standard zeigt aktuellen Zeitslot. Beim Hover ueber einen anderen Balken wechselt die Zusammenfassung temporaer zu diesem Slot. Bei mouseleave zurueck zum aktuellen.
- **Beste Quelle farbig**: PV=gruen, Akku=blau, Gemischt=orange, Netz=grau

### Claude's Discretion
- Exact CSS-Klassen und Farbvariablen fuer Selektion-Highlight
- SVG-Rendering-Details (Padding, Scale-Funktion, Grid-Lines)
- Tooltip-Styling (border-radius, background, font-size)
- Debouncing/Throttling bei schnellem Mouse-Move

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Referenz-Implementierung (altes System)
- `dvhub/public/app.js` lines 254-395 — chartSelectionState, normalizeChartSelectionIndices, buildScheduleWindowsFromSelection, setChartSelection, clearChartSelection, buildChartSelectionRange (selection logic)
- `dvhub/public/app.js` lines 441-460 — showChartTooltip, hideChartTooltip (tooltip with margin data)
- `dvhub/public/app.js` lines 462-479 — appendScheduleRowsFromChartSelection, createScheduleRowsFromChartSelection (chart-to-schedule bridge)
- `dvhub/public/app.js` lines 481-694 — drawPriceChart (import overlay polyline, zero baseline, bar event handlers, comparison data integration)
- `dvhub/public/app.js` lines 413-438 — updateChartComparisonSummary (margin summary above chart)

### Backend Pricing API
- `dvhub/modules/gateway/index.js` function slotComparison() — per-slot margin computation (importPriceCtKwh, spreadToImportCtKwh, pvMarginCtKwh, batteryMarginCtKwh, mixedMarginCtKwh, bestSource)
- `dvhub/modules/gateway/index.js` function userEnergyPricingSummary() — current pricing summary with comparisons array

### Bestehende Chart-Komponenten (zu erweitern)
- `dvhub/public/components/dashboard/price-chart.js` — Current SVG bar chart (no interactivity yet)
- `dvhub/public/components/dashboard/price-chart-compute.js` — Pure computeBarLayout() function

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `price-chart-compute.js`: Pure `computeBarLayout()` — extend with comparison data, selection state
- `schedule-compute.js`: `collectScheduleRulesFromRowState()` — reuse for chart-created rules
- `use-signal-store.js`: `telemetry`, `prices` signals — already available for pricing data
- `use-api.js`: `apiFetch()` — for POST /api/schedule/rules
- `dashboard-compute.js`: `formatTimestamp()` — reuse for tooltip time formatting
- `control-panel.js`: `controlMsg` signal pattern — reuse for "X Regeln erstellt" feedback
- Old `app.js` functions: `normalizeChartSelectionIndices`, `buildScheduleWindowsFromSelection`, `buildChartSelectionRange`, `inferChartSlotMs`, `getChartSlotEndTimestamp` — port to price-chart-compute.js as pure functions

### Established Patterns
- Pure compute modules (`*-compute.js`) for testable logic — all chart selection/window logic goes here
- Preact signals for reactive state (selection state as signals)
- CSS variables for theming (--chart-positive, --chart-negative, --chart-import, --chart-now)
- SVG-based charts without external libraries (hand-rolled SVG in htm/preact)

### Integration Points
- `price-chart.js` → extends with mouse event handlers, selection state, tooltip, overlay, comparison summary
- `schedule-panel.js` → refresh after chart creates rules (shared signal or callback)
- `dashboard-page.js` → passes comparison data from telemetry to PriceChart component
- Backend `/api/status` → already returns `userEnergyPricing` with `comparisons` array and `current` slot data

</code_context>

<specifics>
## Specific Ideas

- Import-Preis-Overlay: gestrichelt statt durchgezogen — bewusst anders als altes System fuer besseren visuellen Kontrast zu den Balken
- Chart-to-Schedule: sofortige Regel-Erstellung mit Defaults, kein Umweg ueber Panel-Editing
- Margin-Summary: live-Update beim Hover fuer direkten Vergleich beim Durchfahren der Slots

</specifics>

<deferred>
## Deferred Ideas

- Automation-Slot-Highlighting im Chart (Phase 14: Kleine Boersenautomatik — automationSlotTimestamps)
- Touch-Support fuer mobile Geraete (eigene Phase oder Backlog)

</deferred>

---

*Phase: 13-chart-interactivity*
*Context gathered: 2026-03-15*
