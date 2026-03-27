<p align="center">
  <img src="assets/dvhub.jpg" alt="DVhub Logo" width="640" />
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
  The unofficial DV interface — Direct Marketing Interface for Victron
</p>

> **Digitale Direktvermarktungsschnittstelle** auf Basis der PLEXLOG Modbus-Register,
> zugeschnitten auf Victron ESS-Systeme mit LUOX Energy (ehem. Lumenaza) als Direktvermarkter.

| | |
|---|---|
| **Status** | `main` -- Version 0.4.1 |
| **Getestet mit** | LUOX Energy, Victron Ekrano-GX, Fronius AC-PV |
| **Lizenz** | Energy Community License (ECL-1.0) |

<p align="center">
  <a href="assets/screenshots/dashboard-live-full-2026-03-24.png"><img src="assets/screenshots/dashboard-live-full-2026-03-24.png" alt="DVhub Leitstand v0.4.0" width="880" /></a>
</p>
<p align="center">
  <a href="assets/screenshots/history-day-2026-03-24-full.png"><img src="assets/screenshots/history-day-2026-03-24-full.png" alt="DVhub Historie Tag 24.03.2026" width="440" /></a>
  <a href="assets/screenshots/settings-control-2026-03-24.png"><img src="assets/screenshots/settings-control-2026-03-24.png" alt="DVhub Einstellungen Steuerung" width="440" /></a>
</p>

---

## Kurzüberblick

DVhub ersetzt bzw. ergänzt einen physischen Plexlog als DV-Schnittstelle. Die Modbus-Kommunikation
des Direktvermarkters wird in Software nachgebildet, während die Live-Daten direkt vom Victron-GX-System kommen.

- **DV-Schnittstelle und Web-Leitstand** in einer Anwendung
- **Dashboard** mit Energy-Flow-Visualisierung, Live-Werten, Day-Ahead-Preisen und Steuerung
- **Historie** mit 5 Finanz-Karten (Energiekosten, Einnahmen, Cashflow, Vermiedene Kosten, Gesamtbilanz)
- **Kleine Börsenautomatik** für automatische Entladung in Hochpreisphasen
- **DVhub Price API** (api.dvhub.de) als zentraler Preisfeed für alle 44 EPEX-Preiszonen
- **Setup** — Victron-Anlage verbinden mit einem Klick
- **Einstellungen** mit 4-Tab-Layout, kompakten Group-Cards und Sticky-Save-Bar
- **Victron-Anbindung per Modbus TCP oder MQTT**
- **PostgreSQL-Telemetrie** mit Rollups, Preis-Backfill und optionalem VRM-Nachimport
- **Integrationsplattform** für EOS, EMHASS, Home Assistant und Loxone

## Inhaltsverzeichnis

- [Schnellstart](#schnellstart)
- [Was DVhub kann](#was-dvhub-kann)
- [Oberflächen](#oberflächen)
- [Integrationen](#integrationen)
- [Direktvermarktung kompakt](#direktvermarktung-kompakt)
- [Installation im Detail](#installation-im-detail)
- [API und Konfiguration](#api-und-konfiguration)
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

- installiert Node.js und PostgreSQL
- legt PostgreSQL-User und Datenbank `dvhub` an (Peer-Auth via Unix-Socket)
- klont das Repo nach `/opt/dvhub`
- nutzt die App unter `/opt/dvhub/dvhub`
- migriert alte Installationen aus `/opt/dvhub/dv-control-webapp`
- richtet einen systemd-Service ein
- nutzt eine externe Config-Datei unter `/etc/dvhub/config.json`
- aktiviert Health-Checks und optionalen Restart aus der GUI
- startet `dvhub.service` nach dem Update automatisch neu
- **Stable-Channel** (Standard): checkt den neuesten Release-Tag aus
- **Dev-Channel** (`--channel dev`): checkt `origin/main` HEAD aus
- Update-Channel ist über die Tools-Seite umschaltbar

Wenn die Config-Datei noch fehlt oder ungültig ist, öffnet DVhub beim ersten Aufruf automatisch den Setup-Assistenten.

### Erster Aufruf

- Dashboard: `http://<host>:8080/`
- Historie: `http://<host>:8080/history.html`
- Einstellungen: `http://<host>:8080/settings.html`
- Setup: `http://<host>:8080/setup.html`
- Tools: `http://<host>:8080/tools.html`

---

## Was DVhub kann

### Kernfunktionen

- **DV-Modbus-Server** auf Standard-Port `1502` mit FC3/FC4 Read und FC6/FC16 Write
- **DV-Signalerkennung** inklusive Lease-Logik und sicherer Rückkehr in Freigabe
- **Victron-Steuerung** für Grid Setpoint, Charge Current und Min SOC
- **Negativpreis-Schutz** mit automatischer Reaktion auf EPEX-Preise
- **Day-Ahead-Preis-Engine** mit Heute-/Morgen-Daten, Hover-Details und Chart-Auswahl
- **Zentraler Preisfeed** über api.dvhub.de mit allen 44 EPEX Day-Ahead Bidding Zones
- **Dynamischer Preiszonen-Selektor** in Einstellungen und Setup mit Live-Abdeckungsinfo
- **Schedule-System** mit Defaults, manuellen Writes und Chart-zu-Schedule-Auswahl
- **Kosten- und Preislogik** für Netz, PV und Akku über `userEnergyPricing`
- **Datumsbasierte Bezugspreise** über `userEnergyPricing.periods`
- **Paragraph 14a Modul 3** mit konfigurierbaren Preisfenstern
- **Kleine Börsenautomatik** für automatische Entladung in Hochpreisphasen mit energiebasierter Slot-Allokation und dynamischem SOC-Floor (Sonnenaufgang-basiert)
- **PostgreSQL-Telemetrie** mit Persistenz, Rollups, historischem Nachimport und History-Analyse
- **Modulare Architektur** mit 8 Factory-Modulen und DI Context Pattern

### Betriebsmodell

- **Modbus TCP oder MQTT** als Victron-Transport
- **Externe Konfiguration** statt fest eingebauter Runtime-Dateien
- **systemd-ready** für dauerhaften Betrieb
- **Health-/Service-Status** direkt in Einstellungen und Tools

---

## Oberflächen

### Dashboard

Das Dashboard bündelt die laufenden Betriebsdaten:

- DV-Schaltstatus
- Börsenpreis mit Negativpreis-Schutz
- Netzleistung pro Phase
- Victron-Zusatzwerte wie SOC, Akku-Leistung und PV
- Kostenübersicht für den aktuellen Tag
- Day-Ahead-Chart mit Hover, Highlight und Schedule-Auswahl
- Kleine Börsenautomatik mit Planungsanzeige, Chart-Highlighting und Statusübersicht
- Steuerung mit aktiven Werten, Defaults und manuellen Writes
- letzte Events aus dem Systemlog

### Einstellungen

Die Einstellungsseite ist in kompakte Arbeitsbereiche gegliedert:

- Schnellstart
- Anlage verbinden
- Steuerung
- Preise & Daten
- Erweitert

Dazu kommen Import/Export, Health-Checks, Service-Status und optional ein Restart-Button.
Die EPEX-Preiszone wird über einen dynamischen Selektor gewählt, der die verfügbaren Zonen samt Abdeckung direkt von der DVhub Price API lädt.

### Setup

Der First-Run-Setup-Assistent führt Schritt für Schritt durch:

- Alle Felder sind mit sinnvollen Defaults vorbelegt — nur die Victron-IP muss eingegeben werden
- HTTP-Port und API-Token
- Victron-Verbindung per Modbus oder MQTT mit automatischer Systemerkennung
- Meter- und DV-Basiswerte
- EPEX-Grunddaten mit dynamischem Preiszonen-Selektor
- Review-Schritt mit Validierung vor dem Speichern
- Nach dem Speichern wird direkt zum Leitstand weitergeleitet

### Tools / Wartung

Die Wartungsseite enthält:

- **DV-Schaltsignal-Log** mit Filterfunktion (Schaltbefehle, Modbus/Setpoint-Writes, Victron-Writes, Börsenautomatik)
- Modbus Register Scan
- Schedule JSON Bearbeitung
- Health-/Service-Status
- Config Import/Export
- VRM History-Import für Telemetrie-Nachfüllung
- API-Dokumentation (Swagger UI)

### Historie

Die History-Seite bündelt die PostgreSQL-Telemetrie zu einer eigenen Analyseansicht:

- Tag-, Wochen-, Monats- und Jahresansicht
- Bezug, Einspeisung, Kosten, Erlöse und Netto je Zeitraum
- Preisvergleich zwischen historischem Marktpreis und eigenem Bezugspreis
- Preisliste und Aggregat-Preishinweis in der Tagesansicht
- Solar-Zusammenfassung mit Jahres-Marktwert in der Jahresansicht
- Energie-Balkendiagramme in Wochen-/Monats-/Jahresansicht
- Kennzeichnung unvollständiger Slots bei fehlenden Marktpreisen oder Tarifzeiträumen
- gezielter Preis-Backfill nur für Telemetrie-Buckets ohne historischen Marktpreis

---

## Integrationen

DVhub stellt Daten bereit oder nimmt Optimierungsergebnisse entgegen für:

- **Home Assistant**
- **Loxone**
- **EOS (Akkudoktor)**
- **EMHASS**

Zusätzlich kann DVhub historische Daten per **VRM** nachladen, wenn neue Installationen ältere Werte auffüllen sollen oder Lücken entstanden sind.

Für Marktpreise nutzt DVhub den zentralen **DVhub Price Feed** (api.dvhub.de) mit Fallback auf Energy Charts.

---

## DVhub Price API

DVhub betreibt unter `api.dvhub.de` einen zentralen Preisfeed für EPEX Day-Ahead Preise:

- **44 Bidding Zones** (AT, BE, BG, CH, CZ, DE-LU, DK1, DK2, ES, FI, FR, NL, NO1-5, PL, SE1-4, ...)
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

Der physische Plexlog kann Live-Daten liefern, aber die Steuerung moderner Victron-Setups ist in der Praxis oft unflexibel oder nicht vollständig nutzbar. DVhub liest die Daten direkt vom GX-Gerät und beantwortet die PLEXLOG-kompatiblen Modbus-Anfragen in Software.

### Wer braucht das?

Nach dem Solarspitzengesetz benötigen PV-Anlagen ab **25 kWp** typischerweise eine DV-Schnittstelle für die Direktvermarktung. Kleinere Anlagen können freiwillig teilnehmen.

### Warum ist das auch unter 30 kWp interessant?

Mit der diskutierten **Pauschaloption / MiSpeL** wird Direktvermarktung auch für kleinere Anlagen mit Speicher attraktiver, weil Speicher flexibler aus PV und Netz geladen werden dürfen und die Vermarktung wirtschaftlich interessanter wird.

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
2. OpenVPN-Tunnel zu LUOX
3. Portforwarding von Port `502` aus dem Tunnel auf Port `1502` von DVhub

**Unifi-Hinweis:** Falls die GUI das Tunnel-Portforwarding nicht sauber abbildet, hilft das Skript [`20-dv-modbus.sh`](20-dv-modbus.sh) für die iptables-Regeln.

---

## Installation im Detail

### Voraussetzungen

- Node.js 22+
- PostgreSQL 14+ (für Telemetrie)
- Victron GX-Gerät im lokalen Netz

### Manuelle Installation

```bash
sudo apt update
sudo apt install -y curl ca-certificates git postgresql
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo apt install -y tcpdump jq
sudo mkdir -p /opt/dvhub /etc/dvhub /var/lib/dvhub
sudo useradd -r -s /usr/sbin/nologin dvhub
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

Technische Victron-Werte wie Register, Port, Unit-ID oder Timeout werden nicht mehr in `/etc/dvhub/config.json` gepflegt.
Diese Werte liegen im Herstellerprofil unter `/etc/dvhub/hersteller/victron.json`.

Nur bei MQTT-Nutzung zusätzlich:

```bash
npm install mqtt
```

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

### Wichtige API-Endpunkte

| Methode | Pfad | Beschreibung |
|---------|------|--------------|
| `GET` | `/dv/control-value` | DV Status: `0` = Abregelung, `1` = Einspeisung erlaubt |
| `GET` | `/api/status` | Vollständiger Systemstatus |
| `GET` | `/api/costs` | Tages-Kostenübersicht |
| `GET` | `/api/log` | Letzte 300 Event-Log Einträge |
| `GET` | `/api/config` | Aktuelle Konfiguration |
| `POST` | `/api/config` | Konfiguration aktualisieren |
| `POST` | `/api/config/import` | Config aus JSON importieren |
| `GET` | `/api/config/export` | Config als JSON exportieren |
| `GET` | `/api/admin/health` | Health-Check Status |
| `POST` | `/api/admin/service/restart` | systemd-Service neu starten |
| `GET` | `/api/discovery/systems` | Netzwerk-Systemerkennung |

**EPEX / Preise:**

| Methode | Pfad | Beschreibung |
|---------|------|--------------|
| `POST` | `/api/epex/refresh` | EPEX-Preise manuell aktualisieren |
| `GET` | `/api/epex/zones` | Verfügbare Preiszonen von api.dvhub.de |
| `GET` | `/api/epex/gaps?zone=DE-LU` | Fehlende Preisdaten für Zone |
| `POST` | `/api/epex/backfill` | Backfill fehlender Preise anstoßen |

**History / Telemetrie:**

| Methode | Pfad | Beschreibung |
|---------|------|--------------|
| `GET` | `/api/history/summary?view=day&date=YYYY-MM-DD` | Historische Zusammenfassung |
| `POST` | `/api/history/import` | Historische Telemetrie importieren |
| `GET` | `/api/history/import/status` | Import-Status |
| `POST` | `/api/history/backfill/vrm` | VRM Full/Gap-Backfill |
| `POST` | `/api/history/backfill/prices` | Preis-Backfill via Energy Charts |

**Schedule / Steuerung:**

| Methode | Pfad | Beschreibung |
|---------|------|--------------|
| `GET` | `/api/schedule` | Aktuelle Schedule-Regeln und Config |
| `POST` | `/api/schedule/rules` | Schedule-Regeln aktualisieren |
| `POST` | `/api/schedule/config` | Default-Werte aktualisieren |
| `GET` | `/api/schedule/automation/config` | Kleine Börsenautomatik Config |
| `POST` | `/api/schedule/automation/config` | Kleine Börsenautomatik anpassen |
| `POST` | `/api/control/write` | Manueller Write (gridSetpoint, chargeCurrent, minSoc) |

**Modbus Scan:**

| Methode | Pfad | Beschreibung |
|---------|------|--------------|
| `GET` | `/api/meter/scan` | Scan-Ergebnisse abrufen |
| `POST` | `/api/meter/scan` | Modbus Register-Scan starten |

**Integrationen:**

| Methode | Pfad | Beschreibung |
|---------|------|--------------|
| `GET` | `/api/integration/home-assistant` | Home Assistant JSON |
| `GET` | `/api/integration/loxone` | Loxone Textformat |
| `GET` | `/api/integration/eos` | EOS Messwerte + EPEX-Preise |
| `POST` | `/api/integration/eos/apply` | EOS Optimierung anwenden |
| `GET` | `/api/integration/emhass` | EMHASS Messwerte + Preisarrays |
| `POST` | `/api/integration/emhass/apply` | EMHASS Optimierung anwenden |

**Keepalive:**

| Methode | Pfad | Beschreibung |
|---------|------|--------------|
| `GET` | `/api/keepalive/modbus` | Letzte Modbus-Abfrage |
| `GET` | `/api/keepalive/pulse` | 60s Uptime-Pulse |

### Wichtige Config-Sektionen

| Sektion | Beschreibung |
|---------|--------------|
| `manufacturer` | Aktives Herstellerprofil, aktuell `victron` |
| `victron` | Anlagenadresse, Transport (Modbus/MQTT) |
| `schedule` | Zeitplan-Regeln, Defaults und Kleine Börsenautomatik (`smallMarketAutomation`) |
| `epex` | Preiszone (`bzn`), Zeitzone, Price API URL |
| `telemetry` | PostgreSQL-Verbindung, Rollups, Retention, VRM-History-Import |
| `userEnergyPricing` | Preislogik für Netz, PV und Akku, Perioden, Marktwerte, Paragraph 14a |
| `dvControl` | DV-Steuerung und Negativpreis-Schutz |
| `scan` | Modbus Scan-Parameter |

Zusätzlich erwartet DVhub ein Herstellerprofil neben der Betriebs-Config:

| Datei | Zweck |
|-------|-------|
| `/etc/dvhub/hersteller/victron.json` | Victron-spezifische Kommunikations- und Registerwerte |

### Bezugspreise nach Zeitraum

Unter `userEnergyPricing.periods` lassen sich mehrere Tarifzeiträume definieren:

- Zeiträume sind tageweise und inklusive `startDate` bis `endDate`
- Zeiträume dürfen sich nicht überschneiden
- pro Zeitraum ist `fixed` oder `dynamic` möglich
- wenn kein Zeitraum passt, greift die bestehende Legacy-Preislogik als Fallback

### Marktwert- und Marktprämien-Modus

Unter `userEnergyPricing` stehen für die History-Marktprämie zwei zusätzliche Felder bereit:

- `marketValueMode`: `annual` für das bisherige Verhalten oder `monthly` für Monatsmarktwerte
- `pvPlants`: Liste der PV-Anlagen mit `kwp` und `commissionedAt`

### Hinweise

- Änderungen an Victron-Registern, Port, Unit-ID oder Timeout erfolgen nur in `/etc/dvhub/hersteller/victron.json`
- Die normale `config.json` bleibt damit klein und enthält nur Betriebs- und Anlagenwerte
- `dvControl.enabled` ist standardmäßig deaktiviert und muss aktiv gesetzt werden
- `userEnergyPricing` erlaubt festen Endkundenpreis oder dynamische Preisbestandteile auf Basis von EPEX
- im MQTT-Modus wird `victron.mqtt.portalId` benötigt; ohne eigenen Broker nutzt DVhub den GX-Host
- `npm install mqtt` wird nur für MQTT-Betrieb benötigt
- EPEX-Preise werden primär von api.dvhub.de geholt, Fallback auf Energy Charts direkt

---

## Changelog

### 0.4.0 (2026-03-24)

**Responsive Dashboard (iPhone 15 Pro Max):**

- Hamburger-Navigation (CSS-only Checkbox-Hack, kein JS)
- Flow-Diagramm skaliert auf 430px Viewport
- Netzphasen-Detail unterhalb des Diagramms auf Mobile
- Touch-optimierte Karten (44px Targets), kompakte Tabellen
- Tier-Felder gestapelt (Label oben, Input darunter)
- Keine horizontalen Scrollbars, keine versteckten Spalten

**PV-Export-Modus (ehem. DC-Export-Modus):**

- Umbenannt: DC-Export-Modus -> PV-Export-Modus
- Nutzt jetzt pvTotalW (DC + AC) statt nur DC-PV fuer Grid Setpoint
- Negativpreis-Schutz: Export pausiert automatisch bei EPEX < 0 ct/kWh
- Bei Preis >= 0 wird sofort weiter exportiert

**Dashboard-Verbesserungen:**

- PV-Karte zeigt PV Gesamt als Hauptwert (DC-PV + AC-PV)
- AC-PV-Wert wird aus Gesamtleistung und DC-PV berechnet
- Tooltip-Icons (i) fuer alle Einstellungsfelder mit Help-Text

**Einstellungen:**

- Sinnvolle Defaults bei Erstinstallation (Strompreise, Batterie, Boersenautomatik)
- PV-Kopplungsauswahl (AC/DC/AC+DC) mit Modbus-Endpunkt pro Hersteller
- Standort-Eingabe mit OpenStreetMap-Picker (Koordinaten per Klick)
- MILP als Default-Engine fuer Boersenautomatik

### 0.3.10 (2026-03-22)

**Update-Channel-System:**

- Neuer Update-Channel: Stable (Release-Tags) oder Dev (Bleeding Edge main HEAD)
- Channel wählbar über Tools-Seite oder Installer (`--channel dev`)
- Stable folgt Git-Tags, Dev folgt origin/main — sauber umschaltbar
- Installer schreibt `updateChannel` in die Config

**PostgreSQL Auto-Schema:**

- Datenbank-Tabellen werden beim ersten Start automatisch erstellt (CREATE TABLE IF NOT EXISTS)
- Neue Installationen funktionieren ohne manuelle Schema-Migration
- Installer installiert PostgreSQL, legt User/DB an und konfiguriert Peer-Auth via Unix-Socket

**Bugfixes:**

- Fix: startAutomaticMarketValueBackfill ruft getTelemetryBounds jetzt korrekt mit await auf
- Fix: Unhandled Rejection bei leerer Datenbank behoben
- Fix: Telemetrie-Init mit async Connectivity-Check und graceful Error-Handling

### 0.3.9 (2026-03-21)

**Schedule-gesteuerte DC-Einspeisung:**

- feedExcessDcPv (Register 2707/2708) ist jetzt über Schedule-Regeln steuerbar
- Default: EIN (Überschuss wird eingespeist), abschaltbar per Schedule-Regel oder manuell
- Negativer Preisschutz und DV forcedOff überschreiben weiterhin (höchste Priorität)
- Nach DV-Freigabe oder Lease-Ablauf wird der Schedule-Zustand respektiert statt blind einzuschalten
- Neuer Default-Config-Wert: defaultFeedExcessDcPv (änderbar über Dashboard)
- Dashboard zeigt DC-Einspeisungs-Status mit Quelle (Schedule/Default/DV/Negativpreis)

**dcExportMode nur noch per Schedule:**

- dcExportMode (dynamischer Grid Setpoint = -(PV - Buffer)) erfordert jetzt eine aktive Schedule-Regel
- Statische Aktivierung über Config (enabled/priceThresholdCtKwh) entfernt
- Verhindert unbeabsichtigte Batterie-Entladeblockade durch dauerhaften DC-Export
- SOC-Guard bleibt aktiv (Batterie laden vor Abend-Peak)

**applyDvVictronControl Fix:**

- Register 2707 wird jetzt auch beim Einschalten (feedIn=true) aktiv geschrieben
- Vorher wurde nur beim Abschalten geschrieben, Einschalten war ein No-Op

### 0.3.6 (2026-03-18)

**DVhub Price API:**

- Zentraler Preisfeed unter api.dvhub.de für alle 44 EPEX Day-Ahead Bidding Zones
- Historische Daten ab 2020, stündlich vor 01.10.2024, 15-Minuten danach
- ENTSO-E Transparency Platform als Primärquelle, Energy Charts als Fallback
- fetchEpexDay() nutzt primär api.dvhub.de mit automatischem Fallback auf Energy Charts
- Neue Proxy-Endpunkte: `/api/epex/zones`, `/api/epex/gaps`, `/api/epex/backfill`
- CORS-Support für DVhub-Instanzen
- Swagger UI API-Dokumentation unter api.dvhub.de/docs
- EPEX Spot Day-Ahead Live-Chart unter api.dvhub.de/spot und dvhub.de/spot
- Backfill-API nur aus dem LAN erreichbar (POST /api/backfill)

**Preiszonen-Selektor:**

- Dynamischer Dropdown in Einstellungen und Setup-Wizard
- Lädt verfügbare Zonen mit Abdeckungsinfo direkt von der Price API
- Neuer Config-Typ `dynamicSelect` für API-gestützte Auswahlfelder
- Neues Config-Feld `epex.priceApiUrl` (Standard: https://api.dvhub.de)

**PostgreSQL-Migration:**

- Telemetrie-Backend von SQLite auf PostgreSQL umgestellt
- Neuer `telemetry-store-pg.js` mit Connection-Pooling
- Neuer `db-client.js` für zentrale Datenbankverbindung
- Migrationsscript `scripts/migrate-sqlite-to-pg.sh` mit SQLite-Backup
- Config-Sektion `telemetry.database` für PostgreSQL-Verbindungsdaten

**Kleine Börsenautomatik - Plan-Lock:**

- Bugfix: Laufende Entladung wird nicht mehr durch Re-Planning abgebrochen
- Plan-Lock-Mechanismus verhindert Neuberechnung während aktiver Slot-Ausführung
- SoC-basierte Regeneration nur noch außerhalb der Entlade-/Cooldown-Phasen
- Cooldown-Lock bis 30 Minuten nach letztem Slot-Ende bei vorhandenen Zukunfts-Slots

**DV-Schaltsignal-Log:**

- Neue Wartungsseiten-Ansicht für alle DV-Steuersignale
- Filterfunktionen: Schaltbefehle, Modbus/Setpoint-Writes, Victron-Writes, Börsenautomatik
- Erweiterte Signal-Typen: control_write, sma_plan_applied, schedule_auto_disabled, schedule_stop_soc_reached
- Farbcodierung: Rot für Fehler/Abregelung, Grün für Freigabe/Plan, Blau für Writes

**Weitere Änderungen:**

- InfluxDB-Konfiguration entfernt (nicht mehr benötigt)
- History-Import verwendet korrekte Datenbankabstraktion

### 0.3.5.1 (2026-03-13)

**Kleine Börsenautomatik (neu):**

- Automatische Entladung in Hochpreisphasen basierend auf Day-Ahead-Preisen
- Energiebasierte Slot-Allokation statt fester Slot-Anzahl
- Multi-Stage Chain-Varianten für mehrstufige Entladestrategien
- Chart-Highlighting der geplanten Entlade-Slots im Day-Ahead-Chart
- Konfigurierbares Suchfenster, Min-SOC, Max-Entladeleistung und Aggressivitätsprämie

**History und Marktwerte:**

- Marktwerte für Wochen- und Monatsansichten nachladen
- Lokale Persistenz der Marktwert-Referenzdaten
- Solar-Zusammenfassung mit Jahres-Marktwert in der Jahresansicht
- Energie-Balkendiagramme in Wochen-/Monats-/Jahresansicht
- VRM Full-Backfill durchläuft jetzt auch alte Lücken am Anfang

**Security-Hardening:**

- Timing-Safe Token-Vergleich (`crypto.timingSafeEqual`)
- Content-Security-Policy Header
- API-Responses redaktieren sensible Felder
- Config-Datei wird mit `0600`-Berechtigung geschrieben
- SQL-Injection-Schutz in `countRows()` per Table-Allowlist

---

## Lizenz

This project is licensed under the **Energy Community License (ECL-1.0)**.

The goal of this license is to support the renewable energy community
while preventing commercial reselling of the software.

### Allowed

* Operating energy systems using this software
* Generating revenue from energy production
* Hiring companies for installation or administration
* Community modifications and forks

### Not allowed

* Selling the software itself
* Selling hardware with the software preinstalled
* Commercial SaaS offerings based on this software
* Bundling the software into commercial products

If your company wants to integrate this software into a commercial
product, please request a **commercial license**.
