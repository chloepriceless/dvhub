# Settings + Setup Redesign — Design Spec

## Zusammenfassung

Settings und Setup werden grundlegend neu gestaltet. Beide Seiten nutzen das Energy-Flow-Design des Leitstands als Basis: dark theme, kompakte Key-Value-Zeilen, farbige Group-Cards in einem responsiven Multi-Column-Grid.

## Design-Entscheidungen

| Entscheidung | Ergebnis |
|---|---|
| Settings + Setup | Getrennte Seiten, aber gleiches Design-System |
| Navigation | Horizontale Tabs (Settings), keine Tabs (Setup) |
| Feld-Format | Key-Value Zeilen: Label links, Input rechts, kein Helper-Text |
| Gruppierung | Sub-Cards mit farbigem Kicker-Label + Left-Border-Akzent |
| Layout | Responsive Grid: 1 Spalte (< 700px), 2 Spalten (700-1099px), 3 Spalten (>= 1100px) |
| Speichern | Sticky Bottom Bar, erscheint bei ungespeicherten Aenderungen |
| Settings-Tabs | 4 Tabs: Anlage, Steuerung, Preise, System |
| Setup-Struktur | Single-Page Formular, kein Wizard, alle Felder auf einer Seite |

## Settings-Seite

### Seitenstruktur

```
Topbar (wie Leitstand)
Page-Header: "Einstellungen" + Config-Meta (rechts)
Tabs: Anlage | Steuerung | Preise | System
Status-Banner (z.B. "Victron GX verbunden")
Grid aus Group-Cards
Sticky Save-Bar (unten)
```

### Tabs und Feld-Zuordnung

**Tab "Anlage"** — Destination `connection` + Felder aus `quickstart` und `advanced` die zur Anlage gehoeren:
- Gruppe Verbindung (gruen): Hersteller, Host, Transport, Port, Unit ID, Timeout
- Gruppe DV-Proxy (gelb): Listen Host, Listen Port, Grid-Vorzeichen
- Gruppe Standort (blau): Latitude, Longitude
- Gruppe Telemetrie (cyan): VRM aktiv, Portal ID, VRM Token
- Gruppe Webserver (lila): HTTP Port, API Token

**Tab "Steuerung"** — Destination `control`:
- Gruppe Zeitplan (gruen): Zeitzone, Evaluate-Intervall, Min-SOC Default
- Gruppe Boersenautomatik (gelb): aktiviert, Schwellwerte, Zeiten
- Gruppe DV-Steuerung (blau): Readback, Lease-Verhalten

**Tab "Preise"** — Destination `services`:
- Gruppe EPEX (gruen): aktiviert, Bidding Zone
- Gruppe Tarifzeitraeume (gelb): Perioden-Editor
- Gruppe PV-Anlagen (blau): Marktwert-Modus, Anlagen-Editor

**Tab "System"** — Statischer HTML-Content (wie bisher):
- Systemstatus / Health
- Software Update
- Config Import/Export
- VRM-Historie / Backfill
- API Docs, Diagnose, Modbus-Scan, Schedule, DV-Log

### Group-Card Anatomie

```
┌─ 3px farbiger Left-Border ──────────────────┐
│ KICKER (uppercase, farbig, 10px)             │
│──────────────────────────────────────────────│
│ Label                          Input/Value   │
│ Label                          Input/Value   │
│ Label                          Input/Value   │
└──────────────────────────────────────────────┘
```

- Background: `rgba(16,26,42,0.9)` (leicht heller als Page-BG)
- Border: `1px solid rgba(123,151,178,0.18)`
- Left-Border: `3px solid <accent-color>`
- Shadow: `0 2px 8px rgba(0,0,0,0.25)`
- Border-Radius: 10px

### Key-Value Row

- Padding: 9px 14px
- Font-Size: 12px
- Label: `color: rgba(232,234,240,0.5)` (links)
- Input: Mono-Font, 11px, rechtsbuendig, `background: rgba(255,255,255,0.05)`
- Trennlinie: `1px solid rgba(255,255,255,0.04)` zwischen Rows
- Keine letzte Trennlinie

### Farb-Mapping fuer Gruppen

| Farbe | CSS-Variable | Hex | Verwendung |
|---|---|---|---|
| Gruen | `--green` | #4CE36C | Verbindung, Zeitplan, EPEX |
| Gelb | `--yellow` | #FFD32E | DV-Proxy, Boersenautomatik, Tarife |
| Blau | `--blue` | #00A8FF | Standort, DV-Steuerung, PV-Anlagen |
| Cyan | `--cyan` | #22D3EE | Telemetrie |
| Lila | `--purple` | #A78BFA | Webserver |
| Orange | `--orange` | #FF9F43 | MQTT |

### Sticky Save-Bar

- Position: fixed bottom
- Background: `rgba(11,15,26,0.95)` + `backdrop-filter: blur(12px)`
- Border-Top: `1px solid var(--border)`
- Inhalt: Links "X Felder geaendert", rechts "Verwerfen" (ghost) + "Speichern" (primary)
- Erscheint nur wenn `draftConfig !== savedConfig`

### Responsive Grid

```css
.config-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 12px;
}
@media (min-width: 700px)  { .config-grid { grid-template-columns: 1fr 1fr; } }
@media (min-width: 1100px) { .config-grid { grid-template-columns: 1fr 1fr 1fr; } }
```

## Setup-Seite

### Seitenstruktur

```
Topbar (wie Leitstand)
Zentrierter Container (max-width: 860px)
Header: "DVhub einrichten" + Untertitel
Warn-Banner (wenn keine Config)
Grid aus Group-Cards (2 Spalten ab 700px)
Config-Import Link
Sticky Save-Bar ("Konfiguration speichern")
```

### Setup-Felder (aus SETUP_WIZARD_FIELD_META)

- Gruppe Verbindung (gruen): Hersteller*, Host*
- Gruppe DV-Proxy (gelb): Listen Host, Listen Port, Grid-Vorzeichen
- Gruppe Dienste (blau): Zeitzone, EPEX aktiv, Bidding Zone
- Gruppe Webserver (cyan): HTTP Port, API Token

Pflichtfelder mit gruenem `*` markiert.

### Kein Wizard

- Kein Step-Navigation, keine Pills, kein Progress-Bar
- Kein Review-Step — der Nutzer sieht alle Felder direkt
- Kein Callout/Highlight — nur die Felder
- Discovery-Buttons (System erkennen) bleiben als Action-Buttons in der Verbindung-Gruppe

### Save-Verhalten

- Sticky Bottom Bar zentriert
- Links: "X Pflichtfelder" Zaehler
- Rechts: Grosser "Konfiguration speichern" Button
- Nach erfolgreichem Speichern: Success-Banner oben, Config-Import verschwindet

## Was entfaellt

### Settings

- `renderSidebarNavigation()` — komplett weg (Tabs uebernehmen)
- `renderSectionWorkspace()` mit `panel`, `settings-subsection`, `settings-group-list`, `<details>/<summary>` — ersetzt durch Grid aus Group-Cards mit flachen Key-Value Rows
- `buildDisclosureSummaryMarkup()` — nicht mehr noetig (keine aufklappbaren Gruppen)
- Helper-Texte (`field-help`) — entfallen komplett
- `settings-panel-meta`, `settings-section-meta`, `tools-note` — entfallen
- Tab "Schnellstart" — Felder verteilt auf Anlage/Steuerung
- Tab "Erweitert" — Felder verteilt auf Anlage/Steuerung

### Setup

- `renderSetupSteps()` / Step-Navigation — komplett weg
- `renderSetupWorkspace()` mit Progress-Bar, Callout, Step-Header — ersetzt durch flache Card-Liste
- `renderSetupNav()` (Weiter/Zurueck) — nicht mehr noetig
- `renderSetupOutcome()` — vereinfacht zu Banner
- `renderSetupErrors()` — vereinfacht zu Inline-Validierung
- `describeSetupStep()`, `buildSetupReviewSnapshot()` — nicht mehr noetig
- Alle Wizard-Step-Texte (Beschreibungen, Highlights, Notes) — entfallen

### CSS

- Alle `.wizard-steps`, `.setup-step-*`, `.setup-pill-*` Regeln
- Alle `.setup-progress-*` Regeln
- Alle `.setup-callout-*` Regeln
- Alle `.setup-review-*` Regeln
- Alle `.setup-save-*` Regeln
- `.settings-subsection*`, `.settings-group*`, `.settings-panel*`
- `.settings-workspace-summary`, `.summary-card` (in Settings-Kontext)

## Neue CSS-Komponenten

### `.config-grid`
Responsive Grid-Container fuer Group-Cards.

### `.config-group`
Group-Card mit Left-Border-Akzent. Attribut `data-accent="green|yellow|blue|cyan|purple|orange"`.

### `.config-group-kicker`
Farbiges Uppercase-Label oben in der Group-Card.

### `.config-row`
Key-Value Zeile innerhalb einer Group-Card.

### `.config-save-bar`
Sticky Bottom-Bar fuer Speichern/Verwerfen.

## Dateien

| Datei | Aenderung |
|---|---|
| `public/settings.js` | Render-Funktionen komplett neu: Grid + Group-Cards + KV-Rows |
| `public/setup.js` | Render-Funktionen komplett neu: Single-Page + Group-Cards |
| `public/settings.html` | Tabs auf 4 reduzieren, settingsNavTree entfernen, Save-Bar hinzufuegen |
| `public/setup.html` | Wizard-Shell entfernen, einfacher Container + Save-Bar |
| `public/styles.css` | Alte Klassen entfernen, neue config-* Klassen hinzufuegen |

## Verhalten und Edge Cases

### Tab-Verhalten (Settings)

- Default-Tab: erster Tab ("Anlage"), oder aus URL-Hash (`#steuerung`)
- Tab-Switch: DOM show/hide, kein Re-Render. Alle Tabs werden beim Laden einmal gerendert.
- Dirty-State bleibt ueber Tab-Wechsel erhalten (globaler Draft vs. gespeicherte Config)
- URL-Hash wird bei Tab-Wechsel aktualisiert (`location.hash = tabId`)

### Dirty-State und Save-Bar

- Vergleich: `JSON.stringify(draftConfig) !== JSON.stringify(savedConfig)` auf Modulebene
- Draft-State: Modulvariable `currentDraftConfig` (wie bisher in settings.js)
- Save-Bar erscheint/verschwindet per CSS-Klasse `.has-changes` auf dem Body
- "Verwerfen" setzt `draftConfig = clone(savedConfig)` und re-rendert. Keine Bestaetigungsabfrage.
- Bei Navigation weg (Link-Klick) geht Draft verloren — kein beforeunload-Dialog

### Validierung

- **Settings**: Keine Client-Validierung. Server validiert beim Speichern. Fehler als Banner oben.
- **Setup**: Pflichtfeld-Validierung beim Klick auf "Speichern". Leere Pflichtfelder bekommen `border-color: var(--red)`. Fehler-Banner oben: "X Pflichtfelder nicht ausgefuellt".
- Setup Save-Bar Zaehler: Anzahl der *noch leeren* Pflichtfelder. Zeigt "Bereit" wenn alle gefuellt.

### Status-Banner (Settings)

- Nur auf Tab "Anlage" sichtbar
- 3 Zustaende: verbunden (gruen), Fehler (rot), nicht konfiguriert (gelb)
- Wird aus `/api/status` geladen, nicht aus Config

### Config-Import (Setup)

- Gleiche Funktion wie bisher: Klick oeffnet File-Input, akzeptiert `.json`, sendet an `/api/config/import`
- Nach erfolgreichem Speichern der Setup-Config verschwindet der Import-Link (Config existiert jetzt)

### Input-Typen

- Kommen aus `definition.fields` (Typ-Info vom Server): `text`, `number`, `boolean` (Checkbox), `select`, `dynamicSelect`, `time`
- Perioden-Editor und PV-Anlagen-Editor: Werden 1:1 aus der aktuellen Implementierung uebernommen. Sind eigenstaendige Render-Funktionen (`renderPricingPeriodsEditor()`, `renderPvPlantsEditor()`) die eine eigene Group-Card bekommen.

### Kicker-Farben und Accent

- Mechanismus: `data-accent` Attribut auf `.config-group` + CSS Attribute-Selectors
- Kicker-Text-Farbe: inline `style="color:var(--<color>)"` auf dem Kicker-Element (wie im Leitstand)
- Left-Border: `[data-accent="green"] { border-left-color: var(--green); }` etc.

### Responsive Breakpoints

- Settings: 1 Spalte (< 700px), 2 Spalten (700-1099px), 3 Spalten (>= 1100px)
- Setup: 1 Spalte (< 700px), 2 Spalten (>= 700px) — gleicher Breakpoint wie Settings
- Mockups sind Guidance, keine Pixel-perfekte Vorlage

### MQTT-Gruppe

- MQTT-Felder existieren nur wenn `definition.fields` MQTT-Felder enthaelt (herstellerabhaengig)
- Wenn keine MQTT-Felder: Gruppe wird nicht gerendert

## Referenz-Mockups

Interaktive Mockups in `.superpowers/brainstorm/`:
- `layout-density-v5.html` — Settings mit 3-Column Grid + Accent Borders (abgenommen)
- `setup-design.html` — Setup Single-Page (abgenommen)
