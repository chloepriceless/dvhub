# DVhub HTTP-API — alle Endpunkte

Vollständige Liste der HTTP-Endpunkte von DVhub (Stand: Version 1.0.6 + Unreleased, September 2026), gruppiert nach Bereich.
Quelle ist der Router `dvhub/routes-api.js`. Die interaktive Swagger-Oberfläche unter `/api-docs.html` (`/openapi.json`) beschreibt nur einen Teil davon (≈ 35 Kern-Endpunkte) und zeigt dafür Beispiel-Antworten.

- [1. Grundlagen](#1-grundlagen)
- [2. Zugang: Legende](#2-zugang-legende)
- [3. Endpunkte](#3-endpunkte)
  - [Betrieb & Seiten](#31-betrieb--seiten) · [Status & DV](#32-status--dv) · [Konfiguration](#33-konfiguration) · [Admin & System](#34-admin--system) · [Support](#35-support)
  - [Datenbank](#36-datenbank) · [Historie & Telemetrie](#37-historie--telemetrie) · [EPEX / Preise](#38-epex--preise)
  - [Prognose](#39-prognose) · [ML](#310-ml) · [Optimizer & EOS](#311-optimizer--eos) · [Zeitplan & Steuerung](#312-zeitplan--steuerung)
  - [E-Auto](#313-e-auto) · [Integrationen (Datenausgabe)](#314-integrationen-datenausgabe) · [Integrationen (Einstellungen)](#315-integrationen-einstellungen)
  - [Messwert-Eingang HA / Loxone](#316-messwert-eingang-home-assistant--loxone) · [Datenspende](#317-datenspende) · [Benachrichtigungen & Monitoring](#318-benachrichtigungen--monitoring)
  - [Geräte, PV-Strings, Zähler](#319-geräte-pv-strings-zähler) · [Familien-Dashboard](#320-familien-dashboard-dvhub-pro) · [VPN](#321-vpn-dvhub-pro) · [Lizenz](#322-lizenz) · [Installateurs-Portal](#323-installateurs-portal)

---

## 1. Grundlagen

| Thema | Regel |
|---|---|
| Basis-URL | `http://<dvhub>/` (Installer: Port 80, HTTPS 443 mit selbstsigniertem Zertifikat; Code-Default `httpPort` 8080) |
| Format | JSON (`Content-Type: application/json`), wenn nicht anders angegeben. Ausnahmen: `/dv/control-value`, `/api/integration/loxone`, `/api/metrics` (Text), Exporte (CSV/Parquet/Datei) |
| Token | `Authorization: Bearer <apiToken>` — der `apiToken` steht in `/etc/dvhub/config.json` (Installer erzeugt ihn). **`?token=` in der URL wird abgewiesen**, einzige Ausnahme `/api/config/export` (Datei-Download) |
| Ohne Token | hängt von **Einstellungen → Sicherheit → LAN-Vertrauen** (`security.lanTrust`) ab: `open` (Standard) = jedes Gerät im Heimnetz darf alles; `restricted` = im Heimnetz nur die LAN-sicheren GET-Endpunkte der freigegebenen Gruppen (`security.lanSafeGroups`), alles andere mit Token; `strict` = nur die Box selbst (127.0.0.1) ohne Token. Aufrufe von außerhalb des Heimnetzes brauchen immer ein Token |
| Rate-Limit | `/api/*`, `/dv/*` und `/eosdash/*`: 120 Anfragen/min je IP von außen, 600/min aus dem Heimnetz → `429`. `/healthz` und `/health` sind nicht begrenzt |
| Pro | Mit *Pro* markierte Endpunkte antworten ohne aktive DVhub-Pro-Lizenz mit `403` |
| Nonce | Einige Einstellungs-Aktionen verlangen zusätzlich zum LAN-Zugang einen Einmal-Wert `uiToken` im Body (Schutz gegen Cross-Site-Anfragen). Man bekommt ihn aus dem zugehörigen `GET …/status`. Ein gültiges Bearer-Token ersetzt ihn |
| Config speichern | `POST /api/config` ersetzt die **gesamte** Config. Einzelne Bereiche über die spezialisierten Endpunkte ändern (sie mergen serverseitig) |
| Fehler | `{ "ok": false, "error": "<code>", … }` mit passendem HTTP-Status (400 Eingabe, 401 Token, 403 Pro/Nonce, 404, 409 Zustand, 429, 503 Dienst nicht verfügbar) |
| Container | Im Docker-Image (`DVHUB_RUNTIME=container`) antworten Update, System-Updates, Neustart, Reboot, Update-Kanal und TimescaleDB-Upgrade mit `409`, `code: "container_runtime"` — dort wird das Image getauscht. `POST /api/db/restore` ist im Container ohne Service-Actions erlaubt (Token bleibt Pflicht) |

## 2. Zugang: Legende

Spalte **Zugang** in den Tabellen:

| Kürzel | Bedeutung |
|---|---|
| **frei** | ohne Anmeldung, auch von außen |
| **LAN·`gruppe`** | LAN-sicherer Lese-Endpunkt: im Heimnetz ohne Token bei `open`, und bei `restricted`, wenn die Gruppe (`status`, `dashboard`, `history`, `forecast`, `integrations`) freigegeben ist |
| **Token** | im Heimnetz ohne Token nur bei `lanTrust=open`, sonst Bearer-Token |
| **Token+Nonce** | wie *Token*, zusätzlich `uiToken` im Body (oder Bearer) |
| **Push-Key** | eigener Header `X-DVhub-Push-Key` (oder Bearer) — **nie** LAN-Freibrief |
| **Portal** | Installateurs-Portal: signierte Anfrage bzw. Portal-Session-Token |
| **Setup** | nur während des Ersteinrichtungs-Fensters aus dem Heimnetz |

---

## 3. Endpunkte

### 3.1 Betrieb & Seiten

| Methode | Pfad | Zugang | Beschreibung |
|---|---|---|---|
| GET | `/healthz` | frei | Liveness-Probe (Uptime-Kuma, Container) — keine Daten |
| GET | `/health` | frei | Health-Übersicht |
| GET | `/` | frei | Leitstand bzw. Onboarding-Assistent bei fehlender Config |
| GET | `/integrations` | frei | Seite Integrationen |
| GET | `/family`, `/family.html` | frei, *Pro* | Familien-Dashboard (Seite) |
| GET | `/api-docs.html`, `/api-docs`, `/openapi.json` | Token | Swagger-Oberfläche / OpenAPI-Spezifikation |
| GET | `/api/setup/state` | Setup | Stand der Ersteinrichtung |
| POST | `/api/setup/complete` | Setup | Ersteinrichtung abschließen |
| * | `/eosdash/…` | Token | Proxy auf die EOSdash-Oberfläche (127.0.0.1:8504) |

### 3.2 Status & DV

| Methode | Pfad | Zugang | Beschreibung |
|---|---|---|---|
| GET | `/dv/control-value` | LAN·status, *Pro* | DV-Signal als Text: `0` = Abregelung, `1` = Einspeisung erlaubt |
| GET | `/api/status` | LAN·status | Vollständiger Live-Status (Netz, PV, Batterie, SoC, DV, Preise, Zeitplan, Kosten, Alarme) |
| GET | `/api/costs` | LAN·status | Tageskosten/-erlöse |
| GET | `/api/metrics` | LAN·status | Prometheus-Metriken (Text) |
| GET | `/api/keepalive/modbus`, `/api/keepalive/pulse` | LAN·status | Keepalive-Zustand (Modbus, Puls) |
| GET | `/api/log` | Token | Ereignis-Log (`?limit=`) |
| POST | `/api/log` | Token | Frontend-Fehler melden (Browser-`onerror`) |
| GET | `/api/log/dv-signals` | LAN·integrations | Persistentes DV-Signal-Log aus der Datenbank |
| GET | `/api/discovery/systems` | LAN·status | Anlagen im Netz suchen (Victron-Discovery) |

### 3.3 Konfiguration

| Methode | Pfad | Zugang | Beschreibung |
|---|---|---|---|
| GET | `/api/config` | LAN·status | Config lesen (Geheimnisse geschwärzt) |
| POST | `/api/config` | Token | Config **komplett** ersetzen (unbekannte Top-Level-Schlüssel werden abgewiesen) |
| POST | `/api/config/import` | Token | Config aus JSON importieren |
| GET | `/api/config/export` | LAN·status | Config als Datei (auch `?token=`) |
| POST | `/api/config/export` | Token | Export inkl. verschlüsseltem Geheimnis-Bündel |

### 3.4 Admin & System

| Methode | Pfad | Zugang | Beschreibung |
|---|---|---|---|
| GET | `/api/admin/health` | Token | Health-Check-Details |
| POST | `/api/admin/service/restart` | Token | DVhub-Dienst neu starten |
| GET | `/api/admin/system/info` | Token | Systeminfo (OS, RAM, Laufzeit) |
| POST | `/api/admin/system/reboot` | Token | Rechner neu starten |
| GET | `/api/admin/system/updates/check` | Token | Betriebssystem-Updates prüfen |
| POST | `/api/admin/system/updates/apply` | Token | Betriebssystem-Updates einspielen |
| GET | `/api/admin/update/check` | Token | DVhub-Update prüfen |
| POST | `/api/admin/update/apply` | Token | DVhub-Update einspielen |
| POST | `/api/admin/update/channel` | Token | Update-Kanal setzen (`stable`/`dev`) |
| POST | `/api/admin/token/rotate` | Token | API-Token neu erzeugen |
| POST | `/api/admin/token/revoke` | Token | API-Token widerrufen |

### 3.5 Support

| Methode | Pfad | Zugang | Beschreibung |
|---|---|---|---|
| GET | `/api/support/bundle` | Token | Diagnose-Bundle (Config geschwärzt, Logs) als JSON |
| GET | `/api/support/tunnel/status` | Token | Fern-Support-Tunnel: Zustand, liefert `uiToken` |
| POST | `/api/support/tunnel/open` | Token+Nonce | Zeitbegrenzten Support-Tunnel öffnen |
| POST | `/api/support/tunnel/close` | Token | Tunnel sofort schließen |

### 3.6 Datenbank

| Methode | Pfad | Zugang | Beschreibung |
|---|---|---|---|
| GET | `/api/db/backup` | LAN·history | DB-Backup herunterladen (`pg_dump`, gestreamt) |
| GET | `/api/db/backup/status` | LAN·history | Geplantes Backup: letzter Lauf, Ziel, Aufbewahrung |
| POST | `/api/db/backup/run` | Token | Geplantes Backup jetzt ausführen |
| POST | `/api/db/restore` | Token | Backup-Datei einspielen (`pg_restore`) |
| GET | `/api/db/timescale/status` | LAN·history | TimescaleDB-Versionen, Update ausstehend? |
| POST | `/api/db/timescale/upgrade` | Token | TimescaleDB-Erweiterung aktualisieren (startet PostgreSQL neu) |

### 3.7 Historie & Telemetrie

| Methode | Pfad | Zugang | Beschreibung |
|---|---|---|---|
| GET | `/api/history/summary` | LAN·history, *Pro* für Woche/Monat/Jahr | Zusammenfassung (`?view=day&date=YYYY-MM-DD`) |
| GET | `/api/history/export` | Token, *Pro* für Mehrperioden | Aggregierter Export |
| GET | `/api/history/viz/<karte>` | LAN·history, *Pro* für Mehrperioden | Analyse-Karten: `sankey`, `heatmap`, `ledger`, `day-profile`, `stack`, `autarky-calendar`, `ring`, `duration`, `pheat`, `neg-price`, `spaghetti`, `cycles`, `top10`, `cal-year`, `scatter`, `inverter-efficiency` (`?view=&date=&granularity=`) |
| GET | `/api/history/raw` | LAN·history | Telemetrie-Rohdaten (`sources`, `signals`, `from`, `to`, `limit`, `cursor`) |
| GET | `/api/history/raw/export.csv`, `/api/history/raw/export.parquet` | LAN·history | Rohdaten-Export (gestreamt) |
| POST | `/api/history/import` | Token | Historische Telemetrie importieren |
| GET | `/api/history/import/status` | LAN·history | Stand des Imports |
| POST | `/api/history/backfill/vrm` | Token | Lücken aus Victron VRM nachladen |
| POST | `/api/history/backfill/prices` | Token | Preis-Lücken nachladen |
| GET | `/api/telemetry/series` | LAN·history | Zeitreihen (`?keys=…&start=…`) |
| GET | `/api/eeg/extension` | LAN·history | §51-EEG-Förderzeitraum-Verlängerung |
| GET | `/api/curtailment/preview` | LAN·history | Geschätzte abgeregelte Energie für einen Zeitraum |
| POST | `/api/curtailment/recalibrate` | Token | Abregelungs-Kalibrierung neu rechnen |
| POST | `/api/admin/backfill` | Token | pvnode-Historie (6 Monate) nachladen |
| GET | `/api/admin/backfill/status` | Token | Fortschritt davon |
| POST | `/api/admin/accuracy-backfill` | Token | Prognose-Genauigkeit rückwirkend auswerten |

### 3.8 EPEX / Preise

| Methode | Pfad | Zugang | Beschreibung |
|---|---|---|---|
| POST | `/api/epex/refresh` | Token | Day-Ahead-Preise neu laden |
| GET | `/api/epex/zones` | LAN·integrations | Preiszonen mit Abdeckung (dvhub.online) |
| GET | `/api/epex/gaps` | LAN·integrations | Fehlende Preisdaten (`?zone=DE-LU`) |
| POST | `/api/epex/backfill` | Token | Fehlende Preise nachladen |

### 3.9 Prognose

| Methode | Pfad | Zugang | Beschreibung |
|---|---|---|---|
| GET | `/api/forecast` | LAN·forecast | Kombinierte Prognose: PV, Last, Preis, Sicherheit |
| POST | `/api/forecast/refresh` | Token | Prognose neu rechnen |
| GET | `/api/forecast/nowcast-track` | LAN·forecast | pvnode-Nowcast vs. Day-Ahead vs. Ist |
| GET | `/api/forecast/ghi-coverage` | LAN·forecast | Abdeckung gemessener Einstrahlung |
| POST | `/api/forecast/ghi-backfill` | Token | Einstrahlung nachladen |
| GET | `/api/forecast/inspector/pv-providers` | LAN·forecast | Inspector: PV-Provider im Vergleich |
| GET | `/api/forecast/inspector/load` | LAN·forecast | Inspector: Lastprognose |
| GET | `/api/forecast/inspector/optimizer-cold` | LAN·forecast | Inspector: Optimizer-Eingänge |
| GET | `/api/forecast/inspector/ml-correction` | LAN·forecast, *Pro* | Inspector: ML-Korrektur |
| GET | `/api/forecast/inspector/eos` | LAN·forecast, *Pro* | Inspector: EOS-Ausgabe |
| GET / POST | `/api/forecast/providers/solcast` | Token | Solcast-Zugang lesen (Schlüssel geschwärzt) / setzen |
| POST | `/api/forecast/providers/solcast/probe` | Token | Solcast-Zugang testen |
| GET / POST | `/api/forecast/providers/pvnode` | Token | pvnode-Zugang lesen / setzen |
| POST | `/api/forecast/providers/pvnode/probe` | Token | pvnode-Zugang testen |
| GET | `/api/forecast/pvnode/quota` | Token | pvnode-Kontingent |
| POST | `/api/forecast/providers/eos-akkudoktor/probe` | Token | PV-Prognose der EOS-Instanz testen |

### 3.10 ML

| Methode | Pfad | Zugang | Beschreibung |
|---|---|---|---|
| GET | `/api/ml/status` | Token | Modellstand, Lastprognose-Quelle |
| GET | `/api/ml/accuracy` | Token | Genauigkeitsverlauf |
| POST | `/api/ml/retrain` | Token | Training starten → Job-ID |
| GET | `/api/ml/retrain/status/<jobId>` | Token | Stand eines Trainings |

### 3.11 Optimizer & EOS

| Methode | Pfad | Zugang | Beschreibung |
|---|---|---|---|
| GET | `/api/optimizer/status` | LAN·status | Optimizer-Zustand |
| GET | `/api/optimizer/runs/latest` | Token | Letzter Lauf mit Kurven (Leitstand-Chart) |
| GET | `/api/integration/eos` | LAN·integrations | Messwerte + Preise für EOS |
| POST | `/api/integration/eos/apply` | Token | EOS-Ergebnis übernehmen |
| POST | `/api/eos/sync-from-dvhub` | Token | EOS-Einstellungen aus DVhub übernehmen (Batterie, Standort, …) |
| GET / POST | `/api/integrations/dveos` | Token | Verbindung zur EOS-Instanz lesen / setzen |
| GET | `/api/eos/status` | LAN·status | Zentraler EOS-Zustand: `status` (`up` / `busy` = rechnet gerade / `down` / `disabled` / `unknown`), `pid`, `version`, `lastOkAt`, `lastError`, Neustarts, Zeit des letzten Plans. Momentaufnahme, fragt EOS nicht selbst |
| GET | `/api/integration/emhass` | LAN·integrations | Messwerte + Preisreihen für EMHASS |
| POST | `/api/integration/emhass/apply` | Token | EMHASS-Ergebnis übernehmen |

### 3.12 Zeitplan & Steuerung

| Methode | Pfad | Zugang | Beschreibung |
|---|---|---|---|
| GET | `/api/schedule` | LAN·integrations | Zeitplan, Regeln, aktive Werte |
| POST | `/api/schedule/rules` | Token | Regeln setzen |
| POST | `/api/schedule/rules/toggle` | Token | Regeln per ID ein-/ausschalten |
| POST | `/api/schedule/config` | Token | Standardwerte setzen |
| GET | `/api/schedule/automation/config` | LAN·integrations | Kleine Börsenautomatik lesen |
| POST | `/api/schedule/automation/config` | Token | Kleine Börsenautomatik setzen |
| POST | `/api/schedule/automation/replan` | Token | Sofort neu planen |
| POST | `/api/control/write` | Token | Manueller Sollwert: `{ target, value, persist?, clear? }`, `target` ∈ `gridSetpointW`, `chargeCurrentA`, `minSocPct`, `maxDischargeW`, `feedExcessDcPv`; `clear: true` hebt den Override auf |
| POST | `/api/control/stop` | Token | **Not-Halt**: alle freiwilligen Schreibvorgänge pausieren (Pflicht-Schutz läuft weiter) |
| POST | `/api/control/resume` | Token | Not-Halt aufheben |

### 3.13 E-Auto

| Methode | Pfad | Zugang | Beschreibung |
|---|---|---|---|
| GET | `/api/ev` | LAN·status | Auto-Planung: Abfahrt, Ziel, Fahrzeugzustand, EOS-Plan bis zur Abfahrt |
| POST | `/api/ev` | Token | Abfahrt/Ziel setzen |
| POST | `/api/ev/override` | Token, *Pro* | „Sofort laden“: `{ powerW, untilMs? \| durationMin? }` — lädt unabhängig vom EOS-Plan |
| DELETE | `/api/ev/override` | Token, *Pro* | „Sofort laden“ beenden |
| GET | `/api/integration/evcc` | LAN·integrations | evcc-Zustand |
| GET | `/api/integration/evcc/eos` | LAN·integrations | EOS → evcc: gültiger Befehl, zuletzt gesendet, Plan |
| POST | `/api/integration/evcc/eos/apply` | Token, *Pro* | Befehl des laufenden Slots sofort erneut an evcc senden |
| GET / POST | `/api/integrations/evcc` | Token | evcc-Anbindung lesen / setzen |

### 3.14 Integrationen (Datenausgabe)

| Methode | Pfad | Zugang | Beschreibung |
|---|---|---|---|
| GET | `/api/integration/home-assistant` | LAN·integrations | Werte als JSON für Home Assistant |
| GET | `/api/integration/loxone` | LAN·integrations | Werte als Text `name=wert` für Loxone ([Anleitung](LOXONE.md)) |
| GET | `/api/integrations/status` | Token | Übersicht aller Integrationen |
| GET | `/api/integrations/health` | LAN·integrations | Telemetrie je System, letzte Werte |
| GET | `/api/integrations/mqtt/topics` | LAN·integrations | MQTT-Inspector: gesehene Topics |
| GET | `/api/integrations/mqtt/status` | LAN·integrations | MQTT-Hub: Verbindungszustand, Ereignisse |
| POST | `/api/integrations/mqtt/action` | Token | MQTT-Hub `{ action: connect \| disconnect \| reconnect }` |

### 3.15 Integrationen (Einstellungen)

Diese Endpunkte ändern jeweils nur ihren Bereich der Config (serverseitiger Merge; geschwärzte Geheimnisse `***` bleiben erhalten).

| Methode | Pfad | Zugang | Beschreibung |
|---|---|---|---|
| GET / POST | `/api/integrations/victron` | Token | Hersteller-Profil, Anlagenadresse, PV-Kopplung |
| GET / POST | `/api/integrations/homeassistant` | Token | HA-MQTT-Discovery an/aus, Präfix, neu senden |
| GET / POST | `/api/integrations/vrm` | Token | Victron-VRM-Zugang (Nachimport) |
| GET / POST | `/api/integrations/mid` | Token | Modbus-Netzzähler und Vorzeichen-Konvention |
| POST | `/api/family/mqtt-config` | Token | Broker der MQTT-Integration |

### 3.16 Messwert-Eingang Home Assistant / Loxone

Nur aktiv mit dem Hersteller-Profil „Universal (DVhub-MQTT-Schema: HA/Loxone)“. Details: [MQTT-SCHEMA.md §2](MQTT-SCHEMA.md), [LOXONE.md](LOXONE.md).

| Methode | Pfad | Zugang | Beschreibung |
|---|---|---|---|
| GET / POST | `/api/input/push` | Push-Key | Messwerte senden: `grid_w` (Bezug +), `pv_w`, `battery_w` (Laden +), `soc_pct`, `load_w`, je Phase `grid_l1_w`…`grid_l3_w`, `load_l1_w`…`load_l3_w`. GET mit Parametern oder POST mit JSON. Antwort `{ ok, accepted, errors }`; `401` Schlüssel falsch, `409` Profil nicht aktiv, `400` keine gültigen Werte |
| GET | `/api/input/status` | LAN·integrations | Eingänge mit Wert/Alter/veraltet, Broker, Push-URL, Push-Schlüssel gesetzt?, `uiToken` |
| POST | `/api/input/push-key` | Token+Nonce | Neuen Push-Schlüssel erzeugen — wird **einmal** zurückgegeben, der alte wird ungültig |

### 3.17 Datenspende

Spende der Leistungsdaten an die COMSYS-Datenspende (RWTH Aachen).

| Methode | Pfad | Zugang | Beschreibung |
|---|---|---|---|
| GET | `/api/datenspende/status` | LAN·integrations | Verknüpfung, letzter Upload, Nachsenden, Quellen, `uiToken` |
| POST | `/api/datenspende/link` | Token+Nonce | Konto verknüpfen (Anmeldung oder API-Schlüssel) |
| POST | `/api/datenspende/settings` | Token+Nonce | Ein/aus, Intervall, Quellen |
| POST | `/api/datenspende/backfill` | Token+Nonce | Historische Daten nachsenden (`{ action: 'stop' }` bricht ab) |
| POST | `/api/datenspende/unlink` | Token+Nonce | Verknüpfung trennen |

### 3.17a Ortsnetz-Auslastung

Netzspannung + Frequenz an www.ortsnetz-auslastung.de (opt-in, alle 5 min).

| Methode | Pfad | Zugang | Beschreibung |
|---|---|---|---|
| GET | `/api/ortsnetz/status` | LAN·integrations | An/aus, Standort (Quelle), Messquelle, letzte Messung, letzte Bewertung (Ampel, Speicherempfehlung), Fehler, `uiToken` |
| POST | `/api/ortsnetz/settings` | Token+Nonce | `{ enabled?, latitude?, longitude?, sendPvForecast? }` — leere Koordinaten = Prognose-Standort |
| POST | `/api/ortsnetz/send-now` | Token+Nonce | Sofort messen und senden (zum Prüfen) |

### 3.18 Benachrichtigungen & Monitoring

| Methode | Pfad | Zugang | Beschreibung |
|---|---|---|---|
| GET / POST | `/api/integrations/notification-providers` | Token | Alle Benachrichtigungs-Kanäle gemeinsam |
| GET / POST | `/api/notifications/providers/ntfy` | Token | ntfy lesen / setzen |
| POST | `/api/notifications/providers/ntfy/test` | Token | Test-Nachricht |
| GET / POST | `/api/notifications/providers/telegram` | Token | Telegram lesen / setzen |
| POST | `/api/notifications/providers/telegram/test` | Token | Test-Nachricht |
| GET / POST | `/api/notifications/providers/pushover` | Token | Pushover lesen / setzen |
| POST | `/api/notifications/providers/pushover/test` | Token | Test-Nachricht |
| GET / POST | `/api/integrations/uptime-kuma` | Token | Uptime-Kuma-Heartbeat lesen / setzen |
| POST | `/api/integrations/uptime-kuma/test` | Token | Heartbeat testen |

### 3.19 Geräte, PV-Strings, Zähler

| Methode | Pfad | Zugang | Beschreibung |
|---|---|---|---|
| GET | `/api/devices` | LAN·integrations | Geräte (Shelly, MQTT) mit Live-Leistung |
| GET | `/api/devices/<id>` | LAN·integrations | Ein Gerät mit Verlauf (24 h) |
| GET | `/api/devices/schedulable` | Token | Planbare Verbraucher |
| POST | `/api/devices/schedulable` | Token | Planbaren Verbraucher anlegen/ändern (nach `id`) |
| DELETE | `/api/devices/schedulable/<id>` | Token | Planbaren Verbraucher löschen |
| GET / POST | `/api/pv-strings` | Token | PV-Strings / Solar-Logger lesen / setzen |
| GET | `/api/pv-strings/discover`, `/api/pv-strings/discover-fronius` | Token | Strings suchen (allgemein / Fronius) |
| POST | `/api/pv-strings/backfill` | Token | String-Historie nachladen |
| GET | `/api/pv-strings/export.csv` | Token | String-Daten als CSV |
| POST | `/api/meter/scan` | Token | Modbus-Register-Scan starten |
| GET | `/api/meter/scan` | LAN·integrations | Ergebnis des Scans |

### 3.19a EEBUS (§14a-Steuerbox, EEBUS-Geräte)

Siehe [EEBUS.md](EEBUS.md).

| Methode | Pfad | Zugang | Beschreibung |
|---|---|---|---|
| GET | `/api/eebus/status` | Token | Dienst (`status`, eigene `ski`, `shipId`, `port`, `qr`), mDNS-Funde, Kopplungsanfragen, gekoppelte Gegenstellen mit Verbindung und Geräte-Messwerten, §14a-Zustand je LPC/LPP (`state`, `limitW`, `until`, Failsafe-Werte, Heartbeat), umgesetzte Grenzen (`applied`) |
| POST | `/api/eebus/pairing` | Token | `{ on: true\|false }` — Kopplungsanfragen 10 min annehmen |
| POST | `/api/eebus/trust` | Token | `{ ski, name, role: 'grid'\|'device' }` — Gegenstelle vertrauen; höchstens eine Steuerbox (`409 grid_peer_exists`) |
| DELETE | `/api/eebus/trust?ski=…` | Token | Gegenstelle entkoppeln |
| POST | `/api/eebus/device-limit` | Token | `{ ski, w, durationS }` — Leistungsgrenze an ein EEBUS-Gerät von Hand (`w: null` hebt sie auf) |

### 3.20 Familien-Dashboard *(DVhub Pro)*

| Methode | Pfad | Zugang | Beschreibung |
|---|---|---|---|
| GET | `/api/family/status` | LAN·dashboard, *Pro* | Zusammengefasster Status (alle 5 s abgefragt) |
| GET | `/api/family/presence` | LAN·dashboard, *Pro* | Anwesenheit (Bildschirmschoner wecken) |
| POST | `/api/family/presence` | Token, *Pro* | Anwesenheit melden (Webhook aus HA/Loxone) |
| POST | `/api/family/settings` | Token, *Pro* | Bildschirmschoner-Einstellungen |
| POST | `/api/family/evcc/mode` | Token, *Pro* | evcc-Lademodus `{ loadpoint, mode: off \| pv \| minpv \| now }` |
| POST | `/api/family/device-output` | Token, *Pro* | Shelly-Relais schalten |
| GET / POST | `/api/family/mqtt-tiles` | Token, *Pro* | MQTT-Kacheln lesen / setzen |
| GET | `/api/family/tile-history` | LAN·dashboard, *Pro* | Verlauf einer Kachel (`?id=`) |
| GET | `/api/family/tesla-history` | LAN·dashboard, *Pro* | Tesla-Verlauf |
| GET | `/api/family/tesla-sessions` | Token, *Pro* | Tesla-Ladevorgänge |
| POST | `/api/family/tesla-config` | Token | TeslaMate-Anbindung |
| GET / POST | `/api/family/shelly-devices` | Token | Shelly-Geräte lesen / setzen |

### 3.21 VPN *(DVhub Pro)*

| Methode | Pfad | Zugang | Beschreibung |
|---|---|---|---|
| GET | `/api/vpn/status` | LAN·integrations, *Pro* | Tunnel-Zustand |
| GET | `/api/vpn/history` | LAN·integrations, *Pro* | Verlauf |
| GET | `/api/vpn/config` | Token, *Pro* | Konfiguration |
| POST | `/api/vpn/config/upload` | Token, *Pro* | Konfigurationsdatei hochladen |
| POST | `/api/vpn/start`, `/api/vpn/stop`, `/api/vpn/restart` | Token, *Pro* | Tunnel steuern |

### 3.22 Lizenz

| Methode | Pfad | Zugang | Beschreibung |
|---|---|---|---|
| GET | `/api/license/state` | Token | Lizenzstatus (Schlüssel nie im Klartext) |
| POST | `/api/license/activate` | Token | Lizenzschlüssel aktivieren |
| POST | `/api/license/activate-node-lock` | Token | Offline-Aktivierung mit Maschinen-Datei |
| POST | `/api/license/revalidate` | Token | Lizenz neu prüfen |
| POST | `/api/license/remove` | Token | Lizenz entfernen |

### 3.23 Installateurs-Portal

**Kundenseite** (in DVhub, normaler Zugang):

| Methode | Pfad | Zugang | Beschreibung |
|---|---|---|---|
| GET | `/api/installer/client/status` | Token | Verbindung zum Portal |
| POST | `/api/installer/client/pair` | Token+Nonce | Mit einem Installateurs-Portal koppeln |
| POST | `/api/installer/client/disconnect` | Token | Verbindung trennen |
| GET | `/api/installer/list` | Token | Gekoppelte Installateure |
| POST | `/api/installer/confirm` | Token+Nonce | Kopplungsanfrage bestätigen (Kopplungs-Code) |
| POST | `/api/installer/revoke` | Token | Installateur entfernen |
| GET | `/api/installer/settings` | Token | Freigaben (Tunnel, Updates), liefert `uiToken` |
| POST | `/api/installer/settings` | Token+Nonce | Freigaben setzen (Einschränken geht ohne Nonce) |

**Portalseite** (vom Portal aufgerufen, auch über das Internet, durch Kopplung und Signaturen gesichert):

| Methode | Pfad | Zugang | Beschreibung |
|---|---|---|---|
| POST | `/api/installer/register` | Portal | Kopplung anfragen |
| POST | `/api/installer/login/challenge`, `/api/installer/login` | Portal | Anmeldung mit Signatur → Session-Token |
| GET | `/api/installer/info` | Portal | Gerät, Version, Update-Kanal, Laufzeit |
| GET | `/api/installer/status` | Portal | = `/api/status` |
| GET | `/api/installer/history/summary`, `/api/installer/history/raw` | Portal | = `/api/history/summary`, `/api/history/raw` |
| GET | `/api/installer/updates/check` | Portal | = `/api/admin/update/check` |
| POST | `/api/installer/updates/apply` | Portal + Kunden-Freigabe | = `/api/admin/update/apply` |
| GET | `/api/installer/support-tunnel/status` | Portal | = `/api/support/tunnel/status` |
| POST | `/api/installer/support-tunnel/open` | Portal + Kunden-Freigabe | = `/api/support/tunnel/open` |
| POST | `/api/installer/support-tunnel/close` | Portal | = `/api/support/tunnel/close` (immer erlaubt) |

---

## Beispiele

```bash
TOKEN=…   # apiToken aus /etc/dvhub/config.json
H="Authorization: Bearer $TOKEN"

curl -H "$H" http://<dvhub>/api/status
curl http://<dvhub>/dv/control-value
curl -H "$H" -H 'content-type: application/json' \
     -d '{"target":"gridSetpointW","value":-2000}' http://<dvhub>/api/control/write
curl -H "$H" -H 'content-type: application/json' \
     -d '{"target":"gridSetpointW","clear":true}' http://<dvhub>/api/control/write
curl -H "$H" -X POST http://<dvhub>/api/control/stop
curl -H "X-DVhub-Push-Key: <schlüssel>" "http://<dvhub>/api/input/push?grid_w=-1500&soc_pct=64&battery_w=1000&pv_w=5000"
```

Siehe auch: [MQTT-SCHEMA.md](MQTT-SCHEMA.md) (MQTT-Topics, Steuerung per MQTT), [LOXONE.md](LOXONE.md).
