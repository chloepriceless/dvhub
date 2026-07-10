# DVhub mit einer Deye-Anlage über Node-RED verbinden

**Integrationsanleitung: Node-RED als „virtueller Victron-GX" (MQTT-Bridge)**

Stand: 2026-07-04 | Zielgruppe: Betreiber mit Deye-Hybrid-Wechselrichter, der bereits über Node-RED ausgelesen/gesteuert wird | Schwierigkeitsgrad: fortgeschritten (Node-RED-Kenntnisse nötig)

---

## 1. Funktionsprinzip

DVhub steuert Speichersysteme normalerweise über einen Victron-GX (MultiPlus/Ekrano). Neben
Modbus spricht DVhub dafür auch das **Venus-OS-MQTT-Protokoll**: Messwerte kommen als
`N/...`-Topics herein, Steuerbefehle gehen als `W/...`-Topics hinaus, ein Keepalive läuft über
`R/...`-Topics.

Genau diese Schnittstelle bildet deine Node-RED-Instanz nach. DVhub „denkt", es spricht mit
einem GX — tatsächlich übersetzt Node-RED alles von und zur Deye:

```
+------------+  MQTT (Venus-Konvention)   +------------+    Modbus o. ä.     +-----------+
|   DVhub    | - W/deye1/... (Befehle) -> |  Node-RED  | ----- Befehle ----> |   Deye    |
| EOS / DV / | <- N/deye1/... (Werte) --- |  (Bridge)  | <--- Messwerte ---- | Hybrid-WR |
| Leitstand  | - R/deye1/keepalive -----> |            |                     |  + Akku   |
+------------+ (über euren MQTT-Broker)   +------------+                     +-----------+
```

**Was danach funktioniert:** der komplette DVhub-Funktionsumfang — Leitstand, Historie/
Auswertungen, PV-/Last-Prognosen, EOS-Optimierung und Direktvermarktungs-Steuerung (Pro) —
ohne eine Zeile Änderung an DVhub.

**Was du dafür baust:** einen Node-RED-Flow mit fünf Bausteinen (Kapitel 5). Der anspruchsvollste
Teil ist die Übersetzung des Netz-Sollwerts in Deye-Befehle (Kapitel 6) — dort steckt die
eigentliche Ingenieursarbeit.

---

## 2. Voraussetzungen

- **DVhub** ab Version 1.0 (installiert nach Standard-Anleitung)
- **MQTT-Broker** im LAN (z. B. Mosquitto; kann auf demselben Host wie Node-RED laufen)
- **Node-RED** mit funktionierender Deye-Anbindung: du kannst heute schon
  - SoC, Batterie-Leistung, PV-Leistung und **Netz-Leistung je Phase** auslesen und
  - Lade-/Entladeleistung der Deye aktiv vorgeben (z. B. über die Modbus-Register eures Modells)
- **Netz-Messung am Hausanschluss** (Deye-CT/-Meter) — ohne Messung am Netzverknüpfungspunkt
  kann der Sollwert-Regler (Kapitel 6) nicht arbeiten
- Für EOS-Optimierung und DV-Steuerung: **DVhub-Pro-Lizenz** (Anzeige/Historie laufen auch ohne)

---

## 3. Der Schnittstellen-Vertrag

### 3.1 Grundregeln

- **Payload-Format:** immer JSON `{"value": <Zahl>}` — z. B. `{"value": 57.4}`
- **Portal-ID:** frei wählbar, in dieser Anleitung `deye1` (in DVhub und Node-RED identisch!)
- **Frische-Regel (wichtig!):** DVhub verwirft Werte, die älter als **90 Sekunden** sind
  (3 x Keepalive-Intervall). Publiziere jeden Messwert daher **mindestens alle 30 s**,
  besser **alle 5-10 s** oder bei Änderung.
- **Kein `retain` nötig:** DVhub ignoriert vom Broker wiederholte Retained-Nachrichten
  bewusst (ein Replay alter Werte ist kein Beweis, dass die Anlage lebt). Die Startwerte
  nach einem DVhub-Neustart kommen automatisch über das Keepalive: DVhub sendet sofort
  `R/deye1/keepalive`, deine Bridge antwortet mit einer Voll-Publikation (3.5).
  Gesetztes `retain` schadet nicht — es bringt nur nichts.
- **QoS:** 0 genügt.

### 3.2 Messwerte: Node-RED an DVhub (Pflicht-Topics)

| Topic | Bedeutung | Einheit | Vorzeichen |
|---|---|---|---|
| `N/deye1/system/0/Dc/Battery/Soc` | Akku-Ladestand | % (0-100) | — |
| `N/deye1/system/0/Dc/Battery/Power` | Akku-Leistung | W | **positiv = Laden**, negativ = Entladen |
| `N/deye1/system/0/Dc/Pv/Power` | PV-Leistung (DC/MPPT) | W | immer >= 0 |
| `N/deye1/system/0/Ac/Grid/L1/Power` | Netzleistung Phase 1 | W | **positiv = Netzbezug**, negativ = Einspeisung |
| `N/deye1/system/0/Ac/Grid/L2/Power` | Netzleistung Phase 2 | W | wie L1 |
| `N/deye1/system/0/Ac/Grid/L3/Power` | Netzleistung Phase 3 | W | wie L1 (einphasig: L2/L3 = 0 publizieren) |
| `N/deye1/system/0/Ac/Consumption/L1/Power` | Hausverbrauch Phase 1 | W | immer >= 0 |
| `N/deye1/system/0/Ac/Consumption/L2/Power` | Hausverbrauch Phase 2 | W | immer >= 0 |
| `N/deye1/system/0/Ac/Consumption/L3/Power` | Hausverbrauch Phase 3 | W | immer >= 0 |

Optional (nur wenn AC-gekoppelte PV existiert): `N/deye1/system/0/Ac/PvOnGrid/L1..L3/Power`.
**Tipp:** Ohne AC-PV diese drei Topics einfach mit `0` publizieren — sonst tauchen (harmlose,
aber verwirrende) Lesefehler für die AC-PV-Punkte im DVhub-Status auf.

### 3.3 Einstellungs-Spiegel: Node-RED an DVhub (Readback)

DVhub liest seine eigenen Sollwerte zur Kontrolle zurück. Publiziere nach **jedem** empfangenen
Schreibbefehl (3.4) den angenommenen Wert auf dem zugehörigen `N/`-Topic zurück — und beim
Start einmal die Ist-Werte:

| Topic | Spiegel von |
|---|---|
| `N/deye1/settings/0/Settings/CGwacs/AcPowerSetPoint` | Netz-Sollwert |
| `N/deye1/settings/0/Settings/CGwacs/BatteryLife/MinimumSocLimit` | SoC-Untergrenze |

### 3.4 Steuerbefehle: DVhub an Node-RED (diese Topics abonnieren)

| Topic | Bedeutung | Wertebereich / Semantik |
|---|---|---|
| `W/deye1/settings/0/Settings/CGwacs/AcPowerSetPoint` | **Netz-Sollwert** — das zentrale Steuersignal | W. **Positiv = gewünschter Netzbezug, negativ = gewünschte Einspeisung** am Hausanschluss. Beispiel: `-2000` = „speise 2 kW ins Netz ein". Siehe Kapitel 6. |
| `W/deye1/settings/0/Settings/CGwacs/MaxDischargePower` | Entladeleistungs-Deckel | W. `0` = Entladen gesperrt, größer `0` = Deckel in W, `-1` = unbegrenzt |
| `W/deye1/settings/0/Settings/CGwacs/BatteryLife/MinimumSocLimit` | SoC-Untergrenze | % (z. B. `20` = nicht unter 20 % entladen) |
| `W/deye1/settings/0/Settings/SystemSetup/MaxChargeCurrent` | Ladestrom-Deckel | A. `-1` = unbegrenzt. Bei der Deye ggf. in Ladeleistung umrechnen (A mal Batteriespannung) |
| `W/deye1/settings/0/Settings/CGwacs/OvervoltageFeedIn` | DC-PV-Überschuss einspeisen (DV-Vermarktung) | `0/1` — optional; wenn nicht abbildbar: annehmen + zurückspiegeln |
| `W/deye1/settings/0/Settings/CGwacs/PreventFeedback` | AC-PV-Einspeisung unterbinden | `0/1` — optional; wie oben |

### 3.5 Keepalive und Nachforderung: DVhub an Node-RED

| Topic | Verhalten deiner Bridge |
|---|---|
| `R/deye1/keepalive` (alle 30 s, leerer Payload) | Antwort: **alle** `N/`-Topics einmal frisch publizieren — **einschließlich der Settings-Readbacks aus 3.3** (sie sind Teil der Voll-Publikation; nur bei Bridge-Start zu publizieren reicht nicht). Zusätzlich: **Watchdog füttern** (Kapitel 7) |
| `R/deye1/<beliebiger N-Pfad>` | DVhub fordert genau diesen Wert nach: das entsprechende `N/`-Topic sofort publizieren |

---

## 4. DVhub konfigurieren

**Schritt 1 — Herstellerprofil „Universal (MQTT-Bridge)" wählen.** In den DVhub-Einstellungen
unter *Anlage verbinden → Anlagenprofil* den Hersteller auf **„Universal (MQTT-Bridge)"**
stellen (Profil `hersteller/bridge-mqtt.json` — die offizielle Universal-Schnittstelle für
alle nicht nativ unterstützten Wechselrichter). In der Gruppe *MQTT-Bridge (Universal)*
konfigurieren:

- **Portal-ID (Topic-Namensraum):** `deye1` — muss exakt der Portal-ID entsprechen, unter der
  deine Bridge publiziert. Leer gelassen gilt der Profil-Standard `dvhub`; dann müssen die
  Topics deiner Bridge `N/dvhub/…` heißen.
- **MQTT-Broker-URL:** z. B. `mqtt://192.168.x.x:1883`. Leer gelassen wird
  `mqtt://<Anlagenadresse>:1883` verwendet — dann trägst du im Feld „Anlagenadresse" die
  Broker-IP ein.

Ein Datei-Edit ist nicht mehr nötig. (Bestands-Setups, die den früheren Weg — `victron.json`
mit `"transport": "mqtt"` — nutzen, laufen unverändert weiter; für Neueinrichtungen ist das
Universal-Profil der offizielle Weg.)

**Schritt 2 — Vorzeichen-Konvention setzen.** In den DVhub-Einstellungen
(*Grundsystem: „Bedeutung positiver Netzwerte"*) auf **„Positiv bedeutet Netzbezug"**
(`grid_import`) stellen — passend zur Tabelle 3.2.

**Schritt 3 — DVhub neu starten** (Einstellungen: Neustart, oder
`systemctl restart dvhub`). Im Log erscheint `Transport initialisiert: mqtt` und
`[MQTT] Verbunden mit mqtt://...`.

---

## 5. Der Node-RED-Flow — fünf Bausteine

1. **Werte-Publisher.** Ein Inject-Node (alle 5-10 s) triggert das Publizieren aller Topics aus
   3.2 aus deinen vorhandenen Deye-Reads. Function-Node formt `{"value": ...}`, MQTT-out mit
   `retain: true`.
2. **Keepalive-Responder.** MQTT-in auf `R/deye1/#`: bei `keepalive` alle Werte publizieren,
   bei anderen `R/`-Pfaden das jeweilige `N/`-Topic. Jede empfangene Keepalive-Nachricht
   setzt außerdem den Watchdog-Timer zurück (Baustein 5).
3. **Befehls-Handler.** MQTT-in auf `W/deye1/#`: JSON parsen, nach Topic verzweigen
   (Switch-Node), Wert an die Deye-Steuerlogik übergeben **und sofort auf das
   `N/`-Spiegel-Topic zurückpublizieren** (3.3).
4. **Sollwert-Regler.** Die Übersetzung `AcPowerSetPoint` in Deye-Lade-/Entladebefehle
   (Kapitel 6).
5. **Watchdog.** Trigger-Node: wenn **90 s** weder Keepalive noch ein `W/`-Befehl ankam:
   Failsafe auslösen (Kapitel 7).

---

## 6. Der Sollwert-Regler (das Herzstück)

`AcPowerSetPoint` ist **kein** Batteriebefehl, sondern ein **Regelziel am Hausanschluss**:
„Sorge dafür, dass am Netzverknüpfungspunkt genau X Watt fließen." Ein Victron regelt das
intern — deine Bridge muss es für die Deye nachbilden:

**Regelschleife (alle 2-5 s):**

```
Netz_Ist      = L1 + L2 + L3                 (aus der Deye-CT-Messung, positiv = Bezug)
Fehler        = Netz_Ist - Setpoint          (positiv = zu viel Netzbezug)
Batterie_Soll = Batterie_Ist + Fehler        (positiv = mehr entladen bzw. weniger laden)
```

`Batterie_Soll` größer 0: Entladeleistung vorgeben (bis zum aktuellen
`MaxDischargePower`-Deckel). `Batterie_Soll` kleiner 0: Ladeleistung vorgeben. Danach
begrenzen (Sättigung): Wechselrichter-Nennleistung, `MaxDischargePower`, `MinimumSocLimit`
(SoC an der Untergrenze bedeutet Entladen = 0), Ladeschluss bei 100 %.

**Beispiel:** Setpoint `-2000` (2 kW einspeisen), Haus verbraucht 800 W, PV liefert 1.200 W.
Die Batterie muss zusätzlich rund 1.600 W entladen, damit am Zähler -2.000 W stehen.

**Praxis-Tipps:**

- Sanft nachführen (z. B. nur 50-70 % des Fehlers pro Zyklus aufschalten) — verhindert
  Aufschwingen gegen die Deye-interne Regelung.
- Totband von +/- 25 W, damit der Regler bei Messrauschen nicht zappelt.
- Typische Werte im Betrieb: DVhub schreibt den Setpoint zyklisch neu (auch unverändert —
  das ist das Keepalive-Verhalten des Steuerpfads); beim Negativpreis-Schutz z. B. `-40`
  (nahe Null-Einspeisung), im Arbitrage-Betrieb auch große negative Werte.

---

## 7. Sicherheit — Pflichtprogramm

1. **Watchdog (MUSS):** 90 s ohne Keepalive **und** ohne `W/`-Befehl: Deye in den sicheren
   Eigenverbrauchs-Modus schalten (Selbstverbrauch, keine erzwungene Netzeinspeisung/-ladung).
   DVhubs eigene Schutzmechanismen (Not-Halt, Watchdogs) enden an der Bridge — dieser
   Fallback ersetzt sie auf der Anlagenseite.
2. **Backstop-Limits im Wechselrichter (MUSS):** Maximale Lade-/Entladeleistung und absolute
   SoC-Untergrenze **zusätzlich in der Deye selbst** konfigurieren. Ein Fehler im Flow darf
   physikalische Grenzen nie erreichen.
3. **Jeden Befehl umsetzen oder ehrlich spiegeln:** Was die Bridge nicht abbilden kann
   (z. B. `OvervoltageFeedIn`), nimmt sie an und spiegelt es zurück — aber dokumentiere für
   dich, dass es wirkungslos ist. Niemals Befehle stillschweigend verwerfen, die die
   Batteriesteuerung betreffen.
4. **Netzbetreiber-Vorgaben** (Einspeiselimit am Anschluss) gehören als hartes Limit in den
   Regler (Kapitel 6), nicht nur in DVhub.

---

## 8. Inbetriebnahme und Abnahme

**Reihenfolge: erst beobachten, dann steuern.**

1. **Bridge-Werte prüfen** (vor der DVhub-Umstellung):
   `mosquitto_sub -h <broker> -t 'N/deye1/#' -v` — alle Pflicht-Topics erscheinen, Werte
   plausibel, Vorzeichen laut 3.2 (Netzbezug positiv! Akku-Laden positiv!).
2. **DVhub umstellen** (Kapitel 4) und neu starten. Leitstand öffnen: SoC, PV, Netz- und
   Akku-Leistung erscheinen und bewegen sich live.
3. **Frische-Test:** Bridge 3-4 Minuten pausieren. DVhub behandelt die Werte nach 90 s intern
   als veraltet (Fehlerzähler steigt) und meldet die Verbindung nach spätestens ~3 Minuten
   als gestört. Bridge wieder starten: erholt sich von selbst, ohne DVhub-Neustart.
4. **Erster Steuer-Smoke-Test (harmlos):** In DVhub die SoC-Untergrenze ändern. Der Befehl
   kommt auf `W/.../MinimumSocLimit` in Node-RED an, die Deye übernimmt, der Readback
   erscheint in DVhub.
5. **Sollwert-Test (beaufsichtigt!):** Manuell einen moderaten Setpoint schreiben (z. B.
   `-500`) und am Zähler prüfen, dass sich der Netzfluss auf etwa -500 W einregelt. Danach
   `0` (Null-Austausch) prüfen.
6. **Watchdog-Test:** DVhub stoppen. Nach 90 s muss die Deye im Eigenverbrauchs-Fallback sein.
7. **24-h-Beobachtung** mit aktivierter Optimierung, bevor die Anlage unbeaufsichtigt läuft.

---

## 9. Fehlersuche

| Symptom | Wahrscheinliche Ursache |
|---|---|
| DVhub zeigt keine Werte | Portal-ID stimmt nicht überein (Profil vs. Topics); Broker-Adresse falsch; im Log fehlt `[MQTT] Verbunden...` |
| Werte erscheinen, frieren aber ein | Bridge publiziert seltener als alle 30 s — die Frische-Regel schlägt zu; Publisher-Intervall verkürzen |
| Netzleistung mit falschem Vorzeichen / Autarkie unsinnig | Vorzeichen-Konvention: Topics müssen „positiv = Bezug" liefern **und** DVhub muss auf „Positiv bedeutet Netzbezug" stehen |
| Steuerbefehle kommen nicht an | `W/deye1/#` nicht abonniert; DVhub-Steuerung noch nicht aktiv (Pro-Lizenz? Steuerpfad in den Einstellungen aktiviert?) |
| Setpoint wird geschrieben, Anlage reagiert kaum | Der Regler aus Kapitel 6 begrenzt zu früh (MaxDischargePower? SoC-Grenze? Deye-interne Limits?) |
| Anlage pendelt / schwingt | Regelzyklus zu aggressiv — Dämpfung erhöhen, Totband einführen |

---

## 10. Grenzen dieser Anbindung

- **Victron-Gerätealarme** (VE.Bus-/BMS-Alarmregister) gibt es hier nicht — Deye-Alarme können
  stattdessen als **MQTT-Kacheln** ins Family-Dashboard geholt werden (Einstellungen:
  Integrationen, MQTT-Kacheln).
- **Geräte-Discovery/Meter-Scan** in DVhub sind Modbus-Funktionen und bleiben ungenutzt.
- Die Qualität der Regelung (Kapitel 6) bestimmt die Qualität der Optimierung: EOS plant
  viertelstundengenau — ein träger oder stark gedeckelter Regler verschenkt Erlöse.
- Diese Anleitung ist **end-to-end getestet** (2026-07-04, DVhub 1.0 auf Debian-13-LXC gegen
  eine vertragskonforme Bridge-Simulation): Messwerte, Steuerbefehle inkl. Readback,
  Keepalive/Nachforderung, Frische-Erkennung (Verbindung nach ~3 min als gestört gemeldet)
  und Selbst-Erholung. Die Deye-seitige Befehlsumsetzung hängt vom Modell
  (z. B. SUN-...K-SG0xLP3) und eurer bestehenden Node-RED-Basis ab.

---

*Fragen oder Unterstützung beim Bridge-Flow: support@dvhub.de*
