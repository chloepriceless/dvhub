# Settings + Setup JS Rebuild Plan

> **Fuer die naechste Session:** Die Render-Funktionen in `settings.js` und `setup.js` muessen umgeschrieben werden, damit sie HTML im neuen Energy Flow Design erzeugen statt altes Sidebar-Layout.

## Status Quo

- **Dashboard** (index.html): Fertig, Energy Flow Design funktioniert
- **Historie** (history.html): Design OK, volle Breite
- **Explorer** (explorer.html): Design OK
- **Settings** (settings.html): HTML/CSS neu, aber `settings.js` erzeugt dynamisch altes Design-HTML
- **Setup** (setup.html): HTML/CSS neu, aber `setup.js` erzeugt dynamisch altes Design-HTML

## Problem

`settings.js` und `setup.js` erzeugen HTML mit alten CSS-Klassen:
- `panel`, `app-nav-subitem`, `settings-field`, `settings-field-title`, `summary-card`, `settings-panel`, `wizard-steps`, etc.
- CSS-Overrides funktionieren nur teilweise (Settings-Tab-Navigation bricht)
- Das alte Layout blutet visuell durch

## Was umgeschrieben werden muss

### settings.js (~1800 Zeilen)

**Render-Funktionen die neues HTML erzeugen muessen:**

1. `renderSidebarNavigation()` (Zeile ~970) — Erzeugt `app-nav-subitem` Buttons
   - **NEU:** Nicht mehr noetig wenn Tabs das uebernehmen. Stattdessen: Tab-Click ruft direkt `activateSettingsDestination()` auf
   - **Loesung:** `activateSettingsDestination` global verfuegbar machen (aus IIFE exportieren via `window.DVhubSettings = { activateSettingsDestination }`)

2. `renderSectionWorkspace()` (Zeile ~991) — Erzeugt `panel`, `panel-head`, `settings-panel`, `settings-subsection`, `settings-group`, `settings-fields`
   - **NEU:** Statt `panel` → `sub-card`, statt `panel-head` → neuer `panel-head`, statt `settings-group` → `details` mit neuem Styling
   - Klassen-Mapping:
     - `panel reveal settings-panel` → `sub-card`
     - `panel-head settings-panel-head` → `panel-head` (bleibt)
     - `settings-subsection` → eigene Section mit `card-kicker` + `section-title`
     - `settings-fields` → flexbox column mit neuen Input-Styles
     - `settings-field` → neue Field-Komponente mit Label oben, Input darunter
     - `settings-group` (details/summary) → collapsible mit neuem Styling

3. `renderField()` (verschiedene Stellen) — Erzeugt `settings-field`, `settings-field-title`, `field-help`
   - **NEU:** Gleiche Struktur, neue Klassen

4. `buildDisclosureSummaryMarkup()` — Erzeugt Summary-Content fuer Details-Elements
   - **NEU:** Einfacheres Markup

**Architektur-Aenderung fuer Tab-Integration:**
- `activateSettingsDestination()` muss von aussen aufrufbar sein
- Am Ende von settings.js: `window.DVhubSettings = { activate: activateSettingsDestination }`
- In settings.html Tab-Script: `window.DVhubSettings.activate('connection')`

### setup.js (~1500 Zeilen)

**Render-Funktionen die neues HTML erzeugen muessen:**

1. `renderStepNavigation()` (Zeile ~742) — Erzeugt `wizard-steps`, `setup-step-button`, `setup-step-index`
   - **NEU:** Horizontale Tabs/Pills statt vertikale Sidebar-Buttons
   - Einfacher: Nummer-Kreis + kurzer Titel, kein Meta-Text

2. `renderActiveStep()` (Zeile ~930) — Erzeugt Step-Content mit `setup-progress`, `setup-callout`, Step-Header
   - **NEU:** Progress-Bar im neuen Stil, Callout kompakter

3. `renderSetupField()` (Zeile ~798) — Erzeugt `settings-field setup-field`
   - **NEU:** Gleiches Pattern wie Settings, neue Klassen

4. `renderReviewStep()` (Zeile ~1006) — Erzeugt Review-Cards
   - **NEU:** Kompakte Review-Cards im Energy Flow Stil

5. `renderSaveOutcome()` (Zeile ~1111) — Erzeugt Save-Ergebnis
   - **NEU:** Success/Error Card im neuen Design

**Setup Vereinfachung:**
- Die 4 Wizard-Schritte kommen aus `config-model.js` SETUP_WIZARD_STEPS — das aendern wir NICHT
- Aber die Darstellung wird kompakter: weniger Text, groessere Inputs, klarere Struktur
- Optional: Schritte 1+2 (Webserver + Anlage) als einen visuellen Block zeigen

## Vorgehen

1. **settings.js**: `activateSettingsDestination` exportieren → Tab-Script vereinfachen
2. **settings.js**: Alle `className = 'panel...'` durch neue Klassen ersetzen (Find & Replace)
3. **settings.js**: `renderSidebarNavigation()` kann leer bleiben (Tabs uebernehmen)
4. **setup.js**: Alle Render-Funktionen: alte Klassen → neue Klassen
5. **setup.js**: Step-Navigation kompakter
6. **CSS**: Alte Legacy-Styles entfernen die nicht mehr gebraucht werden

## Dateien

| Datei | Aenderung |
|-------|-----------|
| `public/settings.js` | Render-Funktionen: neue CSS-Klassen, activateSettingsDestination exportieren |
| `public/setup.js` | Render-Funktionen: neue CSS-Klassen, kompaktere Steps |
| `public/settings.html` | Tab-Script vereinfachen (nutzt window.DVhubSettings.activate) |
| `public/setup.html` | Ggf. HTML-Anpassungen |
| `public/styles.css` | Legacy-CSS-Block aufraeumen, ggf. neue Komponenten-Styles |

## Referenz: Neue CSS-Klassen (aus styles.css)

```
.sub-card          — glassmorphic card (ersetzt .panel)
.card-kicker       — small uppercase label
.section-title     — heading (Space Grotesk)
.metric-row        — key-value row
.btn / .btn-primary / .btn-ghost / .btn-small — buttons
.settings-field    — form label+input (bereits definiert)
.panel-head        — flex header
.status-banner     — status message
.controls          — button row
.meta              — small text
```

## Branch

Alles auf `feat/energy-flow-dashboard`, 27 Commits seit `main`.
