# Changelog

Alle nennenswerten Änderungen an DVhub werden in dieser Datei dokumentiert.

Das Format orientiert sich an [Keep a Changelog](https://keepachangelog.com/de/1.1.0/),
die Versionierung folgt [Semantic Versioning](https://semver.org/lang/de/).

CHANGELOG.md ist die Single Source of Truth für die Versionshistorie; der README
verweist hierher.

## [Unreleased]

## [1.0.5] - 2026-07-29

Zuverlässigkeits-Release. Schwerpunkt: DVhub merkt jetzt selbst, wenn die Anlage
zwar antwortet, aber keine echten Messwerte mehr liefert — der Fall, der am
24.07. zweieinhalb Stunden lang unbemerkt blieb. Dazu ein zweiter, unabhängiger
Lesepfad zur Gegenprobe, der vollständige MQTT-Anschluss und — aus dem
Anwender-Feedback — ein einstellbarer Einspeise-Puffer gegen Bezugsspitzen,
sowohl im Normalbetrieb als auch während der Abregelung.

### Behoben (Nachtrag 29.07.)

- **Der Einspeise-Puffer wirkte während der Abregelung nicht.** Das
  Herstellerprofil enthielt weiterhin ein fest eingetragenes `-40 W`, und der
  gesamte `dvControl`-Zweig galt als „vom Hersteller verwaltet": er wurde beim
  Laden aus der Konfiguration entfernt und komplett durch den Profil-Block
  ersetzt. Damit gewann das Profil-`-40` gegen den eingestellten Default Grid
  Setpoint — der Puffer kam in der Abregelung nie an. Der Schlüssel ist jetzt
  aus allen vier ausgelieferten Profilen entfernt; die Abregelung folgt dem Wert
  unter „Zeitplan → Grundzustand".
- **Der Schalter „Aktive Anlagensteuerung (DV-Schnittstelle)" ließ sich nicht
  bedienen.** Er lag im selben verworfenen Zweig: Speichern blieb wirkungslos,
  nach dem Neuladen stand er wieder auf AUS. Vom Herstellerprofil verwaltet ist
  jetzt nur noch die Register-Verdrahtung; der Schalter und der
  Negativpreis-Schutz gehören dem Betreiber.
- **Ja/Nein-Schalter ohne gespeicherten Wert zeigten AUS, obwohl die Funktion
  lief.** Die Einstellungsseite stellte nur den gespeicherten Wert dar; fehlte
  er, erschien ein leerer Haken statt des wirksamen Zustands.

### Neu

- **„Default Grid Setpoint" ist jetzt der Einspeise-Puffer — überall.** Steht der
  Netz-Sollwert auf 0, regelt die Anlage auf „null am Zähler"; schaltet dann ein
  großer Verbraucher zu (Herd, Wärmepumpe, Wallbox), entsteht kurzzeitig bis zu
  1 kW Netzbezug, weil die Regelung dem Lastsprung hinterherläuft. Der bereits
  vorhandene Wert unter „Zeitplan → Grundzustand" wirkt deshalb nicht mehr nur
  als Rückfallwert, wenn gar keine Regel läuft, sondern als **Untergrenze für
  jeden** Sollwert — auch gegenüber Regel, Optimierer und EOS. Richtwert: etwa
  so viel, wie die größte einzelne Last zieht, typisch −100 bis −500 W. Der
  kleine Dauer-Export ist reiner Regel-Puffer; nennenswert eingespeist wird
  dabei nichts. **Es gibt dafür bewusst keine zweite Einstellung**, auch nicht
  für die Abregelung — ein Wert, der überall gilt. Ein stärkerer Export wird nie
  abgeschwächt und ein gewolltes Netzladen nie umgedreht. Aus bleibt der Puffer,
  wenn der Börsenpreis negativ **oder unbekannt** ist (ein ausgefallener
  Preis-Feed darf keinen Export erzwingen), im Not-Halt und unterhalb des
  Entlade-Bodens — der Akkuschutz behält immer Vorrang.
  Danke an **Johann (@VdwBM)** für den Hinweis (GitHub #12).

- **Einfrier-Wächter für die Live-Daten.** DVhub erkennt jetzt den Fall, dass die
  Anlage zwar sauber antwortet, aber immer denselben Messwert liefert — eine
  halb-tote Modbus-Sitzung am GX/Wechselrichter (beobachtet am 24.07.2026: der
  Ladestand hing 2,5 Stunden bei 7 %, während die Anlage real weiterlief; kein
  einziger Lesefehler, keine Warnung). Zwei Erkennungen: (1) alle Live-Werte
  stehen gleichzeitig unverändert still, obwohl Leistung fließt; (2) der
  Ladestand bewegt sich nicht, obwohl fortlaufend Akku-Leistung gemeldet wird.
  Bei Verdacht datiert DVhub die Frische der Messwerte auf den letzten echten
  Wertwechsel zurück (womit der bestehende Entlade-Boden-Schutz jede erzwungene
  Entladung anhält), verwirft die Modbus-Verbindung und baut sie neu auf und
  schlägt laut Alarm: Banner im Leitstand, Push-Benachrichtigung, Log-Eintrag
  „critical", Monitoring-Signal (`dvhub_telemetry_freeze_active`). Neue
  Einstellungen unter „Verbindung" (`victron.freezeWatchdog.*`), **Standard AUS**
  — der Wächter greift in die Regelung ein und seine Schwellen sind bisher nur
  an einer einzigen Anlage erprobt; einschalten, wenn eingefrorene Messwerte
  vermutet werden.
  Die Schwellen sind gegen fünf Tage echte Anlagendaten kalibriert: die
  Ladestand-Erkennung arbeitet nur im linearen Bereich (10–95 %), weil der
  Ladestand in der Absorptionsphase eines vollen Akkus stundenlang legitim
  stillsteht. Der Verbindungs-Neuaufbau ist auf drei Versuche je Vorfall
  begrenzt — ein Abriss-/Neuaufbau-Karussell belastet die Anlagensteuerung
  nachweislich bis zum Neustart; hilft der Neuaufbau nicht, bleibt der Alarm.

- **Zweitquellen-Kreuzprobe (MQTT).** DVhub kann die Messwerte der Anlage jetzt
  über einen zweiten, unabhängigen Weg gegenlesen: den MQTT-Dienst der Anlage.
  Der läuft als eigener Dienst neben der Modbus-Schnittstelle und zeigt dasselbe
  wie das Display am Gerät. Widersprechen sich beide Wege dauerhaft (Standard:
  3 Minuten), meldet DVhub das laut — Banner, Push-Nachricht, Log-Eintrag
  „critical", Monitoring-Signal — und setzt keine neuen Entladebefehle mehr ab.
  Hintergrund: Am 24.07.2026 lieferte die Modbus-Schnittstelle 2,5 Stunden lang
  veraltete, aber in sich stimmige Werte; kein einziger Test *innerhalb* der
  Modbus-Daten konnte das erkennen (auch eine zweite Modbus-Verbindung nicht).
  Neue Einstellungen unter „Verbindung" (`victron.mqttCrossCheck.*`), Standard
  AUS — sie braucht die Zugangsdaten des MQTT-Dienstes.
- **MQTT-Weg vervollständigt.** Wer die Anlage über MQTT statt Modbus anbindet,
  bekommt jetzt auch Geräte-Alarme (Banner), die Rücklesung der Steuerpunkte und
  die Entladegrenze — bisher gab es das nur über Modbus. Außerdem unterstützt
  der MQTT-Zugang endlich Benutzername/Passwort und verschlüsselte Verbindungen;
  ohne das ließ sich ein aktuelles Victron-GX gar nicht anbinden.

- **Wirkungsgrad-Anpassung der Reserve-Freigabe wird angezeigt.** Die
  Einstellungen zeigen jetzt auch, ob die Übernacht-Reserve ihre Freigabe-Schwelle
  mit dem gemessenen Wirkungsgrad rechnet oder mit einem angenommenen. Die
  Einstellung war schon aktiv, ließ sich am Gerät aber nirgends ablesen.

### Behoben

- **Netzbezug während der Abregelung.** Zwei Fehler wirkten hier zusammen.
  Erstens überschrieb die Abregelung bei negativen Börsenpreisen einen
  eingestellten Netz-Sollwert (z. B. −100 W) für ihre gesamte Dauer mit fest
  eingebauten −40 W — der eingestellte Wert kam einfach nicht durch. Zweitens
  griff der Schutz nur, wenn eine Regel *mehr* Export wollte als dieser Wert:
  wollte sie 0, fiel das durch und es wurde tatsächlich 0 geschrieben, also
  „null am Zähler" mitten in der Abregelung — mit genau den Bezugsspitzen, die
  dort besonders teuer sind. Jetzt gilt auch während der Abregelung dein
  eingestellter Sollwert, und er wird **gehalten** statt nur nach oben begrenzt.
  Zur Sicherheit ist er dabei auf 1000 W gedeckelt, damit aus dem Ausregeln kein
  echter Verkauf bei negativem Preis wird. Ein bewusstes Netzladen (positiver
  Sollwert) bleibt unangetastet — das ist bei negativen Preisen wirtschaftlich
  richtig und keine Einspeisung.

- **Einstellungen der Gruppe „Verbindung" wirkten nicht.** „Telemetrie-Frische
  max. Alter" und „Modbus Connect-Timeout" wurden beim Anwenden des
  Herstellerprofils überschrieben und fielen still auf ihre Standardwerte
  zurück. Beide Werte (und die neuen Wächter-Einstellungen) überleben die
  Profil-Anwendung jetzt.

## [1.0.4] - 2026-07-21

Bugfix-/Komfort-Release. Schwerpunkte: korrekte §14a-Modul-3-Preisrechnung,
robuste Lizenz-Aktivierung in einem Schritt, Sichtbarkeit der
EOS-Übernacht-Reserve in den Einstellungen und die Fronius-Nulleinspeisung
bei vollem Akku.

### Neu

- **Fronius GEN24: Nulleinspeisung bei Abregelung auch mit vollem Akku.** Die
  Negativpreis-/Direktvermarkter-Abregelung hält den Eigenverbrauch jetzt in
  jedem Fall aufrecht: Solange der Akku Platz hat, zwingt Force-Charge den
  PV-Überschuss in den Speicher (wie bisher); ist der Akku voll (Schwelle
  einstellbar, Standard 95 % SoC), drosselt ein 5-s-Regelkreis den
  Wechselrichter lastfolgend auf die Hauslast (SunSpec Model 123 `WMaxLimPct`,
  nie auf 0) und gibt die Akku-Entladung frei, damit der Akku bei PV-Defizit
  das Haus stützt — Export aus dem Akku verhindert der Leistungsdeckel
  physikalisch. Failsafe über `WMaxLimPct_RvrtTms`: Fällt DVhub aus, hebt der
  Wechselrichter das Limit selbst wieder auf. Neue Einstellungen unter
  „Nulleinspeisung bei Abregelung" (`zeroFeedIn.*`).
- **Lizenz-Aktivierung in einem Schritt.** „Aktivieren" bindet die Lizenz
  jetzt automatisch an die Box — der bisher nötige zweite Klick auf „An diese
  Box binden" entfällt (der Button bleibt als Fallback). Bereits aktivierte,
  aber nie gebundene Bestands-Lizenzen werden bei der nächsten periodischen
  Prüfung automatisch nachgebunden. Zusätzlich ist die Schlüssel-Eingabe
  robust gegen Zeilenumbrüche/Leerzeichen aus kopierten Lizenz-Mails.
- **Nacht-Reserve-Status sichtbar.** Der EOS-Inspector zeigt eine neue Karte
  „Nacht-Reserve" mit dem wirksamen Zustand der EOS-Übernacht-Reserve
  (aktiv/aus, Verkaufs-Marge, Blackout-Puffer, Wasserfall-Modus) — bisher war
  diese serverseitige Konfiguration in der Oberfläche unsichtbar. Der
  Hilfetext der (unverwandten) „Forecast-aware Reserve" der Kleinen
  Börsenautomatik grenzt die beiden Features jetzt klar ab.
- **Standard-Werte sichtbar.** Leere Einstellungs-Felder zeigen ihren wirksam
  greifenden Standard als Platzhalter („Standard: X") — aktive Default-Werte
  sind damit nicht mehr unsichtbar.
- **Steuerbefehl-Verifikation (Opt-in, experimentell).** Neuer
  Read-after-Write-Regelkreis: Nach jedem Steuerbefehl liest DVhub den
  Ist-Zustand vom Gerät zurück und schreibt bei Abweichung automatisch neu
  (`schedule.controlWriteVerify.enabled`, Standard aus). Feldtest auf einer
  Victron/Modbus-Anlage bestanden.
- **Echte DC-Akku-Leistung am Fronius GEN24** via SunSpec Model 160
  (`batteryPowerW`) — Grundlage für genauere Akku-Telemetrie und -Historie.
- **Fronius M124: Kunden-Registerwerte werden vor dem ersten Sperren
  restart-fest gesichert** und bei der Freigabe wiederhergestellt.
- **EOS → E-Auto-Mitoptimierung** als Beta-Karte in den Einstellungen
  zuschaltbar; die **DV-EOS-Endpunkt-URL** ist im Integrations-Drawer
  editierbar (beliebige EOS-Installation anbindbar).
- **PV-Nowcast** ist im bezahlten Plan jetzt automatisch aktiv (kein
  separater Schalter mehr).
- **EOS-Fork (Beta, standardmäßig aus):** Wasserfall-Reserve-Release
  (`EOS_RESERVE_WATERFALL`) und lastabhängige
  Wechselrichter-Wirkungsgradkurve (`EOS_INVERTER_EFF_CURVE`) liegen dem
  EOS-Drop-in bei — Aktivierung bewusst nur serverseitig, Replay-validiert.

### Behoben

- **§14a Modul 3: Fensterpreis ersetzt das Netzentgelt, nicht den ganzen
  Bezugspreis** (Issue #11). Bei dynamischem Tarif wurde der
  Hoch-/Tiefphasen-Bruttopreis fälschlich als absoluter Bezugspreis
  angesetzt — betroffen waren Slot-Preise, History-Chart und die
  EOS-Optimierung. Festpreis-Tarife behalten die bisherige Semantik.
- **Zeitplan-Vorschau zeigte nach einem Leistungs-Upgrade weiter „Akku
  16000".** Der Vorschau-Cap folgt jetzt der Leistungs-Kette
  (`akkuAcLimitW → maxDischargeW → maxChargeW → inverterMaxPowerW`) statt
  einem hartcodierten 16-kW-Wert.
- **Fronius: Meter-Kalibrierung + Hauslast-Ableitung** am Kunden-GEN24
  verifiziert; **Not-Halt** erzeugt kein irreführendes
  `neutralize_failed`-Fehlerlog mehr, wenn kein gridSetpointW-Stellpfad
  aktiv ist; **`feedExcessDcPv`-API** antwortet auf Sequenz-Profilen ehrlich
  (Modbus-exception-2-Bug).
- **VRM-Forecast ohne Token** erzeugt keinen Log-Spam mehr
  (`vrm_forecast_read_empty` still bzw. auf 1×/15 min gedrosselt).
- **Einstellungen:** PV-Prognose-Quelle zeigt ehrliche Ensemble-Labels;
  tote „ML & Forecast-Korrektur"-Karte entfernt.

## [1.0.3] - 2026-07-11

Bugfix-/Stabilisierungs-Release. Führt das **Beta-Flag für Herstellerprofile**
ein: ungetestete Treiber (Fronius, Deye, MQTT-Bridge) bleiben damit aus dem
Stable-Kanal heraus und sind nur noch im Bleeding-Edge-Kanal sichtbar, bis ihr
Test an echter Hardware bestanden ist. An der Victron-Steuerung ändert dieses
Release nichts.

### Neu

- **Beta-Flag für Herstellerprofile:** Ein Herstellerprofil kann sich als
  `"beta": true` markieren. Solche Profile erscheinen im Hersteller-Dropdown
  nur, wenn der Update-Kanal auf „Bleeding Edge (Dev)" steht — im
  Stable-Kanal sind sie unsichtbar, damit unfertige Treiber nicht versehentlich
  in einer Produktivumgebung landen. Ein bereits aktiv gewähltes Beta-Profil
  bleibt immer sichtbar. Markiert sind aktuell `fronius`, `deye-lv` und
  `bridge-mqtt` (Test an echter Hardware ausstehend — Tester bitte melden:
  info@bikinibottom.capital).
- **Fronius GEN24 (Beta): Abregelung über Batteriesteuerung statt
  Leistungskappung:** Die DV-Abregelung nutzt jetzt die
  SunSpec-Model-124-Batteriesteuerung — derselbe Weg, den evcc fährt:
  „keine Einspeisung" zwingt den PV-Überschuss in den Speicher
  (`StorCtl_Mod=2` + `OutWRte=-100 %`), das Haus bleibt aus PV+Akku versorgt;
  die Freigabe stellt den Normalbetrieb wieder her (`0` / `100 %`). Das in
  1.0.2 deaktivierte `WMaxLimPct`-Verfahren (kappte die gesamte
  Wechselrichter-Leistung) ist vollständig entfernt. Hinweis: Bei vollem
  Speicher kann wieder eingespeist werden — eine garantierte Nulleinspeisung
  braucht zusätzlich das geräteseitige Fronius-Export-Limit. Voraussetzung:
  Energiekosten-Assistent (ECA) in Solar.web deaktiviert.
- **Universal-MQTT-Herstellerprofil (`bridge-mqtt`, Beta):** Neues offizielles
  Herstellerprofil „Universal (MQTT-Bridge)" — jeder nicht nativ unterstützte
  Wechselrichter (Deye, Growatt, …) wird über eine kleine MQTT-Bridge nach dem
  dokumentierten Venus-Topic-Schema angebunden (erster Baustein des
  v1.1-Multi-Vendor-Plans, D-27). Broker-URL und Portal-ID sind jetzt direkt in
  den Einstellungen konfigurierbar (`victron.mqtt.*` ist nicht mehr
  profil-verwaltet; leere Felder nutzen die Profil-Defaults) — der bisherige
  Datei-Edit an `victron.json` entfällt. Das Hersteller-Dropdown listet
  Profile dynamisch aus dem `hersteller/`-Ordner (inkl. Anzeigename aus dem
  neuen `label`-Feld), Installer und Updater legen neue mitgelieferte Profile
  auf Bestandsboxen nach (ohne bestehende Dateien zu überschreiben), und der
  Einrichtungs-Assistent setzt einen vorkonfigurierten Hersteller nicht mehr
  auf Victron zurück.

### Behoben

- **Hersteller-Dropdown zeigte eine interne Datei:** Die Manifest-Datei
  `.shipped-hashes.json` (Baseline der Profil-Updates aus 1.0.2) tauchte als
  wählbarer „Hersteller" im Dropdown auf. Versteckte Dateien werden jetzt
  übersprungen.

## [1.0.2] - 2026-07-11

Bugfix-Release. Behebt gemeldete Multi-Vendor-/Steuerungs-Issues aus dem Feldtest.

### Behoben

- **#3 Fronius (Beta) legte Hybrid-Anlagen lahm:** Die DV-Abregelung mappte die
  Victron-„Nulleinspeisung" auf SunSpec Model 123 `WMaxLimPct=0` — das kappt die
  GESAMTE Wirkleistung des Wechselrichters, nicht nur die Netzeinspeisung. Bei
  GEN24 + Batterie lud die PV nur noch den Speicher, das Haus zog Netzstrom. Die
  aktive Abregelung ist in Stufe 1 jetzt deaktiviert (DVhub schreibt kein
  `WMaxLim`-Register mehr); die korrekte Export-Limitierung folgt mit dem
  Soft-ESS-Regler. Rücksetz-Anleitung: `docs/FRONIUS-ABREGELUNG-RUECKSETZEN.md`.
  Die MinRsvPct-Anzeige (lieferte `0xFFFF`) ist ebenfalls deaktiviert.
- **#10 Victron: Dynamische Regelung blieb nach dem Deaktivieren aktiv:** Die
  Venus-Settings `OvervoltageFeedIn`/`PreventFeedback` (reg 2707/2708) sind
  persistent; DVhub ließ seine zuletzt gesetzte Sperre stehen. Jetzt gibt DVhub
  die Einspeisung beim Deaktivieren der Steuerung (und bei jedem Start mit
  deaktivierter Steuerung) einmalig aktiv wieder frei — es setzt keine Sperre bei
  deaktivierter Steuerung. Offenlegung + manuelle Rücksetz-Wege:
  `docs/VICTRON-DYNAMISCHE-REGELUNG-ABSCHALTEN.md`.

### Neu

- **Herstellerprofil-Updates erreichen Bestandsboxen (T-MANAGED-VENDOR-PROFILES):**
  Bisher wurde ein vorhandenes Herstellerprofil beim Update NIE überschrieben, sodass
  Profil-Bugfixes (wie der Fronius-Fix) Bestandsanlagen nicht erreichten. Jetzt
  aktualisiert der Installer/Updater ein UNVERÄNDERTES Profil auf die neue Version,
  lässt aber vom Operator geänderte Profile (z. B. `victron.json` auf
  `transport=mqtt`) unangetastet und legt die neue Version als `<name>.dist` daneben.
- **Gezielter Commit-Pin im Self-Update:** Beta-Tester können im Bleeding-Edge-Kanal
  einen bestimmten Commit installieren (Eingabefeld in den Einstellungen bzw.
  `ref` an `/api/admin/update/apply`) — mit Erreichbarkeits-Anker gegen `origin/main`.
- **Deye-Direktanbindung (Beta):** Herstellerprofil „Deye SUN-…SG04LP3 (LV, 3-phasig)"
  für Telemetrie + DV-Abregelung über ein RS485-Ethernet-Gateway
  (`docs/DEYE-ANBINDUNG.md`); Fronius-GEN24-SunSpec-Profil (Beta).

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
