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
| **Status** | `main` — Version 0.3.5.1 |
| **Getestet mit** | LUOX Energy, Victron Ekrano-GX, Fronius AC-PV |
| **Lizenz** | Energy Community License (ECL-1.0) |

<p align="center">
  <a href="assets/screenshots/dashboard-live-full-2026-03-11.png"><img src="assets/screenshots/dashboard-live-full-2026-03-11.png" alt="DVhub Leitstand live" width="440" /></a>
  <a href="assets/screenshots/history-day-2026-03-10-full.png"><img src="assets/screenshots/history-day-2026-03-10-full.png" alt="DVhub History Tag 10.03.2026" width="440" /></a>
</p>
<p align="center">
  <a href="assets/screenshots/history-month-2026-03-full.png"><img src="assets/screenshots/history-month-2026-03-full.png" alt="DVhub History März 2026" width="440" /></a>
  <a href="assets/screenshots/history-year-2025-full.png"><img src="assets/screenshots/history-year-2025-full.png" alt="DVhub History Jahr 2025" width="440" /></a>
</p>

---

## Was ist DVhub?

DVhub ersetzt bzw. ergänzt einen physischen Plexlog als DV-Schnittstelle. Die Modbus-Kommunikation
des Direktvermarkters wird in Software nachgebildet, während die Live-Daten direkt vom Victron-GX-System kommen.

### Kernfunktionen

- **DV-Modbus-Server** auf Port `1502` mit FC3/FC4 Read und FC6/FC16 Write
- **Victron-Anbindung** per Modbus TCP oder MQTT mit automatischer mDNS-Erkennung
- **Dashboard** mit Live-Werten, Day-Ahead-Preisen, Kostenübersicht und Steuerung
- **Kleine Börsenautomatik** — automatische Entladung in Hochpreisphasen mit energiebasierter Slot-Allokation
- **History-Seite** für Tag/Woche/Monat/Jahr direkt aus lokaler SQLite-Telemetrie
- **Setup-Assistent** für den ersten Start mit blockierender Validierung
- **Einstellungsoberfläche** statt roher `config.json`-Bearbeitung
- **Integrationen** für EOS, EMHASS, Home Assistant, Loxone und InfluxDB
- **Security-Hardening** mit CSP, Timing-Safe Auth, SQL-Injection-Schutz
- **systemd-ready** mit Health-Checks, GUI-Restart und installiertem Service

---

## Schnellstart

```bash
curl -fsSL https://raw.githubusercontent.com/chloepriceless/dvhub/main/install.sh | sudo bash
```

### Branch-Installation

Um einen bestimmten Branch zu installieren, ohne das `main`-Installscript zu ändern:

```bash
BRANCH="codex/small-market-automation"
URL="https://raw.githubusercontent.com/chloepriceless/dvhub/main/install.sh"
curl -fsSL "$URL" | INSTALLER_SOURCE_URL="https://github.com/chloepriceless/dvhub/blob/${BRANCH}/install.sh" bash
```

Das Installscript von `main` wird heruntergeladen, aber `INSTALLER_SOURCE_URL` zeigt auf den gewünschten Branch — so wird dessen Version installiert.

Nach der Installation:

| Seite | URL |
|-------|-----|
| Dashboard | `http://<host>:8080/` |
| Historie | `http://<host>:8080/history.html` |
| Einstellungen | `http://<host>:8080/settings.html` |
| Setup | `http://<host>:8080/setup.html` |
| Tools | `http://<host>:8080/tools.html` |

Wenn die Config-Datei noch fehlt, öffnet DVhub automatisch den Setup-Assistenten.

---

## Dokumentation

Die ausführliche Dokumentation liegt im [Wiki](docs/wiki/):

| Seite | Inhalt |
|-------|--------|
| [Architektur](docs/wiki/architektur.md) | Prozessmodell, Datenfluss, alle 14 Module, Frontend, Projektstruktur |
| [Installation](docs/wiki/installation.md) | Manuelle Installation, systemd, GUI-Restart, manueller Start |
| [API-Referenz](docs/wiki/api-referenz.md) | 30+ REST-Endpunkte, Config-Sektionen, Preislogik, Hinweise |
| [Oberflächen](docs/wiki/oberflaechen.md) | Dashboard, Einstellungen, Setup, Tools, Historie |
| [Direktvermarktung](docs/wiki/direktvermarktung.md) | DV-Hintergrund, MiSpeL-Status, LUOX-Anbindung |
| [Changelog](docs/wiki/changelog.md) | Versionshistorie mit allen Änderungen |

---

## Integrationen

DVhub stellt Daten bereit oder nimmt Optimierungsergebnisse entgegen für:

- **Home Assistant** / **Loxone** — Live-Werte als JSON oder Textformat
- **EOS (Akkudoktor)** / **EMHASS** — Messwerte + EPEX-Preise, Optimierung anwenden
- **InfluxDB v2/v3** — periodischer Messwert-Export
- **VRM** — historische Telemetrie nachimportieren
- **Energy Charts** — fehlende Börsenpreise und Solar-Marktwerte nachfüllen

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
