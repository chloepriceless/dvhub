# Changelog

Alle nennenswerten Änderungen an DVhub werden in dieser Datei dokumentiert.

Das Format orientiert sich an [Keep a Changelog](https://keepachangelog.com/de/1.1.0/),
die Versionierung folgt [Semantic Versioning](https://semver.org/lang/de/).

CHANGELOG.md ist die Single Source of Truth für die Versionshistorie; der README
verweist hierher.

## [1.0.1] - 2026-07-09

Bugfix-Release. Behebt gemeldete GitHub-Issues aus dem 1.0-Feedback.

### Behoben

- **#2 Min-SOC:** wird serverseitig auf 5%-Schritte gerundet. Venus OS akzeptiert
  den SOC-Mindestwert nur in 5er-Schritten — krumme Werte (z. B. 23%) sprangen
  zuvor auf ~20% zurück.
- **#8 DV-Schnittstelle abschaltbar + Not-Halt:** Die aktive Anlagensteuerung
  lässt sich jetzt in den Einstellungen deaktivieren — wichtig für Volleinspeiser
  mit fester EEG-Vergütung, deren PV sonst ungewollt abgeregelt wurde. Zusätzlich
  gibt der Not-Halt die dynamische PV-Abregelung jetzt korrekt wieder frei.
- **#9 MQTT-Aktivierung:** Das Speichern der MQTT-Konfiguration zeigt nun den
  erforderlichen Neustart-Hinweis (MQTT verbindet beim Boot) — vorher schien das
  Aktivieren wirkungslos.
- **#9 „Instabil"-Anzeige:** Die Verbindungs-Einstufung „Instabil" hing bis zu
  24 Stunden nach — ein einmaliger Fehler-Burst beim Einrichten markierte die
  Anlage stundenlang als instabil, obwohl längst alles lief. Jetzt zeigt sie nur
  noch **aktuelles** Flappen (letzter Fehler < 15 min) und erholt sich selbst.
- **#7 Kein API-Token mehr im LAN:** Der Standard ist jetzt „LAN offen" — im
  lokalen Netz ist kein API-Token nötig (behebt „Speichern fehlgeschlagen:
  unauthorized"). Härtung bleibt optional (Einstellungen → Sicherheit).
- **#6 / #7 Hilfetexte:** Präzisere Anleitungen für VRM (Portal-ID vs. Site-ID,
  Access-Token) und den Netzzähler (Modbus-RTU-Altzähler wie EM540/ET340 werden
  über das Victron-System gelesen).

### Neu

- **#5 AC-PV-Position wählbar:** Bei AC-gekoppelter PV (eigener String-Wechsel-
  richter am Victron-System, z. B. SMA oder Fronius) kann die Verdrahtungsposition
  gewählt werden: **Am Verbraucher-Ausgang** (Standard), **Am Netz-Eingang** oder
  **Am Generator-Eingang**. Hintergrund: Das Victron-GX führt die AC-PV-Leistung
  je nach Anschlussstelle in getrennten Registern. Ein nachgerüsteter Wechsel-
  richter am Netz-Eingang wurde dadurch bisher nicht als PV erkannt, sondern als
  Netzbezug verbucht — die neue Einstellung ordnet die Erzeugung korrekt zu, ganz
  ohne separaten Netzzähler.

## [1.0.0] „Sushi" - 2026-07-08

> Codename **„Sushi"** — gewidmet dem jungen Kater, der die Entwicklung begleitet
> hat: Tastaturen inspiziert, Logs überwacht und dafür gesorgt, dass kein
> Entwickler zu produktiv wurde. _This release is dedicated to him._

<!-- Veröffentlichungsdatum = Datum des operator-gegateten `v1.0.0`-Git-Tags. -->

Erstes öffentliches v1.0-Release. Konsolidiert den vollständigen Funktionsumfang
des HEMS-Ausbaus aus 0.8.0 und ergänzt ihn um fünf gezielte Go-Live-Härtungswellen
(23–27), die DVhub von „funktioniert auf der eigenen Box" zu „auslieferbar" bringen.

**Kernfunktionen (zur v1.0 ausgereift):**

- PV-/Last-Prognose-Engine (pvlib + statsforecast/LightGBM, Multi-Modell-Ensemble,
  Accuracy-Tracking, Forecast-Snapshots)
- Batterie-Optimierung: interner MILP-Optimizer (HiGHS) und Anbindung von
  Akkudoktor-EOS als externer Arbitrage-Engine mit 15-Minuten-Slots
- zweistufige Forecast-aware Börsenautomatik mit Reserve-/Hoarding-Gate und
  vorausschauender Akku-Leerung
- Aurora Design System über alle Seiten, Familien-Dashboard mit haus-zentriertem
  Energy-Flow, History-Seite mit Visualisierungs-Karten und Export
- Integrationen: Victron ESS (Modbus), MQTT mit Home-Assistant-Auto-Discovery,
  TeslaMate, Telegram-/Pushover-Benachrichtigungen, VPN-Manager
- Lizenz-Gating (Pro-Features) für die kommerzielle Auslieferung

**Deploy-Blocker behoben (Welle 1 / Phase 23):**

- TimescaleDB-Frischinstall: `timescaledb`-Default entschärft, ungegatete
  Retention-Migration (018) abgesichert
- Migrations-Runner mit Per-Migration-Fehlertoleranz; `deploy-test.sh` prüft
  jetzt echte Schema-Migrationsversionen statt nur Zeilenzahlen
- eine saubere Neuinstallation läuft ohne Crash durch

**Sichere Auslieferungs-Defaults (Welle 2 / Phase 24):**

- VPN-Config-Upload-Pfad re-auditiert
- LAN-Trust-/Host-/Proxy-Defaults gehärtet, Bootstrap-Setup-Token
  constant-time-vergleich, Redaction-Lücken geschlossen
- `family.html`-Shell hinter das Pro-Gate gelegt (explizite Route vor
  Static-Fallback)

**Steuerpfad-Korrektheit (Welle 3 / Phase 25):**

- EEG-Gate verfeinert: Selbstverbrauch/mandatory/`dc_export` passieren,
  erzwungene Netz-Entladung bleibt blockiert
- atomare (tmp+rename) Persistenz des Not-Halt-Zustands
- konfigurierbarer Modbus-Connect-Timeout (Default 5000 ms) — ein toter Host
  blockiert den Poll nicht mehr

**Forecast-Qualität (Welle 4 / Phase 26):**

- VRM/forecast_solar/open_meteo fließen ins gewichtete Ensemble (größter
  Qualitäts-Hebel)
- Inverse-MAE-Gewichte pro Slot auf vorhandene Provider renormiert
- Solcast auf Perioden-START normalisiert, Zeitzonen-Eingaben gegen ungültige
  IANA-Zonen abgesichert, §51-Stundenstreak über die View-Range-Grenze hinweg

**Test-Fundament & CI (Welle 6 / Phase 27):**

- kaputte SQLite-Test-Importpfade repariert (Suite wieder lauffähig)
- `pickMilpPlan`-Steuerpfad unter Test gestellt
- GitHub-Actions-CI (Fast-Lane + ephemeres Postgres für Migrationen + e2e),
  Setup-Wizard-Happy-Path als e2e-Test

**Release-Metadaten (Welle 5 / Phase 28):**

- Version `0.8.0` → `1.0.0`, defensiver Semver-Filter bei der Self-Update-
  Tag-Auswahl
- diese standalone `CHANGELOG.md` angelegt

**Feinschliff zum Go-Live (2026-07):**

- Historie: die Zeiträume **Woche/Monat/Jahr/Alle** hinter das Pro-Gate gelegt
  (`history-multiperiod`) — die **Tagesansicht bleibt für alle frei**; serverseitig
  (`/api/history/summary|viz/*|export` für `view≠day`) plus Dropdown-Lock mit Pro-Modal
- Forecast: güte-basierte **Ensemble-Gewichtung reaktiviert** — der Merge fiel bei
  fehlender Gestern-Accuracy still auf Gleichgewichtung zurück; jetzt Fallback auf den
  zuletzt verfügbaren Accuracy-Stand statt uniform
- Forecast: **Negativpreis-/Abregelungs-Slots aus der Accuracy ausgeschlossen** —
  abgeregelte Ist-Erzeugung verzerrte sonst MAE und Provider-Gewichte
- **pvnode-Nowcast-Tracking**: Nowcast vs Day-Ahead vs Ist je Tag
  (`/api/forecast/nowcast-track` + nächtliche Historie) — misst, wie viel die
  15-Minuten-Reruns gegenüber der Tagesprognose bringen
- Onboarding: dokumentiert, dass nach der Erstinstallation automatisch
  `onboarding.html` unter `/` erscheint (nicht `setup.html`)

## [0.8.0] - 2026-05-18 — HEMS-Ausbau

Großer Funktionssprung von der reinen DV-Schnittstelle zum Home Energy Management
System. Verdichtete Übersicht der Arbeit seit 0.4.0:

**Prognose-Engine:**

- PV-Ertragsprognose über pvlib mit Standort-/Anlagenparametern
- Lastvorhersage über statistische Modelle (statsforecast) und LightGBM
- Multi-Modell-Ensemble, Nebel-Korrektur, Accuracy-Tracking und Forecast-Snapshots
- optionale Cloud-PV-Provider (Solcast, pvnode.de) als zusätzliche Eingangsdaten

**Optimierung & Börsenautomatik:**

- interner MILP-Batterieoptimizer (HiGHS-Solver) und schnelle Heuristik
- Anbindung von Akkudoktor-EOS als externer Optimizer-Dienst
- Confidence-Gate verwirft Optimierungen bei zu unsicherer Prognose
- zweistufige Forecast-aware Börsenautomatik: Stufe 1 dimensioniert Reserve/Hoarding-Gate
  aus dem PV-Forecast, Stufe 2 („Forecast Aware++") leert den Akku vorausschauend
  mit Soft-/Hard-Limit-Taper und Live-Runtime-Clamp

**ML & Edge-KI:**

- selbstlernende ML-Korrektur des Prognosefehlers mit atomarem Modell-Swap und Schema-Guard
- Hintergrund-Retraining als Jobs, ML-Health-Überwachung
- optionales lokales LLM (TinyLlama via Ollama) für natürlichsprachige Dashboard-Kacheln
  mit deterministischem Template-Fallback und Spracherkennung
- hardware-abhängige Leistungsstufen (RAM-Tiers) im Installer

**Oberfläche & Familien-Dashboard:**

- vollständige Portierung aller Seiten auf das Aurora Design System
- Familien-Dashboard mit Haus-zentriertem Energy-Flow, MQTT-Kacheln,
  Tesla-/EV-Integration und Screensaver-Modus
- History-Seite mit 14 Visualisierungs-Karten und CSV-/Parquet-Export
- eigene Integrations-Seite inkl. MQTT-Inspector, eigener Explorer
- Tools-Seite in die Einstellungen / Status integriert

**Integrationen & Betrieb:**

- MQTT-Publisher mit Home-Assistant-Auto-Discovery, eingebauter Broker (aedes)
- TeslaMate-Anbindung mit DB-historisierten Fahrzeugwerten
- Telegram-/Pushover-Benachrichtigungen
- VPN-Manager für OpenVPN-/WireGuard-/IPsec-Tunnel
- Hersteller-Adapter-Layer, Service-orientierte Architektur
- Prometheus-Metriken unter `/api/metrics`
- TimescaleDB-Unterstützung (Continuous Aggregates & Retention)
- Multi-Schema-Telemetrie, Defence-in-Depth-Security-Hardening
- `THIRD-PARTY-LICENSES.md` als Attributionsdatei ergänzt

## [0.4.0] - 2026-03-24

- Responsive Dashboard (iPhone-Viewport), Hamburger-Navigation ohne JS
- PV-Export-Modus (nutzt `pvTotalW` statt nur DC-PV), Negativpreis-Pause
- sinnvolle Defaults bei Erstinstallation, PV-Kopplungsauswahl (AC/DC/AC+DC)
