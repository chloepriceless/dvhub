<p align="center">
  <img src="docs/plexlite-logo.png" alt="PlexLite Logo" width="640" />
</p>

```
██████╗ ██╗     ███████╗██╗  ██╗██╗     ██╗████████╗███████╗
██╔══██╗██║     ██╔════╝╚██╗██╔╝██║     ██║╚══██╔══╝██╔════╝
██████╔╝██║     █████╗   ╚███╔╝ ██║     ██║   ██║   █████╗
██╔═══╝ ██║     ██╔══╝   ██╔██╗ ██║     ██║   ██║   ██╔══╝
██║     ███████╗███████╗██╔╝ ██╗███████╗██║   ██║   ███████╗
╚═╝     ╚══════╝╚══════╝╚═╝  ╚═╝╚══════╝╚═╝   ╚═╝   ╚══════╝
```

<p align="center">
  <strong>Hack the Grid</strong><br/>
  The unofficial DV interface — Direct Marketing Interface for Victron
</p>

> **Digitale Direktvermarktungsschnittstelle** auf Basis der PLEXLOG Modbus-Register,
> zugeschnitten auf Victron ESS-Systeme mit LUOX Energy (ehem. Lumenaza) als Direktvermarkter.

| | |
|---|---|
| **Status** | WIP -- Version 0.2 by agentic engineering.|
| **Getestet mit** | LUOX Energy, Victron Ekrano-GX, Fronius AC-PV |
| **Lizenz** | Energy Community License (ECL-1.0) |

<p align="center">
  <img src="docs/dashboard-desktop.png" alt="PlexLite Dashboard — Desktop" width="900" />
</p>

---

## Überblick

PlexLite ersetzt bzw. ergänzt einen physischen Plexlog als DV-Schnittstelle.
Alle Modbus-Anfragen von LUOX wurden per Paketmitschnitt am physischen Plexlog abgefangen
und in Software nachgebaut -- damit können **alle Victron-Anlagen** in die Direktvermarktung integriert werden.

**Warum nicht direkt über den Plexlog?**
Der Plexlog kann Live-Werte liefern (z.B. über einen Victron VM3P75CT Zähler via ModbusTCP),
aber die Leistungsreduzierung scheint nur über die physischen Modbus-Ports zu funktionieren --
eine Steuerung der Victron-Anlage war bisher nicht möglich.
PlexLite liest die Daten direkt vom Ekrano-GX und beantwortet die Modbus-Anfragen des Direktvermarkters.

---

## Hintergrund: Direktvermarktung und Pauschaloption

### Was ist eine DV-Schnittstelle?

Eine DV-Schnittstelle verbindet den Direktvermarkter mit deiner Anlage, um:
- **Live-Werte** abzufragen (Erzeugung, Einspeisung, SOC, etc.)
- **Steuersignale** zu empfangen (Abregelung bei negativen Börsenpreisen)

So kann der Direktvermarkter bei negativen Strompreisen eine Abregelung auslösen
und vermeidet Kosten für eingespeisten Strom unter Marktwert.

### Wer benötigt eine DV-Schnittstelle?

Laut dem **Solarspitzengesetz** (auch "Stromspitzengesetz", in Kraft seit 25.02.2025):
- Alle PV-Anlagen **ab 25 kWp** benötigen eine DV-Schnittstelle für die Direktvermarktung
- Kleinere Anlagen können freiwillig teilnehmen

### Warum Direktvermarktung unter 30 kWp?

Bisher lohnte sich die Direktvermarktung für kleine Anlagen kaum -- man brauchte 60-100 kWh Speicher
für nennenswerte Mehrerlöse. Mit der kommenden **Pauschaloption** ändert sich das grundlegend:
Ab ca. 40 kWh Speicher wird die Teilnahme attraktiv, weil Speicher nun flexibel aus PV *und* Netz
geladen werden dürfen.

### Die Pauschaloption (MiSpeL)

Die Bundesnetzagentur erarbeitet im Festlegungsverfahren **MiSpeL** (Marktintegration von Speichern
und Ladepunkten, Az. 618-25-02) die Umsetzung der Pauschaloption:

**Kernpunkte:**
- **500 kWh pro kWp** pauschal geförderte Einspeisung pro Jahr (Differenz Marktwert zu Anzulegendem Wert wird vergütet)
- Alles darüber wird als "Graustrom" abgerechnet (Börsenwert, keine EEG-Förderung)
- **Mischstromspeicher erlaubt** -- PV und Netzstrom im selben Speicher ohne Subventionsbetrug
- **Bidirektionales Laden** mit E-Autos ohne weiteres möglich
- Nur **ein Smart Meter** (Moderne Messeinrichtung + Gateway) nötig -- keine komplizierten Zählkonzepte
- Max. **30 kWp** installierte Modulleistung (Steckersolargeräte zählen nicht)
- Voraussetzung: **geförderte Direktvermarktung** (nicht Einspeisevergütung)

**Status (März 2026):**
- BNetzA Festlegung muss bis **30. Juni 2026** finalisiert werden
- **EU-beihilferechtliche Genehmigung** steht noch aus
- Konsultationsphase abgeschlossen (Oktober 2025)

**Offizielle Links:**
- [BNetzA MiSpeL Festlegungsverfahren](https://www.bundesnetzagentur.de/DE/Fachthemen/ElektrizitaetundGas/ErneuerbareEnergien/EEG_Aufsicht/MiSpeL/start.html)
- [BNetzA MiSpeL Artikel/Übersicht](https://www.bundesnetzagentur.de/DE/Fachthemen/ElektrizitaetundGas/ErneuerbareEnergien/EEG_Aufsicht/MiSpeL/artikel.html)
- [BNetzA Pressemitteilung (19.09.2025)](https://www.bundesnetzagentur.de/SharedDocs/Pressemitteilungen/DE/2025/20250919_MiSpeL.html)
- [Anlage 2: Pauschaloption Eckpunkte (PDF)](https://www.bundesnetzagentur.de/DE/Fachthemen/ElektrizitaetundGas/ErneuerbareEnergien/EEG_Aufsicht/MiSpeL/DL/Anlage2.pdf)
- [BMWK FAQ Solarspitzengesetz](https://www.bundeswirtschaftsministerium.de/Redaktion/DE/Dossier/ErneuerbareEnergien/faq-zur-energierechtsnovelle-zur-vermeidung-von-stromspitzen-und-zum-biomassepaket.html)

---

## Einrichtung: LUOX Energy Anbindung

### Was muss eingerichtet werden?

1. **LUOX mitteilen** dass ein PLEXLOG als DV-Schnittstelle verbaut ist
2. **OpenVPN-Tunnel** zu LUOX einrichten (Config + Zertifikat erhält man von LUOX)
3. **Portforwarding** in der Firewall: Port 502 (Modbus TCP) vom VPN-Tunnel auf Port 1502 (PlexLite) weiterleiten

### Unifi-Spezialfall

Unifi kann das Portforwarding vom VPN-Tunnel zum Modbus-Endpunkt nicht über die GUI konfigurieren.
Die nötige iptables-Regel muss per CLI gesetzt werden -- und überlebt ggf. keinen Reboot.

In der Datei `20-dv-modbus.sh` ist ein Reboot-Script das die Regeln semi-persistent macht.
Es kann auch zur Ersteinrichtung genutzt werden sobald der VPN-Tunnel steht.

### Verbindung prüfen

Die [LUOX Testseite](https://www.luox-energy.de/verbindungsstatus) sollte grün anzeigen sobald:
- VPN-Tunnel aufgebaut ist
- Portweiterleitung funktioniert
- PlexLite auf Port 1502 läuft und antwortet

---

## DV Control Webapp

Webapp + Modbus-Proxy als Ersatz/Ergänzung zum Node-RED-Flow.

### Neue Weboberflächen

- **Dashboard** fuer Live-Werte, DV-Status und Schedule-Steuerung
- **Einstellungsseite** fuer die komplette Konfiguration als Menue/Formular statt als rohe `config.json`
- **First-Run-Setup** als gefuehrter Assistent, sobald noch keine gueltige Config vorhanden ist
- **Import/Export** vorhandener Config-Dateien direkt ueber die Weboberflaeche
- **Health & Service** mit Install-/Status-Checks und optionalem Restart-Button fuer den systemd-Dienst

### Getestet auf
- Debian 12 Bookworm LXC Container (Community Scripts)

### Installation

Einfachste Variante:

```bash
curl -fsSL https://raw.githubusercontent.com/plexlite/plexlite/main/install.sh | sudo bash
```

Das Skript installiert Node.js, klont das Repo nach `/opt/plexlite`, richtet einen systemd-Service ein
und verwendet bewusst eine **externe Config-Datei** unter `/etc/plexlite/config.json`.
Wenn diese Datei noch nicht existiert, oeffnet die Weboberflaeche automatisch den neuen Setup-Assistenten.
Ausserdem aktiviert das Skript die neuen **Service-Aktionen** in der GUI
(Health-Check + Restart-Button) ueber eine passende `sudoers`-Regel.

Manuelle Installation:

```bash
sudo apt update
sudo apt install -y curl ca-certificates git
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo apt install -y tcpdump jq
sudo mkdir -p /opt/dv-control-webapp
sudo useradd -r -s /usr/sbin/nologin plexlite
```
An dieser Stelle den Inhalt des Repos nach `/opt/dv-control-webapp` kopieren.
```bash
sudo chown -R plexlite:plexlite /opt/dv-control-webapp
cd /opt/dv-control-webapp
cp config.example.json config.json
nano config.json  # Konfiguration anpassen
# Optional: Nur bei MQTT-Nutzung (victron.transport: "mqtt")
npm install mqtt
```

### Systemd Service einrichten

```bash
sudo nano /etc/systemd/system/dv-control-webapp.service
```

Inhalt:
```ini
[Unit]
Description=PlexLite DV Control
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=plexlite
Group=plexlite
WorkingDirectory=/opt/dv-control-webapp
ExecStart=/usr/bin/node /opt/dv-control-webapp/server.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

> **Hinweis:** Wenn PlexLite auf einem privilegierten Port (z.B. 502) lauschen muss,
> kann man stattdessen `User=root` verwenden oder dem Node-Binary `CAP_NET_BIND_SERVICE` geben.

```bash
sudo systemctl enable --now dv-control-webapp
```

### Manueller Start (ohne Service)

```bash
cd /opt/dv-control-webapp
cp config.example.json config.json
npm start
```

### Setup-Flow nach der Installation

- Wenn die Config-Datei fehlt oder ungueltig ist, zeigt `/` automatisch den **Setup-Assistenten**
- Der Assistent fuehrt durch:
  - HTTP-Port und API-Token
  - Victron-Verbindung per Modbus TCP oder MQTT
  - Basiswerte fuer Meter / DV-Proxy
  - EPEX- und Influx-Grunddaten
- Danach kann in der **Einstellungsseite** jedes Detail weiter verfeinert werden
- Bestehende `config.json`-Dateien koennen importiert und exportiert werden

### Admin / Health

Unter **Einstellungen -> Health & Service** zeigt PlexLite jetzt:

- Status der Config-Datei und ob das Setup abgeschlossen ist
- Live-Status von Meter und EPEX
- Laufzeitdaten des aktuellen Prozesses
- systemd-Service-Status
- optional einen **Restart-Button**

> Der Restart-Button ist aus Sicherheitsgruenden nur aktiv, wenn die Service-Aktionen per
> `DV_ENABLE_SERVICE_ACTIONS=1` freigeschaltet wurden. `install.sh` richtet das automatisch ein.

---

### Kernfunktionen

- Modbus TCP Server (Default `:1502`)
  - FC3/FC4 Read
  - FC6/FC16 Write
  - OFF/ON-Signalerkennung:
    - OFF: `addr0=[0,0]` oder `addr3=[1]`
    - ON: `addr0=[65535,65535]` oder `addr3=[0]`
  - OFF-Lease (konfigurierbar, Default 8 Minuten)

- Keepalive / Monitoring
  - `GET /api/keepalive/modbus`: letzte Modbus-Abfrage (Zeit, Quelle, Request)
  - `GET /api/keepalive/pulse`: 60s-Pulse für Uptime-Kuma/Monitoring

- Victron Kommunikation (Modbus TCP oder MQTT)
  - **Transport wählbar** in config: `victron.transport: "modbus"` (Default) oder `"mqtt"`
  - **Modbus TCP**: Direkte Register-Kommunikation mit dem GX-Gerät (Default Port 502, unitId 100)
  - **MQTT**: Verbindung über Venus OS MQTT-Broker (Port 1883, keine Auth auf LAN)
    - Automatisches Subscribe auf System-Topics (Grid, SOC, PV, Batterie)
    - Writes über `W/`-Topics mit Engineering-Werten
    - Keepalive alle 30s für Settings-Refresh
    - Benötigtes Paket: `npm install mqtt` (nur bei MQTT-Nutzung)
  - Hauptmeterblock (Default unitId 100, addr 820, 3 Phasen)
  - Zusatzpunkte (SOC, Batterie, PV, Grid Setpoint, Min SOC, Self Consumption)
  - AC-PV Fronius Phasen 808/809/810 (konfigurierbar) + Summe zu PV Gesamt
  - Berechnete Werte: gridImportW, gridExportW, batteryChargeW, batteryDischargeW, pvTotalW

- Victron DV-Steuerung (`dvControl` in config)
  - Automatische Ansteuerung des Victron Multiplus bei DV-Signal
  - Register 2848: Feed excess DC-coupled PV into grid (0 = blockieren, 1 = einspeisen)
  - Register 2850: Don't feed excess AC-coupled PV into grid (0 = erlaubt, 1 = blockieren)
  - Bei DV OFF-Signal (Abregelung): `2848=0`, `2850=1` -> Eigenverbrauch only
  - Bei DV ON-Signal (Freigabe): `2848=1`, `2850=0` -> Einspeisung erlaubt
  - Wird auch bei Lease-Ablauf automatisch auf Freigabe gesetzt

- Negativpreis-Schutz (`dvControl.negativePriceProtection` in config)
  - Automatische Abregelung bei negativen EPEX-Preisen
  - Grid Setpoint wird auf konfigurierbaren Wert begrenzt (Default: -40 W)
  - Zusätzlich werden die Victron DC/AC-PV Register gesperrt (Eigenverbrauch)
  - Wird automatisch aufgehoben wenn Preis wieder positiv
  - Status im Dashboard sichtbar

- Schedule / Steuerung
  - Zeitplanregeln für:
    - `gridSetpointW` (Grid Setpoint in Watt)
    - `chargeCurrentA` (Ladestrom in Ampere)
  - **Auto-Deaktivierung**: Regeln werden nach Ablauf ihres Zeitfensters automatisch deaktiviert
  - **Aktivierbar/Deaktivierbar**: Jede Regel kann einzeln ein-/ausgeschaltet werden
  - Default-Werte wenn keine Regel greift
  - Manuelle Writes per API für: `gridSetpointW`, `chargeCurrentA`, `minSocPct`
  - Persistierung der Schedule-Regeln in `config.json`

- Day-Ahead Preise (EPEX)
  - Quelle: energy-charts.info API
  - Preiszone: DE-LU (konfigurierbar)
  - Heute + Folgetag Preise
  - Balkendiagramm im Dashboard (negative Preise rot, positive blau)
  - Interaktiver Hover-Tooltip mit Preis und Zeitstempel
  - Erkennung zukünftiger Negativpreise (heute + morgen)
  - Morgen Min/Max Preis Anzeige
  - Automatischer Refresh alle 5 Minuten

- Kosten-Tracking (heute, live)
  - Tagesbasiertes Import/Export Tracking in kWh
  - Kosten und Erlöse basierend auf aktuellem EPEX-Preis
  - Netto-Berechnung (Erlös - Kosten)
  - Persistente Speicherung in `energy_state.json` (überlebt Neustarts)
  - Speicherung alle 60 Sekunden + bei Shutdown + bei Tageswechsel
  - Tagesabschluss-Log mit Zusammenfassung

- InfluxDB (optional)
  - **InfluxDB v3** (Default) und v2 unterstützt (`influx.apiVersion`: `"v3"` oder `"v2"`)
  - Schreiben von Livewerten als Line Protocol
  - v3: `/api/v3/write_lp?db=...&precision=second` mit Bearer-Token
  - v2: `/api/v2/write?org=...&bucket=...&precision=s` mit Token-Auth
  - Measurements: meter, ctrl, victron, energy
  - Flush-Intervall: 10 Sekunden
  - Aktivierung via `influx.enabled=true` in config

- Integrationen
  - Home Assistant: `GET /api/integration/home-assistant` (JSON)
  - Loxone: `GET /api/integration/loxone` (Text Key=Value)
  - EOS (Akkudoktor): `GET /api/integration/eos` (Messwerte + EPEX-Preise im EOS-Format)
  - EMHASS: `GET /api/integration/emhass` (Messwerte + Preisarrays im EMHASS-Format)
  - Optimierung anwenden: `POST /api/integration/eos/apply` bzw. `/emhass/apply`

### Dashboard

Dashboard: `http://<host>:8080/`

Kartenübersicht:
- **DV Schaltstatus**: EIN/AUS, Control Value, Lease-Ablauf, letzte Modbus-Abfrage, DC-PV Einspeisung, AC-PV Blockierung
- **Börsenpreis**: Aktueller Preis, nächster Slot, Negativpreis-Warnung (heute/morgen), Morgen Min/Max, Negativpreis-Schutz Status
- **Netzleistung**: 3-Phasen Anzeige (L1/L2/L3), Total mit Richtungsanzeige und Flow-Animation
- **Victron Zusatzwerte**: SOC, Akku-Leistung, PV (DC), PV Gesamt (DC+AC), Grid Setpoint, Min SOC
- **Kosten (heute, live)**: Import/Export kWh, Kosten/Erlös EUR, Netto
- **Day-Ahead Preise Chart**: Balkendiagramm mit Zeitachse, Null-Linie, aktuelle-Stunde Markierung
- **Steuerung**: Aktive Werte, letzter Write, manuelle Writes, Default-Werte, Zeitplan-Editor
- **Letzte Events**: Log der letzten 20 Ereignisse

### Tools

Tools: `http://<host>:8080/tools.html`
- Register Scan (Modbus Register Discovery)
- Schedule JSON editieren

### API Endpoints

| Methode | Pfad | Beschreibung |
|---------|------|--------------|
| `GET` | `/dv/control-value` | DV Status: `0` = Abregelung, `1` = Einspeisung erlaubt |
| `GET` | `/api/status` | Vollständiger Systemstatus (alle Karten-Daten) |
| `GET` | `/api/costs` | Tages-Kostenübersicht (Import/Export/Kosten/Erlös) |
| `GET` | `/api/log` | Letzte 300 Event-Log Einträge |
| `POST` | `/api/epex/refresh` | EPEX-Preise manuell aktualisieren |
| `GET` | `/api/meter/scan` | Scan-Ergebnisse abrufen |
| `POST` | `/api/meter/scan` | Modbus Register-Scan starten |
| `GET` | `/api/schedule` | Aktuelle Schedule-Regeln und Config |
| `POST` | `/api/schedule/rules` | Schedule-Regeln aktualisieren |
| `POST` | `/api/schedule/config` | Default-Werte aktualisieren (gridSetpointW, chargeCurrentA) |
| `POST` | `/api/control/write` | Manueller Write (target: gridSetpointW/chargeCurrentA/minSocPct) |
| `GET` | `/api/integration/home-assistant` | Home Assistant kompatibles JSON |
| `GET` | `/api/integration/loxone` | Loxone kompatibles Text-Format |
| `GET` | `/api/integration/eos` | EOS (Akkudoktor) Messwerte + EPEX-Preise |
| `POST` | `/api/integration/eos/apply` | EOS Optimierung anwenden (gridSetpointW, chargeCurrentA, minSocPct) |
| `GET` | `/api/integration/emhass` | EMHASS Messwerte + Preisarrays |
| `POST` | `/api/integration/emhass/apply` | EMHASS Optimierung anwenden (gridSetpointW, chargeCurrentA, minSocPct) |
| `GET` | `/api/keepalive/modbus` | Letzte Modbus-Abfrage Info |
| `GET` | `/api/keepalive/pulse` | 60s Uptime-Pulse |

### Konfiguration

Die Konfiguration erfolgt über `config.json`. Wichtige Sektionen:

| Sektion | Beschreibung |
|---------|--------------|
| `victron` | Victron GX Verbindung (host, port, unitId, transport, mqtt) |
| `meter` | Grid-Meter Register (Default addr 820, 3 Phasen) |
| `points` | Victron Datenpunkte zum Lesen (SOC, Batterie, PV, etc.) |
| `controlWrite` | Schreibbare Register (gridSetpointW, chargeCurrentA, minSocPct) |
| `dvControl` | DV-Steuerung des Victron (feedExcessDcPv, dontFeedExcessAcPv, negativePriceProtection) |
| `schedule` | Zeitplan-Regeln und Defaults |
| `epex` | EPEX-Preiszone und Timezone |
| `influx` | InfluxDB Anbindung (optional) |
| `scan` | Modbus Register-Scan Parameter |

### Hinweise

- Für Schreibregister kann `controlWrite.<target>.writeType` auf `int16`, `uint16`, `int32` oder `uint32` gesetzt werden.
- ESS Mode 2/3 Empfehlung: Grid-Setpoint über `unitId 100`, `address 2700`, `fc 16`, `writeType int16` schreiben (nicht auf `address 0`) -> Nicht auf Register 2716/2717 - sind only on memory und nicht persistent wie 2700.
- Legacy-Fallback für Grid-Setpoint bleibt möglich: `fc 6`, `address 2700`, `writeType int16`.
- **InfluxDB v3** (Default): `influx.apiVersion: "v3"`, `influx.url: "http://host:8086"`, `influx.db: "datenbankname"`, `influx.token: "bearer-token"`. Für v2: `apiVersion: "v2"` setzen und `org`/`bucket` statt `db` verwenden.
- DV-Victron-Steuerung (`dvControl`) ist per Default deaktiviert (`enabled: false`). In `config.json` auf `true` setzen um die automatische Ansteuerung bei DV-Signal und negativen Preisen zu aktivieren.
- Kosten-Daten werden in `energy_state.json` gespeichert und überleben Neustarts (solange der Tag gleich bleibt).
- Alle Victron-Register (points, controlWrite, dvControl) erben automatisch `host`, `port`, `unitId` und `timeoutMs` von der `victron`-Sektion, können aber pro Register überschrieben werden.
- **EOS-Anbindung (Akkudoktor)**: Messwerte via `GET /api/integration/eos` abrufen und an EOS weiterleiten (`PUT /v1/measurement/data`). Optimierungsergebnisse via `POST /api/integration/eos/apply` zurückschreiben. Enthält EPEX-Preise, SOC, PV, Grid und Batterie-Werte.
- **EMHASS-Anbindung**: Messwerte + Preisarrays via `GET /api/integration/emhass` abrufen. `load_cost_forecast` und `prod_price_forecast` können direkt an EMHASS übergeben werden. Ergebnisse via `POST /api/integration/emhass/apply` anwenden.
- **MQTT-Modus**: In `config.json` unter `victron.transport` auf `"mqtt"` setzen und `victron.mqtt.portalId` mit der VRM Portal ID befüllen (zu finden auf dem GX-Gerät unter Settings -> VRM Online Portal). Der DV-Modbus-Server (Port 1502) läuft unabhängig vom Transport immer über Modbus.
- **MQTT-Paket installieren**: `npm install mqtt` -- wird nur benötigt wenn `transport: "mqtt"` konfiguriert ist. Bei Modbus-Betrieb (Default) ist keine Installation nötig.

---

## License

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
