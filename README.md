<p align="center">
  <img src="assets/dvhub-wordmark.png" alt="DVhub" width="640" />
</p>

```
██████╗ ██╗   ██╗██╗  ██╗██╗   ██╗██████╗
██╔══██╗██║   ██║██║  ██║██║   ██║██╔══██╗
██║  ██║██║   ██║███████║██║   ██║██████╔╝
██║  ██║╚██╗ ██╔╝██╔══██║██║   ██║██╔══██╗
██████╔╝ ╚████╔╝ ██║  ██║╚██████╔╝██████╔╝
╚═════╝   ╚═══╝  ╚═╝  ╚═╝ ╚═════╝ ╚═════╝
```

<p align="center">
  <strong>Hack the Grid</strong><br/>
  Direktvermarktungs-Schnittstelle &amp; Home Energy Management System für Victron ESS
</p>

> **DVhub** ist ein Energie-Management-System auf Basis der PLEXLOG-Modbus-Register,
> zugeschnitten auf Victron-ESS-Systeme. Es bildet die Direktvermarktungs-Schnittstelle
> in Software nach und erweitert sie um Prognose, Optimierung, Telemetrie-Historie
> und ein Familien-Dashboard — getestet mit LUOX Energy (ehem. Lumenaza) als Direktvermarkter.

| | |
|---|---|
| **Status** | `v1.0-dev` — Version 0.8.0 |
| **Getestet mit** | LUOX Energy, Victron Ekrano-GX / Cerbo-GX, Fronius AC-PV |
| **Lizenz** | Energy Community License (ECL-1.0) — siehe [Lizenz](#lizenz) |
| **Drittlizenzen** | [`THIRD-PARTY-LICENSES.md`](THIRD-PARTY-LICENSES.md) |

<p align="center">
  <img src="assets/screenshots/leitstand-2026-05-18.png" alt="DVhub Leitstand — Live-Dashboard" width="900" />
  <br/>
  <em>Leitstand — Live-Dashboard mit Energy-Flow-Visualisierung, Day-Ahead-Preisen und Steuerung</em>
</p>

---

## Kurzüberblick

DVhub ersetzt bzw. ergänzt einen physischen Plexlog als DV-Schnittstelle: Die
Modbus-Kommunikation des Direktvermarkters wird in Software nachgebildet, während
die Live-Daten direkt vom Victron-GX-System kommen. Darüber hinaus ist DVhub zu
einem vollwertigen Home Energy Management System (HEMS) ausgebaut.

- **DV-Schnittstelle und Web-Leitstand** in einer Anwendung
- **Dashboard** mit Energy-Flow-Visualisierung, Live-Werten, Day-Ahead-Preisen und Steuerung
- **Kleine Börsenautomatik** mit zweistufigem Forecast-aware-Modus (Stufe 2: vorausschauendes Akku-Leeren)
- **Prognose-Engine** — PV-Ertrag (pvlib), Lastvorhersage und Multi-Modell-Ensemble
- **Optimierung** — interner MILP-/Heuristik-Optimizer und Akkudoktor-EOS-Anbindung
- **ML & Edge-KI** — selbstlernende Prognose-Korrektur und optionales lokales LLM-Dashboard
- **Historie** mit PostgreSQL-Telemetrie, Finanz-Karten und 14 Visualisierungs-Karten
- **Familien-Dashboard** als haushaltstaugliche Übersicht inkl. Tesla-/Haus-Flow und Screensaver
- **Integrationsplattform** für Home Assistant, Loxone, EOS, EMHASS, MQTT und TeslaMate
- **DVhub Price API** (api.dvhub.de) als zentraler Preisfeed für alle EPEX-Preiszonen
- **VPN-Manager** für OpenVPN-/WireGuard-/IPsec-Tunnel zum Direktvermarkter

## Inhaltsverzeichnis

- [Schnellstart](#schnellstart)
- [Was DVhub kann](#was-dvhub-kann)
- [Oberflächen](#oberflächen)
- [Prognose, Optimierung &amp; KI](#prognose-optimierung--ki)
- [Integrationen](#integrationen)
- [DVhub Price API](#dvhub-price-api)
- [Direktvermarktung kompakt](#direktvermarktung-kompakt)
- [Installation im Detail](#installation-im-detail)
- [API und Konfiguration](#api-und-konfiguration)
- [Changelog](#changelog)
- [Lizenz](#lizenz)

---

## Schnellstart

### Installer

**Stable (empfohlen):**

```bash
curl -fsSL https://raw.githubusercontent.com/chloepriceless/dvhub/main/install.sh | sudo bash
```

**Dev (Bleeding Edge — aktuelle Commits von main):**

```bash
curl -fsSL https://raw.githubusercontent.com/chloepriceless/dvhub/main/install.sh | sudo bash -s -- --channel dev
```

Der Installer:

- installiert Node.js 22, PostgreSQL und die VPN-Pakete (OpenVPN, WireGuard, strongSwan)
- legt PostgreSQL-User und Datenbank `dvhub` an (Peer-Auth via Unix-Socket)
- klont das Repo nach `/opt/dvhub` und betreibt die App unter `/opt/dvhub/dvhub`
- richtet einen systemd-Service ein und nutzt eine externe Config unter `/etc/dvhub/config.json`
- installiert je nach verfügbarem RAM zusätzliche Prognose-/KI-Komponenten (siehe **Leistungsstufen**)
- aktiviert Health-Checks und optionalen Restart aus der GUI
- **Stable-Channel** (Standard): checkt den neuesten Release-Tag aus
- **Dev-Channel** (`--channel dev`): checkt `origin/main` HEAD aus
- Update-Channel ist nachträglich über die Einstellungen umschaltbar

Wenn die Config-Datei noch fehlt oder ungültig ist, öffnet DVhub beim ersten Aufruf automatisch den Setup-Assistenten.

### Leistungsstufen (RAM-Tiers)

DVhub skaliert mit der verfügbaren Hardware. Der Installer erkennt den RAM und
installiert nur die Komponenten, die das System tragen kann:

| Stufe | RAM | Zusätzliche Funktionen |
|-------|-----|------------------------|
| **Tier 1** | < 2 GB | Kern-DV, Steuerung, Telemetrie, Börsenautomatik, Prognose-Grunddaten |
| **Tier 2** | ≥ 2 GB | + ML-Pakete (scikit-learn, LightGBM, statsforecast) für selbstlernende Prognose-Korrektur |
| **Tier 3** | ≥ 3 GB | + Akkudoktor-EOS als externer Optimizer-Dienst |
| **Tier 3+** | ≥ 8 GB | + Ollama mit TinyLlama für das lokale LLM-Dashboard |

### Erster Aufruf

Standardmäßig läuft der Webserver auf **Port 80** (HTTP) und **Port 443** (HTTPS,
sobald ein TLS-Zertifikat vorhanden ist). Der HTTP-Port ist über `httpPort` in der
Config frei wählbar.

- Leitstand: `http://<host>/`
- Familie: `http://<host>/family`
- Integrationen: `http://<host>/integrations`
- Historie: `http://<host>/history.html`
- Explorer: `http://<host>/explorer.html`
- Einstellungen: `http://<host>/settings.html`
- Setup-Assistent: `http://<host>/setup.html` (wird bei fehlender Config automatisch unter `/` angezeigt)

---

## Was DVhub kann

### Kernfunktionen (Direktvermarktung &amp; Steuerung)

- **DV-Modbus-Server** auf Port `1502` (Default `modbusListenPort`) mit FC3/FC4 Read und FC6/FC16 Write
- **DV-Signalerkennung** inklusive Lease-Logik und sicherer Rückkehr in Freigabe
- **Victron-Steuerung** für Grid Setpoint, Charge Current und Min SOC
- **Negativpreis-Schutz** mit automatischer Reaktion auf EPEX-Preise
- **Day-Ahead-Preis-Engine** mit Heute-/Morgen-Daten, Hover-Details und Chart-Auswahl
- **Zentraler Preisfeed** über api.dvhub.de mit EPEX Day-Ahead Bidding Zones
- **Schedule-System** mit Defaults, manuellen Writes und Chart-zu-Schedule-Auswahl
- **Kleine Börsenautomatik** für automatische Entladung in Hochpreisphasen mit
  energiebasierter Slot-Allokation und dynamischem SOC-Floor (Sonnenaufgang-basiert)
- **Forecast-aware Börsenautomatik** (zweistufig) — Stufe 1 leitet Reserve und
  Hoarding-Gate aus dem PV-/Last-Forecast der nächsten 24 h ab; Stufe 2
  („Forecast Aware++“, vorausschauendes Akku-Leeren) verkauft aktiv, wenn der
  Börsenpreis unter die PV-Erzeugungskosten fällt
- **Kosten- und Preislogik** für Netz, PV und Akku über `userEnergyPricing`,
  inkl. datumsbasierter Bezugspreise und Paragraph 14a Modul 3

### Prognose, Optimierung &amp; KI

- **PV-Ertragsprognose** über pvlib mit standort- und anlagenspezifischen Parametern
- **Lastvorhersage** über statistische Modelle (statsforecast) und LightGBM
- **Multi-Modell-Ensemble** mit Nebel-Korrektur und gemessener Prognosegüte
- **ML-Korrektur** — selbstlernende Korrektur systematischer Prognosefehler mit
  atomarem Modell-Swap und Schema-Guard
- **Interner Optimizer** — MILP-Batterieoptimierung (HiGHS-Solver) und Heuristik
- **EOS-Anbindung** — Akkudoktor-EOS als externer Optimizer mit Confidence-Gate
- **Edge-LLM** (optional) — lokales TinyLlama via Ollama erzeugt natürlichsprachige
  Erläuterungen für Dashboard-Kacheln, mit Template-Fallback ohne LLM

### Daten, Historie &amp; Observability

- **PostgreSQL-Telemetrie** mit Persistenz, Rollups, historischem Nachimport und Retention
- **TimescaleDB** standardmäßig aktiv (Continuous Aggregates &amp; Retention statt App-Rollups)
- **History-Visualisierung** mit 14 Analyse-Karten und CSV-/Parquet-Export
- **Prometheus-Metriken** unter `/api/metrics` (prom-client)
- **VRM-History-Import** zum Nachfüllen von Telemetrie-Lücken

### Betriebsmodell

- **Modbus TCP oder MQTT** als Victron-Transport
- **Externe Konfiguration** statt fest eingebauter Runtime-Dateien
- **Hersteller-Adapter** entkoppeln gerätespezifische Register/Endpunkte vom Kern
- **systemd-ready** für dauerhaften Betrieb, Health-/Service-Status in den Einstellungen
- **Modulare Architektur** mit Factory-Modulen, Service-Layer und DI-Context-Pattern

---

## Oberflächen

Alle Oberflächen sind auf das **Aurora Design System** portiert — card-basiertes
Layout, einheitliche Tokens, responsiv bis 430px Viewport. Die Navigation der
Hauptseiten erfolgt über die Topbar: **Leitstand**, **Familie**, **Integrationen**,
**Historie**, **Explorer** und **Einstellungen**.

### Leitstand (Dashboard)

Startseite unter `/`:

- DV-Schaltstatus und Börsenpreis mit Negativpreis-Schutz
- Energy-Flow-Visualisierung, Netzleistung pro Phase, Victron-Werte (SOC, Akku, PV)
- Day-Ahead-Chart mit Hover, Highlight und Schedule-Auswahl
- Kleine Börsenautomatik mit Planungsanzeige und Chart-Highlighting
- Steuerung mit aktiven Werten, Defaults und manuellen Writes
- Prognose-Kacheln, optional mit LLM-erzeugter Erläuterung
- letzte Events aus dem Systemlog

### Historie

<p align="center">
  <img src="assets/screenshots/historie-2026-05-18.png" alt="DVhub Historie — Finanz- und Telemetrie-Auswertung" width="900" />
</p>

PostgreSQL-Telemetrie als eigene Analyseansicht (`/history.html`):

- Tag-, Wochen-, Monats- und Jahresansicht
- Finanz-Karten: Energiekosten, Einnahmen, Cashflow, vermiedene Kosten, Gesamtbilanz
- Preisvergleich zwischen historischem Marktpreis und eigenem Bezugspreis
- Solar-Zusammenfassung mit Jahres-Marktwert
- **14 Visualisierungs-Karten**: u. a. Heatmap, Sankey-Energiefluss, Autarkie-Kalender,
  Tagesprofil, Lastdauerlinie, Ladezyklen, Streudiagramm, Preis-Heatmap, Jahres-Ring
- gezielter Preis-Backfill für Buckets ohne historischen Marktpreis
- CSV- und Parquet-Export der Rohdaten

### Familien-Dashboard

<p align="center">
  <img src="assets/screenshots/familie-2026-05-18.png" alt="DVhub Familien-Dashboard" width="900" />
</p>

Eine bewusst vereinfachte Haushaltsansicht (`/family`):

- gut lesbare Übersicht von Verbrauch, PV, Akku und Autarkie
- Haus-zentrierter Energy-Flow mit konfigurierbaren MQTT-Kacheln
- Tesla-/EV-Integration: Lade-/Fahrzeugzustand und Lade-Historie-Chart aus TeslaMate
- Screensaver-Modus für dauerhaft laufende Displays
- Prognose-Anzeige mit Badge bei eingeschränkter Datenlage

### Integrationen

Eigene Seite (`/integrations`) für alle externen Anbindungen — Status, Health und
Konfiguration von Home Assistant, Loxone, EOS, EMHASS, MQTT und TeslaMate inkl.
MQTT-Inspector. Die Benachrichtigungs-Provider (Telegram, Pushover) werden über
die zugehörige Provider-Seite gepflegt.

### Explorer

Eigene Seite (`/explorer.html`) zum freien Erkunden der Telemetrie-Zeitreihen und
Rohdaten in der PostgreSQL-Datenbank.

### Einstellungen

Sechs Tabs decken die Konfiguration ab: **Anlage** (Victron-Verbindung),
**Steuerung**, **Preise**, **Status** (Health, Service, Config Import/Export,
Update-Channel, System-Updates/Reboot, Modbus Register Scan, VRM-Import),
**ML &amp; AI** und **VPN**. Die EPEX-Preiszone wird über einen dynamischen
Selektor gewählt, der verfügbare Zonen samt Abdeckung von der DVhub Price API lädt.

### Setup

Der First-Run-Assistent (`/setup.html`) führt Schritt für Schritt durch
Port/Token, Victron-Verbindung (Modbus oder MQTT mit automatischer
Systemerkennung), Meter-/DV-Basiswerte und EPEX-Grunddaten — alle Felder sind
mit sinnvollen Defaults vorbelegt.

### Wartung

Wartungsfunktionen sind in den **Einstellungen / Status** zusammengefasst:

- Health-/Service-Status, Config Import/Export
- DV-Schaltsignal-Log und Event-Log
- Modbus Register Scan
- VRM-History-Import, Update-Channel-Umschaltung, System-Updates/Reboot
- VPN-Manager (Tunnel-Status, Config-Upload, Restart, Verlauf) im VPN-Tab
- API-Dokumentation als Swagger UI unter `/api-docs.html`

> Hinweis: Die frühere eigenständige Tools-Seite (`tools.html`) existiert nur noch
> als Weiterleitung auf **Einstellungen / Status**.

---

## Prognose, Optimierung &amp; KI

DVhub trifft Lade-/Entladeentscheidungen nicht nur reaktiv, sondern vorausschauend.

1. **Prognose** — Für PV-Ertrag wird pvlib mit Standort, Modulausrichtung und
   Anlagenparametern gerechnet; die Hauslast wird über statistische Modelle und
   LightGBM vorhergesagt. Ein Ensemble kombiniert die Modelle, eine Nebel-Korrektur
   dämpft typische Schönwetter-Überschätzungen. Jede Prognose wird als Snapshot
   gespeichert und gegen die tatsächlichen Messwerte ausgewertet (Accuracy-Tracking).
   Optional lassen sich Cloud-PV-Provider (Solcast, pvnode.de) als zusätzliche
   Eingangsdaten einbinden.

2. **ML-Korrektur** — Aus dem gemessenen Prognosefehler lernt DVhub fortlaufend
   ein Korrekturmodell (LightGBM). Modelle werden im Hintergrund neu trainiert und
   atomar getauscht; ein Schema-Guard verhindert das Laden inkompatibler Modelle.

3. **Optimierung** — Ein interner Optimizer plant das Batterie-Lade-/Entladeprofil
   gegen die Day-Ahead-Preise: als MILP (HiGHS-Solver) oder als schnelle Heuristik.
   Alternativ kann **Akkudoktor-EOS** als externer Optimizer-Dienst eingebunden
   werden. Ein Confidence-Gate verwirft Optimierungsergebnisse, wenn die zugrunde
   liegende Prognose zu unsicher ist.

4. **Forecast-aware Börsenautomatik** — Die kleine Börsenautomatik nutzt den
   Forecast zweistufig: Stufe 1 dimensioniert Reserve und Hoarding-Gate aus dem
   erwarteten PV-Ertrag der nächsten 24 h. Stufe 2 („Forecast Aware++“,
   `predictive-pre-empty.js`) leert den Akku vorausschauend, wenn der Börsenpreis
   unter die PV-Erzeugungskosten fällt — mit Soft-/Hard-Limit-Taper auf die
   Entladeleistung und einer Live-Runtime-Clamp im Schreibpfad (`schedule-eval.js`),
   die die gemessene Akku-Entladung hart auf das Akku-Hard-Limit begrenzt.

5. **Edge-LLM (optional, Tier 3+)** — Ein lokal über Ollama betriebenes TinyLlama
   formuliert Dashboard-Kacheln in verständliche Sprache. Ohne LLM greift ein
   deterministischer Template-Fallback — die Funktion ist nie blockierend.

Die KI-Komponenten sind hardware-abhängig zuschaltbar (siehe [Leistungsstufen](#leistungsstufen-ram-tiers))
und laufen vollständig lokal.

---

## Integrationen

DVhub stellt Daten bereit oder nimmt Optimierungsergebnisse entgegen für:

- **Home Assistant** — JSON-Endpunkt und MQTT-Auto-Discovery
- **Loxone** — Textformat-Endpunkt
- **EOS (Akkudoktor)** — Messwerte/Preise raus, Optimierung rein
- **EMHASS** — Messwerte/Preisarrays raus, Optimierung rein
- **MQTT** — eingebauter Broker (aedes) und Publisher, plus MQTT-Inspector
- **TeslaMate** — Einbindung von Fahrzeug-/Ladedaten ins Familien-Dashboard

Zusätzlich kann DVhub historische Daten per **VRM** nachladen, um Lücken in der
Telemetrie zu füllen. Für Marktpreise nutzt DVhub den zentralen **DVhub Price Feed**
(api.dvhub.de) mit Fallback auf Energy Charts.

**Benachrichtigungen** über Telegram und Pushover informieren über Schaltvorgänge
und Systemereignisse.

---

## DVhub Price API

DVhub betreibt unter `api.dvhub.de` einen zentralen Preisfeed für EPEX Day-Ahead Preise:

- **Alle EPEX Day-Ahead Bidding Zones** (AT, BE, BG, CH, CZ, DE-LU, DK1, DK2, ES, FI, FR, NL, NO1-5, PL, SE1-4, ...)
- **Historische Daten** ab 2020 mit stündlicher Auflösung (vor 01.10.2024) und 15-Minuten-Auflösung (ab 01.10.2024)
- **Täglich aktualisiert** um 13:30 und 15:00 CET
- **Primärquelle:** Energy Charts (Fraunhofer ISE / SMARD.de)
- **Fallback:** ENTSO-E Transparency Platform

DVhub-Instanzen holen ihre Preise automatisch von dieser API. Kein Port muss freigegeben werden.

### Price API Endpunkte

| Methode | Pfad | Beschreibung |
|---------|------|--------------|
| `GET` | `/api/zones` | Alle verfügbaren Preiszonen mit Abdeckungsinfo |
| `GET` | `/api/prices?start=...&end=...&zone=DE-LU` | Preise für Zeitraum und Zone |
| `GET` | `/api/prices/latest?zone=DE-LU` | Letzte 48 Stunden |
| `GET` | `/api/prices/stats?zone=DE-LU` | Abdeckungsstatistiken |
| `GET` | `/api/prices/gaps?zone=DE-LU` | Fehlende Daten finden |
| `POST` | `/api/backfill` | Backfill für eine Zone anstoßen |

---

## Direktvermarktung kompakt

### Wozu eine DV-Schnittstelle?

Eine Direktvermarktungs-Schnittstelle verbindet den Direktvermarkter mit deiner Anlage, damit:

- Live-Werte abgefragt werden können
- Steuersignale bei negativen Preisen oder Vermarktungsvorgaben ankommen

Der Direktvermarkter kann so Einspeisung bewerten, regeln und wirtschaftlich steuern.

### Warum DVhub statt Plexlog?

Der physische Plexlog kann Live-Daten liefern, aber die Steuerung moderner
Victron-Setups ist in der Praxis oft unflexibel oder nicht vollständig nutzbar.
DVhub liest die Daten direkt vom GX-Gerät und beantwortet die PLEXLOG-kompatiblen
Modbus-Anfragen in Software.

### Wer braucht das?

Nach dem Solarspitzengesetz benötigen PV-Anlagen ab **25 kWp** typischerweise eine
DV-Schnittstelle für die Direktvermarktung. Kleinere Anlagen können freiwillig teilnehmen.

### Warum ist das auch unter 30 kWp interessant?

Mit der diskutierten **Pauschaloption / MiSpeL** wird Direktvermarktung auch für
kleinere Anlagen mit Speicher attraktiver, weil Speicher flexibler aus PV und Netz
geladen werden dürfen und die Vermarktung wirtschaftlich interessanter wird.

### MiSpeL-Status

Stand **März 2026**:

- BNetzA-Festlegung soll bis **30. Juni 2026** finalisiert werden
- die **EU-beihilferechtliche Genehmigung** steht noch aus
- die Konsultationsphase wurde im **Oktober 2025** abgeschlossen

### Offizielle Links

- [BNetzA MiSpeL Festlegungsverfahren](https://www.bundesnetzagentur.de/DE/Fachthemen/ElektrizitaetundGas/ErneuerbareEnergien/EEG_Aufsicht/MiSpeL/start.html)
- [BNetzA MiSpeL Artikel/Überblick](https://www.bundesnetzagentur.de/DE/Fachthemen/ElektrizitaetundGas/ErneuerbareEnergien/EEG_Aufsicht/MiSpeL/artikel.html)
- [BNetzA Pressemitteilung (19.09.2025)](https://www.bundesnetzagentur.de/SharedDocs/Pressemitteilungen/DE/2025/20250919_MiSpeL.html)
- [Anlage 2: Pauschaloption Eckpunkte (PDF)](https://www.bundesnetzagentur.de/DE/Fachthemen/ElektrizitaetundGas/ErneuerbareEnergien/EEG_Aufsicht/MiSpeL/DL/Anlage2.pdf)
- [BMWK FAQ Solarspitzengesetz](https://www.bundeswirtschaftsministerium.de/Redaktion/DE/Dossier/ErneuerbareEnergien/faq-zur-energierechtsnovelle-zur-vermeidung-von-stromspitzen-und-zum-biomassepaket.html)

### LUOX-Anbindung

Für LUOX brauchst du in der Praxis:

1. Meldung, dass eine PLEXLOG-kompatible DV-Schnittstelle vorhanden ist
2. VPN-Tunnel zu LUOX (OpenVPN, WireGuard oder IPsec — verwaltbar im VPN-Manager)
3. Portforwarding von Port `502` aus dem Tunnel auf Port `1502` von DVhub

**Unifi-Hinweis:** Falls die GUI das Tunnel-Portforwarding nicht sauber abbildet,
hilft das Skript [`20-dv-modbus.sh`](20-dv-modbus.sh) für die iptables-Regeln.

---

## Installation im Detail

### Voraussetzungen

- Debian/Ubuntu mit `apt-get`
- Node.js 22+ (der Installer akzeptiert vorhandene Node-Versionen ab 18, `package.json` fordert `>=18`)
- PostgreSQL 14+ (für Telemetrie)
- Victron GX-Gerät im lokalen Netz
- optional: Python 3.11+ (Prognose/ML — vom Installer eingerichtet)

### Manuelle Installation

```bash
sudo apt update
sudo apt install -y curl ca-certificates git sudo postgresql openvpn wireguard-tools strongswan
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo mkdir -p /opt/dvhub /etc/dvhub /var/lib/dvhub
sudo useradd --system --create-home --shell /usr/sbin/nologin dvhub
sudo git clone https://github.com/chloepriceless/dvhub.git /opt/dvhub
```

Danach:

```bash
sudo chown -R dvhub:dvhub /opt/dvhub /etc/dvhub /var/lib/dvhub
cd /opt/dvhub/dvhub
npm install --omit=dev
sudo cp config.example.json /etc/dvhub/config.json
sudo mkdir -p /etc/dvhub/hersteller
sudo cp hersteller/victron.json /etc/dvhub/hersteller/victron.json
sudo nano /etc/dvhub/config.json
```

Technische Victron-Werte wie Register, Port, Unit-ID oder Timeout werden nicht in
`/etc/dvhub/config.json` gepflegt, sondern im Herstellerprofil unter
`/etc/dvhub/hersteller/victron.json`.

Prognose-/ML-Funktionen benötigen zusätzlich eine Python-Umgebung
(`dvhub/python/requirements.txt`); der Installer richtet diese je nach
[Leistungsstufe](#leistungsstufen-ram-tiers) automatisch ein.

### systemd Service

Datei: `/etc/systemd/system/dvhub.service`

```ini
[Unit]
Description=DVhub DV Control
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=dvhub
Group=dvhub
WorkingDirectory=/opt/dvhub/dvhub
ExecStart=/usr/bin/node /opt/dvhub/dvhub/server.js
Environment=NODE_ENV=production
Environment=DV_APP_CONFIG=/etc/dvhub/config.json
Environment=DV_ENABLE_SERVICE_ACTIONS=1
Environment=DV_SERVICE_NAME=dvhub.service
Environment=DV_SERVICE_USE_SUDO=1
Environment=DV_DATA_DIR=/var/lib/dvhub
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

Service aktivieren:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now dvhub
```

### Restart aus der GUI erlauben

```bash
SYSTEMCTL_PATH="$(command -v systemctl)"
echo "dvhub ALL=(root) NOPASSWD: ${SYSTEMCTL_PATH} restart dvhub.service" | sudo tee /etc/sudoers.d/dvhub-service-actions >/dev/null
echo "dvhub ALL=(root) NOPASSWD: ${SYSTEMCTL_PATH} is-active dvhub.service" | sudo tee -a /etc/sudoers.d/dvhub-service-actions >/dev/null
echo "dvhub ALL=(root) NOPASSWD: ${SYSTEMCTL_PATH} show dvhub.service *" | sudo tee -a /etc/sudoers.d/dvhub-service-actions >/dev/null
sudo chmod 440 /etc/sudoers.d/dvhub-service-actions
```

### Manueller Start

```bash
cd /opt/dvhub/dvhub
DV_APP_CONFIG=/etc/dvhub/config.json DV_DATA_DIR=/var/lib/dvhub npm start
```

---

## API und Konfiguration

DVhub stellt eine HTTP-API unter `/api/*` bereit (plus den DV-Endpunkt
`/dv/control-value`). Die folgenden Tabellen listen die wichtigsten Routen.

### Wichtige API-Endpunkte

**Status &amp; DV:**

| Methode | Pfad | Beschreibung |
|---------|------|--------------|
| `GET` | `/dv/control-value` | DV Status: `0` = Abregelung, `1` = Einspeisung erlaubt |
| `GET` | `/api/status` | Vollständiger Systemstatus |
| `GET` | `/api/costs` | Tages-Kostenübersicht |
| `GET` | `/api/log` | Event-Log (`?limit=`) |
| `POST` | `/api/log` | Log-Eintrag schreiben |
| `GET` | `/api/log/dv-signals` | DV-Schaltsignal-Log |
| `GET` | `/api/metrics` | Prometheus-Metriken |
| `GET` | `/api/keepalive/modbus`, `/api/keepalive/pulse` | Keepalive-Status |
| `GET` | `/health` | Liveness-Probe |

**Konfiguration &amp; Admin:**

| Methode | Pfad | Beschreibung |
|---------|------|--------------|
| `GET` `POST` | `/api/config` | Konfiguration lesen/aktualisieren |
| `POST` | `/api/config/import` | Config aus JSON importieren |
| `GET` | `/api/config/export` | Config als JSON exportieren |
| `GET` | `/api/admin/health` | Health-Check Status |
| `POST` | `/api/admin/service/restart` | systemd-Service neu starten |
| `GET` | `/api/admin/system/info` | Systeminformationen |
| `POST` | `/api/admin/system/reboot` | System neu starten |
| `POST` | `/api/admin/update/channel` | Update-Channel setzen |
| `GET` | `/api/admin/update/check` | App-Update prüfen |
| `POST` | `/api/admin/update/apply` | App-Update anwenden |
| `GET` | `/api/admin/system/updates/check` | System-Updates prüfen |
| `POST` | `/api/admin/system/updates/apply` | System-Updates anwenden |
| `POST` | `/api/admin/token/rotate`, `/api/admin/token/revoke` | API-Token rotieren/widerrufen |

**EPEX / Preise:**

| Methode | Pfad | Beschreibung |
|---------|------|--------------|
| `POST` | `/api/epex/refresh` | EPEX-Preise manuell aktualisieren |
| `GET` | `/api/epex/zones` | Verfügbare Preiszonen von api.dvhub.de |
| `GET` | `/api/epex/gaps?zone=DE-LU` | Fehlende Preisdaten für Zone |
| `POST` | `/api/epex/backfill` | Backfill fehlender Preise anstoßen |

**History / Telemetrie / Visualisierung:**

| Methode | Pfad | Beschreibung |
|---------|------|--------------|
| `GET` | `/api/history/summary?view=day&date=YYYY-MM-DD` | Historische Zusammenfassung |
| `GET` | `/api/history/export?view=...` | Aggregierter History-Export |
| `GET` | `/api/history/raw` | Telemetrie-Rohdaten |
| `POST` | `/api/history/import` | Historische Telemetrie importieren |
| `GET` | `/api/history/import/status` | Import-Status |
| `POST` | `/api/history/backfill/vrm` | VRM Full/Gap-Backfill |
| `POST` | `/api/history/backfill/prices` | Preis-Backfill via Energy Charts |
| `GET` | `/api/history/viz/{heatmap,sankey,ring,...}` | Visualisierungs-Karten (14 Slugs) |
| `GET` | `/api/history/raw/export.csv`, `/api/history/raw/export.parquet` | Rohdaten-Export |
| `GET` | `/api/telemetry/series?keys=...&start=...` | Telemetrie-Zeitreihen |
| `GET` | `/api/admin/backfill/status`, `POST /api/admin/backfill` | Marktwert-Backfill |

**Prognose / Optimierung / KI:**

| Methode | Pfad | Beschreibung |
|---------|------|--------------|
| `GET` | `/api/forecast` | Aktuelle PV-/Last-Prognose |
| `POST` | `/api/forecast/refresh` | Prognose neu rechnen |
| `GET` | `/api/forecast/pvnode/quota` | pvnode.de Kontingent |
| `GET` | `/api/ml/status` | ML-Modell-Status |
| `GET` | `/api/ml/accuracy` | Prognosegüte / Accuracy-Tracking |
| `POST` | `/api/ml/retrain` | ML-Retraining anstoßen |
| `GET` | `/api/optimizer/status`, `/api/optimizer/runs/latest` | Optimizer-Status / letzter Lauf |
| `GET` | `/api/llm/models` | Verfügbare LLM-Modelle |
| `GET` | `/api/messages`, `/api/messages/history` | LLM-/Template-Kachelnachrichten |
| `POST` | `/api/messages/generate` | Nachrichten neu erzeugen |

**Schedule / Steuerung:**

| Methode | Pfad | Beschreibung |
|---------|------|--------------|
| `GET` | `/api/schedule` | Aktuelle Schedule-Regeln und Config |
| `POST` | `/api/schedule/rules` | Schedule-Regeln aktualisieren |
| `POST` | `/api/schedule/config` | Default-Werte aktualisieren |
| `GET` `POST` | `/api/schedule/automation/config` | Kleine Börsenautomatik |
| `POST` | `/api/schedule/automation/replan` | Neuplanung der Börsenautomatik anstoßen |
| `POST` | `/api/control/write` | Manueller Write (gridSetpoint, chargeCurrent, minSoc) |

**Integrationen / MQTT / VPN:**

| Methode | Pfad | Beschreibung |
|---------|------|--------------|
| `GET` | `/api/integrations/status`, `/api/integrations/health` | Integrations-Übersicht |
| `GET` | `/api/integrations/mqtt/topics` | MQTT-Inspector-Topics |
| `GET` `POST` | `/api/integrations/notification-providers` | Telegram-/Pushover-Provider |
| `GET` | `/api/integration/home-assistant` | Home Assistant JSON |
| `GET` | `/api/integration/loxone` | Loxone Textformat |
| `GET` `POST` | `/api/integration/eos`, `/api/integration/eos/apply` | EOS Messwerte / Optimierung anwenden |
| `GET` `POST` | `/api/integration/emhass`, `/api/integration/emhass/apply` | EMHASS Messwerte / Optimierung anwenden |
| `GET` | `/api/vpn/status`, `/api/vpn/config`, `/api/vpn/history` | VPN-Manager |
| `POST` | `/api/vpn/config/upload`, `/api/vpn/restart` | VPN-Config hochladen / Tunnel neu starten |
| `POST` | `/api/vpn/start`, `/api/vpn/stop` | VPN-Tunnel starten/stoppen |

**Familie / Discovery / Modbus:**

| Methode | Pfad | Beschreibung |
|---------|------|--------------|
| `GET` | `/api/family/status` | Familien-Dashboard-Status |
| `GET` `POST` | `/api/family/mqtt-tiles` | MQTT-Kachel-Konfiguration |
| `GET` | `/api/family/tile-history?id=...` | Verlauf einer MQTT-Kachel |
| `GET` | `/api/family/tesla-history` | Tesla-Lade-Historie |
| `GET` `POST` | `/api/family/presence` | Anwesenheits-Status |
| `GET` | `/api/discovery/systems` | Netzwerk-Systemerkennung |
| `GET` `POST` | `/api/meter/scan` | Modbus Register-Scan |
| `GET` | `/api/devices` | Erkannte Geräte |

> Die vollständige, immer aktuelle Endpunkt-Referenz steht als Swagger UI unter
> `/api-docs.html` (`openapi.json`) zur Verfügung. Eine Regressionsschranke für
> client-seitig genutzte Endpunkte liefert `tests/endpoint-inventory.mjs`.

### Wichtige Config-Sektionen

| Sektion | Beschreibung |
|---------|--------------|
| `manufacturer` | Aktives Herstellerprofil, aktuell `victron` |
| `httpPort` / `httpsPort` | Webserver-Ports (Default 80 / 443) |
| `modbusListenHost` / `modbusListenPort` | DV-Modbus-Server-Bind (Default `0.0.0.0:1502`) |
| `victron` | Anlagenadresse, Transport (Modbus/MQTT) |
| `schedule` | Zeitplan-Regeln, Defaults und Kleine Börsenautomatik (`smallMarketAutomation`) |
| `userEnergyPricing` | Preislogik (fix/dynamisch), Tarif-Perioden, Paragraph 14a Modul 3 |
| `epex` | EPEX aktiviert, Preiszone (`bzn`), Zeitzone |
| `telemetry` | PostgreSQL-Verbindung, TimescaleDB, Raw-Retention, VRM-History-Import |
| `optimizer` | Optimizer-Konfiguration (intern/EOS) |
| `vpn` | VPN-Tunnel — Protokoll, Auto-Connect, Watchdog |
| `dvControl` | DV-Steuerung, PV-Export-Modus und Negativpreis-Schutz |
| `scan` | Modbus Scan-Parameter |

Die `schedule.smallMarketAutomation`-Sektion enthält die zweistufige Forecast-aware-Logik:
`forecastAware` aktiviert Stufe 1, der `predictivePreEmpty`-Unterblock (mit
`enabled`, `akkuHardLimitW`, `akkuSoftLimitW`, Confidence-Faktoren) steuert
Stufe 2 („Forecast Aware++“).

Zusätzlich erwartet DVhub ein Herstellerprofil neben der Betriebs-Config:

| Datei | Zweck |
|-------|-------|
| `/etc/dvhub/hersteller/victron.json` | Victron-spezifische Kommunikations- und Registerwerte |

### Hinweise

- Änderungen an Victron-Registern, Port, Unit-ID oder Timeout erfolgen nur in `/etc/dvhub/hersteller/victron.json`
- `dvControl.enabled` ist standardmäßig deaktiviert und muss aktiv gesetzt werden
- `userEnergyPricing` erlaubt festen Endkundenpreis oder dynamische Preisbestandteile auf Basis von EPEX
- `userEnergyPricing.periods` erlaubt mehrere, sich nicht überschneidende Tarifzeiträume (`fixed` oder `dynamic`)
- im MQTT-Modus wird `victron.mqtt.portalId` benötigt; ohne eigenen Broker nutzt DVhub den GX-Host
- EPEX-Preise werden primär von api.dvhub.de geholt, Fallback auf Energy Charts direkt
- TimescaleDB ist in `config.example.json` standardmäßig aktiv (`telemetry.database.timescaledb`)
  und ersetzt dann App-Rollups/Retention; bei fehlender Extension fällt DVhub auf App-Rollups zurück
- Ein `POST /api/config` ersetzt die gesamte Config — immer das vollständige Objekt senden

---

## Changelog

### 0.8.0 (2026-05-18) — HEMS-Ausbau

Großer Funktionssprung von der reinen DV-Schnittstelle zum Home Energy Management
System. Verdichtete Übersicht der Arbeit seit 0.4.0:

**Prognose-Engine:**

- PV-Ertragsprognose über pvlib mit Standort-/Anlagenparametern
- Lastvorhersage über statistische Modelle (statsforecast) und LightGBM
- Multi-Modell-Ensemble, Nebel-Korrektur, Accuracy-Tracking und Forecast-Snapshots
- optionale Cloud-PV-Provider (Solcast, pvnode.de) als zusätzliche Eingangsdaten

**Optimierung &amp; Börsenautomatik:**

- interner MILP-Batterieoptimizer (HiGHS-Solver) und schnelle Heuristik
- Anbindung von Akkudoktor-EOS als externer Optimizer-Dienst
- Confidence-Gate verwirft Optimierungen bei zu unsicherer Prognose
- zweistufige Forecast-aware Börsenautomatik: Stufe 1 dimensioniert Reserve/Hoarding-Gate
  aus dem PV-Forecast, Stufe 2 („Forecast Aware++“) leert den Akku vorausschauend
  mit Soft-/Hard-Limit-Taper und Live-Runtime-Clamp

**ML &amp; Edge-KI:**

- selbstlernende ML-Korrektur des Prognosefehlers mit atomarem Modell-Swap und Schema-Guard
- Hintergrund-Retraining als Jobs, ML-Health-Überwachung
- optionales lokales LLM (TinyLlama via Ollama) für natürlichsprachige Dashboard-Kacheln
  mit deterministischem Template-Fallback und Spracherkennung
- hardware-abhängige Leistungsstufen (RAM-Tiers) im Installer

**Oberfläche &amp; Familien-Dashboard:**

- vollständige Portierung aller Seiten auf das Aurora Design System
- Familien-Dashboard mit Haus-zentriertem Energy-Flow, MQTT-Kacheln,
  Tesla-/EV-Integration und Screensaver-Modus
- History-Seite mit 14 Visualisierungs-Karten und CSV-/Parquet-Export
- eigene Integrations-Seite inkl. MQTT-Inspector, eigener Explorer
- Tools-Seite in die Einstellungen / Status integriert

**Integrationen &amp; Betrieb:**

- MQTT-Publisher mit Home-Assistant-Auto-Discovery, eingebauter Broker (aedes)
- TeslaMate-Anbindung mit DB-historisierten Fahrzeugwerten
- Telegram-/Pushover-Benachrichtigungen
- VPN-Manager für OpenVPN-/WireGuard-/IPsec-Tunnel
- Hersteller-Adapter-Layer, Service-orientierte Architektur
- Prometheus-Metriken unter `/api/metrics`
- TimescaleDB-Unterstützung (Continuous Aggregates &amp; Retention)
- Multi-Schema-Telemetrie, Defence-in-Depth-Security-Hardening
- `THIRD-PARTY-LICENSES.md` als Attributionsdatei ergänzt

> Hinweis zur Versionierung: v1.0 ist für eine Veröffentlichung mit echtem
> Nutzerkreis und Lizenzschlüssel-Mechanik reserviert; der aktuelle Stand wird
> bewusst als 0.8 geführt.

### 0.4.0 (2026-03-24)

- Responsive Dashboard (iPhone-Viewport), Hamburger-Navigation ohne JS
- PV-Export-Modus (nutzt `pvTotalW` statt nur DC-PV), Negativpreis-Pause
- sinnvolle Defaults bei Erstinstallation, PV-Kopplungsauswahl (AC/DC/AC+DC)
- Standort-Eingabe mit OpenStreetMap-Picker, MILP als Default-Engine

### Ältere Versionen (0.3.x)

- **0.3.10** — Update-Channel-System (Stable/Dev), PostgreSQL Auto-Schema
- **0.3.9** — Schedule-gesteuerte DC-Einspeisung, `dcExportMode` nur per Schedule
- **0.3.6** — DVhub Price API, Preiszonen-Selektor, Migration SQLite → PostgreSQL,
  DV-Schaltsignal-Log
- **0.3.5.1** — Kleine Börsenautomatik, History-Marktwerte, Security-Hardening
  (Timing-Safe Token, CSP, Config `0600`, SQL-Injection-Schutz)

---

## Lizenz

DVhub steht unter der **Energy Community License (ECL-1.0)** — siehe
[`LICENSE.md`](LICENSE.md). Ziel der Lizenz ist es, die Energie-Community zu
unterstützen und gleichzeitig den kommerziellen Weiterverkauf der Software zu
verhindern.

### Erlaubt

- Betrieb von Energieanlagen mit dieser Software, inkl. Einnahmen aus der Energieerzeugung
- Beauftragung von Dienstleistern für Installation, Konfiguration oder Administration
- Studium, Modifikation, Forks und Weitergabe modifizierter Versionen

### Nicht erlaubt (ohne kommerzielle Lizenz)

- Verkauf der Software selbst oder abgeleiteter Versionen
- Verkauf von Hardware mit vorinstallierter Software
- kommerzielle SaaS-Angebote auf Basis dieser Software
- Bündelung der Software in kommerziellen Produkten

Wer die Software in ein kommerzielles Produkt integrieren möchte, fordert eine
**kommerzielle Lizenz** an — siehe [`COMMERCIAL_LICENSE.md`](COMMERCIAL_LICENSE.md).

### Drittanbieter-Software

DVhub bündelt und nutzt Software Dritter. Alle eingebundenen Komponenten stehen
unter permissiven Lizenzen (MIT, Apache-2.0, ISC, BSD-3-Clause, 0BSD) — die
vollständige Auflistung mit Lizenztexten steht in
[`THIRD-PARTY-LICENSES.md`](THIRD-PARTY-LICENSES.md).
