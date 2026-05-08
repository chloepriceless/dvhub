# DVhub Corporate Identity

Diese Richtlinie beschreibt das visuelle System für DVhub und ist auf die Website (`public/index.html`, `public/tools.html`) sowie die zentralen Styles (`public/styles.css`) gemappt.

## 1. Brand Positioning
- Claim: `The unofficial DV interface`
- Kampagnenline: `Hack the Grid`
- Markencharakter: technisch, energisch, handlungsorientiert, high-visibility UI
- Visuelle Leitidee: Energiefluss (Solar + Netz) als spannungsreiche, kontrastreiche Leitgrafik

## 2. Logo System
- Primarlogo: `public/assets/dvhub-wordmark.png` (Aurora-Wordmark "D⚡hub", 2048×1002, transparent)
- Logoaufbau: Wordmark mit Aurora-Verlauf (Cyan → Blau → Gelb → Grün) und gelbem Bolt zwischen `D` und `hub`
- Mindestfreiraum: links/rechts/oben/unten mindestens die Hoehe des Buchstabens `D` im Wort `Dhub`
- Nicht erlaubt:
  - Logo verzerren
  - Farben austauschen ausserhalb der definierten Palette
  - Bolt entfernen oder durch andere Symbole ersetzen

## 3. Color Palette
### Core
- `--ink-950`: `#050c14`
- `--ink-900`: `#0a1522`
- `--ink-850`: `#112335`
- `--ink-800`: `#17344f`

### Brand Akzente
- `--blue`: `#1f8dff`
- `--blue-deep`: `#0f4fb9`
- `--cyan`: `#34dbff`
- `--yellow`: `#ffd421`
- `--yellow-deep`: `#ffab08`
- `--green`: `#46d344`

### Statusfarben
- `--ok`: `#4ce36c`
- `--off`: `#ff6868`
- `--danger`: `#ff6c63`

## 4. Typografie
- Titel / Headlines: `Rajdhani` (Fette 500/600/700)
- Body / UI: `Inter` (Fette 400/500/600/700)
- Monospace (Logs/JSON): `JetBrains Mono` (Fallback: `Consolas`)

## 5. UI Prinzipien
- Panels: dunkle, glashafte Flächen mit gelbem/zyanem Kantenakzent
- Buttons: klare Funktionshierarchie
  - Primary = gelb/orange Verlauf
  - Secondary = dunkles Ghost-Pattern
  - Danger = roter Verlauf
- Datenvisualisierung:
  - Positive Preisbalken blau
  - Negative Preisbalken rot
  - Zeitmarker gelb

## 6. Motion
- Page-Load: gestaffelte `riseIn`-Animation auf Panel-Ebene
- Logo: subtile `logoPulse` Bewegung für lebendige Markenpraesenz
- Hover: leichte Lift-Interaktion auf Buttons

## 7. Voice & Copy
- Kurz, direkt, operator-orientiert
- Begriffe aus dem Kontext der Energie-/Grid-Steuerung
- Keine Marketing-Floskeln ohne technische Aussage

## 8. Implementierungsorte
- Design Tokens + Komponenten: `public/styles.css`
- Dashboard-Anwendung: `public/index.html`
- Tools-Anwendung: `public/tools.html`
- Chart-Branding: `public/app.js` (Farbvariablen für SVG)
