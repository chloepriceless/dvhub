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
| **Status** | WIP -- Version 0.1 by agentic engineering.|
| **Getestet mit** | LUOX Energy, Victron Ekrano-GX, Fronius AC-PV |
| **Lizenz** | Energy Community License (ECL-1.0) |

<p align="center">
  <img src="docs/dashboard-desktop.png" alt="PlexLite Dashboard — Desktop" width="900" />
</p>

---

## Ueberblick

PlexLite ersetzt bzw. ergaenzt einen physischen Plexlog als DV-Schnittstelle.
Alle Modbus-Anfragen von LUOX wurden per Paketmitschnitt am physischen Plexlog abgefangen
und in Software nachgebaut -- damit koennen **alle Victron-Anlagen** in die Direktvermarktung integriert werden.

**Warum nicht direkt ueber den Plexlog?**
Der Plexlog kann Live-Werte liefern (z.B. ueber einen Victron VM3P75CT Zaehler via ModbusTCP),
aber die Leistungsreduzierung scheint nur ueber die physischen Modbus-Ports zu funktionieren --
eine Steuerung der Victron-Anlage war bisher nicht moeglich.
PlexLite liest die Daten direkt vom Ekrano-GX und beantwortet die Modbus-Anfragen des Direktvermarkters.

---

## Hintergrund: Direktvermarktung und Pauschaloption

### Was ist eine DV-Schnittstelle?

Eine DV-Schnittstelle verbindet den Direktvermarkter mit deiner Anlage, um:
- **Live-Werte** abzufragen (Erzeugung, Einspeisung, SOC, etc.)
- **Steuersignale** zu empfangen (Abregelung bei negativen Boersenpreisen)

So kann der Direktvermarkter bei negativen Strompreisen eine Abregelung ausloesen
und vermeidet Kosten fuer eingespeisten Strom unter Marktwert.

### Wer benoetigt eine DV-Schnittstelle?

Laut dem **Solarspitzengesetz** (auch "Stromspitzengesetz", in Kraft seit 25.02.2025):
- Alle PV-Anlagen **ab 25 kWp** benoetigen eine DV-Schnittstelle fuer die Direktvermarktung
- Kleinere Anlagen koennen freiwillig teilnehmen

### Warum Direktvermarktung unter 30 kWp?

Bisher lohnte sich die Direktvermarktung fuer kleine Anlagen kaum -- man brauchte 60-100 kWh Speicher
fuer nennenswerte Mehrerloese. Mit der kommenden **Pauschaloption** aendert sich das grundlegend:
Ab ca. 40 kWh Speicher wird die Teilnahme attraktiv, weil Speicher nun flexibel aus PV *und* Netz
geladen werden duerfen.

### Die Pauschaloption (MiSpeL)

Die Bundesnetzagentur erarbeitet im Festlegungsverfahren **MiSpeL** (Marktintegration von Speichern
und Ladepunkten, Az. 618-25-02) die Umsetzung der Pauschaloption:

**Kernpunkte:**
- **500 kWh pro kWp** pauschal gefoerderte Einspeisung pro Jahr (Differenz Marktwert zu Anzulegendem Wert wird verguetet)
- Alles darueber wird als "Graustrom" abgerechnet (Boersenwert, keine EEG-Foerderung)
- **Mischstromspeicher erlaubt** -- PV und Netzstrom im selben Speicher ohne Subventionsbetrug
- **Bidirektionales Laden** mit E-Autos ohne weiteres moeglich
- Nur **ein Smart Meter** (Moderne Messeinrichtung + Gateway) noetig -- keine komplizierten Zaehlkonzepte
- Max. **30 kWp** installierte Modulleistung (Steckersolargeraete zaehlen nicht)
- Voraussetzung: **gefoerderte Direktvermarktung** (nicht Einspeiseverguetung)

**Status (Maerz 2026):**
- BNetzA Festlegung muss bis **30. Juni 2026** finalisiert werden
- **EU-beihilferechtliche Genehmigung** steht noch aus
- Konsultationsphase abgeschlossen (Oktober 2025)

**Offizielle Links:**
- [BNetzA MiSpeL Festlegungsverfahren](https://www.bundesnetzagentur.de/DE/Fachthemen/ElektrizitaetundGas/ErneuerbareEnergien/EEG_Aufsicht/MiSpeL/start.html)
- [BNetzA MiSpeL Artikel/Uebersicht](https://www.bundesnetzagentur.de/DE/Fachthemen/ElektrizitaetundGas/ErneuerbareEnergien/EEG_Aufsicht/MiSpeL/artikel.html)
- [BNetzA Pressemitteilung (19.09.2025)](https://www.bundesnetzagentur.de/SharedDocs/Pressemitteilungen/DE/2025/20250919_MiSpeL.html)
- [Anlage 2: Pauschaloption Eckpunkte (PDF)](https://www.bundesnetzagentur.de/DE/Fachthemen/ElektrizitaetundGas/ErneuerbareEnergien/EEG_Aufsicht/MiSpeL/DL/Anlage2.pdf)
- [BMWK FAQ Solarspitzengesetz](https://www.bundeswirtschaftsministerium.de/Redaktion/DE/Dossier/ErneuerbareEnergien/faq-zur-energierechtsnovelle-zur-vermeidung-von-stromspitzen-und-zum-biomassepaket.html)

---

## Einrichtung: LUOX Energy Anbindung

### Was muss eingerichtet werden?

1. **LUOX mitteilen** dass ein PLEXLOG als DV-Schnittstelle verbaut ist
2. **OpenVPN-Tunnel** zu LUOX einrichten (Config + Zertifikat erhaelt man von LUOX)
3. **Portforwarding** in der Firewall: Port 502 (Modbus TCP) vom VPN-Tunnel auf Port 1502 (PlexLite) weiterleiten

### Unifi-Spezialfall

Unifi kann das Portforwarding vom VPN-Tunnel zum Modbus-Endpunkt nicht ueber die GUI konfigurieren.
Die noetige iptables-Regel muss per CLI gesetzt werden -- und ueberlebt ggf. keinen Reboot.

In der Datei `20-dv-modbus.sh` ist ein Reboot-Script das die Regeln semi-persistent macht.
Es kann auch zur Ersteinrichtung genutzt werden sobald der VPN-Tunnel steht.

### Verbindung pruefen

Die [LUOX Testseite](https://www.luox-energy.de/verbindungsstatus) sollte gruen anzeigen sobald:
- VPN-Tunnel aufgebaut ist
- Portweiterleitung funktioniert
- PlexLite auf Port 1502 laeuft und antwortet

---

## DV Control Webapp

Webapp + Modbus-Proxy als Ersatz/Ergaenzung zum Node-RED-Flow.

### Getestet auf
- Debian 12 Bookworm LXC Container (Community Scripts)

### Installation

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
  - `GET /api/keepalive/pulse`: 60s-Pulse fuer Uptime-Kuma/Monitoring

- Meter + Victron Polling
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
  - Zusaetzlich werden die Victron DC/AC-PV Register gesperrt (Eigenverbrauch)
  - Wird automatisch aufgehoben wenn Preis wieder positiv
  - Status im Dashboard sichtbar

- Schedule / Steuerung
  - Zeitplanregeln fuer:
    - `gridSetpointW` (Grid Setpoint in Watt)
    - `chargeCurrentA` (Ladestrom in Ampere)
  - Default-Werte wenn keine Regel greift
  - Manuelle Writes per API fuer: `gridSetpointW`, `chargeCurrentA`, `minSocPct`
  - Persistierung der Schedule-Regeln in `config.json`

- Day-Ahead Preise (EPEX)
  - Quelle: energy-charts.info API
  - Preiszone: DE-LU (konfigurierbar)
  - Heute + Folgetag Preise
  - Balkendiagramm im Dashboard (negative Preise rot, positive blau)
  - Interaktiver Hover-Tooltip mit Preis und Zeitstempel
  - Erkennung zukuenftiger Negativpreise (heute + morgen)
  - Morgen Min/Max Preis Anzeige
  - Automatischer Refresh alle 5 Minuten

- Kosten-Tracking (heute, live)
  - Tagesbasiertes Import/Export Tracking in kWh
  - Kosten und Erloese basierend auf aktuellem EPEX-Preis
  - Netto-Berechnung (Erloes - Kosten)
  - Persistente Speicherung in `energy_state.json` (ueberlebt Neustarts)
  - Speicherung alle 60 Sekunden + bei Shutdown + bei Tageswechsel
  - Tagesabschluss-Log mit Zusammenfassung

- InfluxDB (optional)
  - Schreiben von Livewerten als Line Protocol
  - Measurements: meter, ctrl, victron, energy
  - Flush-Intervall: 10 Sekunden
  - Aktivierung via `influx.enabled=true` in config

- Integrationen
  - Home Assistant: `GET /api/integration/home-assistant` (JSON)
  - Loxone: `GET /api/integration/loxone` (Text Key=Value)

### Dashboard

Dashboard: `http://<host>:8080/`

<p align="center">
  <img src="docs/dashboard-mobile.png" alt="PlexLite Dashboard — iPhone" width="320" />
  <br/><em>Mobile-Ansicht (iPhone 17 Pro)</em>
</p>

Karten-Uebersicht:
- **DV Schaltstatus**: EIN/AUS, Control Value, Lease-Ablauf, letzte Modbus-Abfrage, DC-PV Einspeisung, AC-PV Blockierung
- **Boersenpreis**: Aktueller Preis, naechster Slot, Negativpreis-Warnung (heute/morgen), Morgen Min/Max, Negativpreis-Schutz Status
- **Netzleistung**: 3-Phasen Anzeige (L1/L2/L3), Total mit Richtungsanzeige und Flow-Animation
- **Victron Zusatzwerte**: SOC, Akku-Leistung, PV (DC), PV Gesamt (DC+AC), Grid Setpoint, Min SOC
- **Kosten (heute, live)**: Import/Export kWh, Kosten/Erloes EUR, Netto
- **Day-Ahead Preise Chart**: Balkendiagramm mit Zeitachse, Null-Linie, aktuelle-Stunde Markierung
- **Steuerung**: Aktive Werte, letzter Write, manuelle Writes, Default-Werte, Zeitplan-Editor
- **Letzte Events**: Log der letzten 20 Ereignisse

### Tools

Tools: `http://<host>:8080/tools.html`
- Register Scan (Modbus Register Discovery)
- Schedule JSON editieren
- Override setzen/loeschen

### API Endpoints

| Methode | Pfad | Beschreibung |
|---------|------|--------------|
| `GET` | `/dv/control-value` | DV Status: `0` = Abregelung, `1` = Einspeisung erlaubt |
| `GET` | `/api/status` | Vollstaendiger Systemstatus (alle Karten-Daten) |
| `GET` | `/api/costs` | Tages-Kostenuebersicht (Import/Export/Kosten/Erloes) |
| `GET` | `/api/log` | Letzte 300 Event-Log Eintraege |
| `POST` | `/api/epex/refresh` | EPEX-Preise manuell aktualisieren |
| `GET` | `/api/meter/scan` | Scan-Ergebnisse abrufen |
| `POST` | `/api/meter/scan` | Modbus Register-Scan starten |
| `GET` | `/api/schedule` | Aktuelle Schedule-Regeln und Config |
| `POST` | `/api/schedule/rules` | Schedule-Regeln aktualisieren |
| `POST` | `/api/schedule/config` | Default-Werte aktualisieren (gridSetpointW, chargeCurrentA) |
| `POST` | `/api/control/write` | Manueller Write (target: gridSetpointW/chargeCurrentA/minSocPct) |
| `GET` | `/api/integration/home-assistant` | Home Assistant kompatibles JSON |
| `GET` | `/api/integration/loxone` | Loxone kompatibles Text-Format |
| `GET` | `/api/keepalive/modbus` | Letzte Modbus-Abfrage Info |
| `GET` | `/api/keepalive/pulse` | 60s Uptime-Pulse |

### Konfiguration

Die Konfiguration erfolgt ueber `config.json`. Wichtige Sektionen:

| Sektion | Beschreibung |
|---------|--------------|
| `victron` | Victron GX Verbindung (host, port, unitId) |
| `meter` | Grid-Meter Register (Default addr 820, 3 Phasen) |
| `points` | Victron Datenpunkte zum Lesen (SOC, Batterie, PV, etc.) |
| `controlWrite` | Schreibbare Register (gridSetpointW, chargeCurrentA, minSocPct) |
| `dvControl` | DV-Steuerung des Victron (feedExcessDcPv, dontFeedExcessAcPv, negativePriceProtection) |
| `schedule` | Zeitplan-Regeln und Defaults |
| `epex` | EPEX-Preiszone und Timezone |
| `influx` | InfluxDB Anbindung (optional) |
| `scan` | Modbus Register-Scan Parameter |

### Hinweise

- Fuer Schreibregister kann `controlWrite.<target>.writeType` auf `int16`, `uint16`, `int32` oder `uint32` gesetzt werden.
- ESS Mode 2/3 Empfehlung: Grid-Setpoint ueber `unitId 100`, `address 2700`, `fc 16`, `writeType int16` schreiben (nicht auf `address 0`) -> Nicht auf Register 2716/2717 - sind only on memory und nicht persistent wie 2700.
- Legacy-Fallback fuer Grid-Setpoint bleibt moeglich: `fc 6`, `address 2700`, `writeType int16`.
- Influx schreibt nur wenn `influx.enabled=true` und URL/Org/Bucket/Token gesetzt sind.
- DV-Victron-Steuerung (`dvControl`) ist per Default deaktiviert (`enabled: false`). In `config.json` auf `true` setzen um die automatische Ansteuerung bei DV-Signal und negativen Preisen zu aktivieren.
- Kosten-Daten werden in `energy_state.json` gespeichert und ueberleben Neustarts (solange der Tag gleich bleibt).
- Alle Victron-Register (points, controlWrite, dvControl) erben automatisch `host`, `port`, `unitId` und `timeoutMs` von der `victron`-Sektion, koennen aber pro Register ueberschrieben werden.

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
