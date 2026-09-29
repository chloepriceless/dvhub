# DVhub mit Loxone verbinden

Diese Anleitung zeigt, wie ein Loxone Miniserver und DVhub Daten austauschen — in beide Richtungen:

| Richtung | Wofür | Weg |
|---|---|---|
| **DVhub → Loxone** | Werte von DVhub in Loxone anzeigen (SoC, PV, Netz, Batterie) und die **Sollwerte** von DVhub in Loxone verwenden | Loxone **Virtueller HTTP Eingang** liest `GET /api/integration/loxone` |
| **Loxone → DVhub** | Loxone liefert DVhub die Messwerte der Anlage (PV, Batterie, SoC, Netzübergabepunkt, Hausverbrauch) — für Anlagen, deren Zähler/Speicher nur in Loxone erreichbar sind | Loxone **Virtueller Ausgang** schickt die Werte an `POST/GET /api/input/push` (oder per MQTT über das LoxBerry-MQTT-Gateway) |

Die erste Richtung funktioniert mit jeder DVhub-Anlage. Die zweite braucht das Hersteller-Profil **„Universal (DVhub-MQTT-Schema: HA/Loxone)“** (siehe Teil B).

Im Folgenden steht `<dvhub>` für die Adresse deines DVhub im Heimnetz, z. B. `192.168.1.50`.

---

## Teil A — Werte und Sollwerte von DVhub in Loxone (Virtueller HTTP Eingang)

### A.1 Was DVhub liefert

`http://<dvhub>/api/integration/loxone` liefert Textzeilen im Format `name=wert`, z. B.:

```
gridTotalW=51
gridDirection=feed_in
soc=68
batteryPowerW=11893
pvTotalW=13749
minSocPct=5
gridSetpointW=-100
dvControlValue=1
forcedOff=false
dvhub_control_grid_setpoint_w=-100
dvhub_control_charge_current_a=550
dvhub_control_min_soc_pct=5
dvhub_control_max_discharge_w=-1
dvhub_control_source=default
dvhub_control_paused=false
```

| Wert | Bedeutung |
|---|---|
| `gridTotalW` | Leistung am Netzübergabepunkt in W. Vorzeichen nach der DVhub-Einstellung „Netz-Vorzeichen“ (Standard: **Einspeisung positiv**); `gridDirection` sagt es im Klartext (`feed_in` / `grid_import` / `neutral`) |
| `soc` | Batterie-Ladezustand in % |
| `batteryPowerW` | Batterieleistung in W, **Laden positiv** |
| `pvTotalW` | PV-Leistung gesamt in W |
| `minSocPct`, `gridSetpointW` | Rücklesung der Anlage (Mindest-SoC, Netz-Sollwert) |
| `dvControlValue`, `forcedOff` | Direktvermarkter-Signal (1 = Einspeisung erlaubt) bzw. Abregelung aktiv |
| `dvhub_control_grid_setpoint_w` | **aktiver Netz-Sollwert von DVhub** in W (negativ = einspeisen) |
| `dvhub_control_charge_current_a` | Ladestrom-Vorgabe in A |
| `dvhub_control_min_soc_pct` | Mindest-SoC-Vorgabe in % |
| `dvhub_control_max_discharge_w` | maximale Entladeleistung in W (`-1` = keine Begrenzung) |
| `dvhub_control_paused` | `true`, wenn der Not-Halt aktiv ist |

Weitere Zeilen (`costs`, `dvhub_forecast`, …) enthalten JSON und sind für Loxone meist nicht nötig.

### A.2 In Loxone Config einrichten

1. **Peripherie → Virtuelle Eingänge → Virtueller HTTP Eingang** hinzufügen.
   - **URL:** `http://<dvhub>/api/integration/loxone`
   - **Abfragezyklus:** 10 s (kleiner ist nicht nötig; DVhub rechnet alle paar Sekunden neu).
2. Darunter für jeden gewünschten Wert einen **Virtueller HTTP Eingang Befehl** anlegen:

   | Name (frei) | Befehlserkennung | Einheit |
   |---|---|---|
   | DVhub SoC | `soc=\v` | % |
   | DVhub PV | `pvTotalW=\v` | W |
   | DVhub Netz | `gridTotalW=\v` | W |
   | DVhub Batterie | `batteryPowerW=\v` | W |
   | DVhub Netz-Sollwert | `dvhub_control_grid_setpoint_w=\v` | W |
   | DVhub Mindest-SoC | `dvhub_control_min_soc_pct=\v` | % |
   | DVhub Max. Entladung | `dvhub_control_max_discharge_w=\v` | W |

   `\v` liest die Zahl hinter dem Gleichheitszeichen. Werte vom Typ `true`/`false` (z. B. `dvhub_control_paused`) nicht als Zahl einlesen.
3. Die Befehle wie jeden anderen Analogeingang in der Programmierung verwenden (Anzeige, Logik, Ansteuerung eines eigenen Speichers).

### A.3 Zugriff und Sicherheit

`/api/integration/loxone` ist ein reiner Lese-Endpunkt. Ob Loxone ohne Anmeldung lesen darf, bestimmt die DVhub-Einstellung **Sicherheit → LAN-Vertrauen**:

- **`open`** (Standard) und **`restricted`**: Geräte im Heimnetz dürfen lesen, Loxone braucht nichts weiter. (Bei `restricted` muss die Gruppe „integrations“ in den LAN-sicheren Gruppen stehen — Standard.)
- **`strict`**: nur mit API-Token (`Authorization: Bearer <apiToken>`). Kann der Loxone-Eingang keinen Header setzen, `restricted` wählen.

---

## Teil B — Messwerte von Loxone an DVhub (Loxone liefert die Daten)

Für Anlagen, bei denen PV, Speicher oder Zähler nicht direkt von DVhub gelesen werden können, sondern nur in Loxone vorliegen. DVhub bekommt die Werte dann von Loxone und regelt damit wie mit einer direkt angebundenen Anlage.

### B.1 DVhub vorbereiten

1. **Einstellungen → Verbindung → Hersteller:** „Universal (DVhub-MQTT-Schema: HA/Loxone) — Beta“.
   Das Profil ist eine Beta-Funktion; sichtbar mit Update-Kanal „dev“ (Einstellungen → Status → Updates).
2. **Einstellungen → Status → Kachel „Eingang für Home Assistant / Loxone“ → „Push-Schlüssel erzeugen“.**
   Der Schlüssel wird **nur einmal** angezeigt — sofort kopieren. Ein neuer Schlüssel macht den alten ungültig.
3. Die Kachel zeigt ab jetzt für jeden Eingang den letzten Wert, sein Alter und ob er veraltet ist.

### B.2 Welche Werte DVhub braucht

| Parameter | Einheit | Pflicht | Vorzeichen / Bedeutung |
|---|---|---|---|
| `grid_w` | W | **ja** | Netzübergabepunkt, **Bezug positiv**, Einspeisung negativ |
| `soc_pct` | % | **ja** | Batterie-Ladezustand 0–100 |
| `battery_w` | W | **ja** | Batterieleistung, **Laden positiv**, Entladen negativ |
| `pv_w` | W | empfohlen | PV-Leistung gesamt |
| `load_w` | W | optional | Hausverbrauch. Fehlt er, rechnet DVhub: PV + Bezug − Einspeisung − Batterie |
| `grid_l1_w` … `grid_l3_w`, `load_l1_w` … `load_l3_w` | W | optional | je Phase statt Gesamtwert (entweder Gesamtwert **oder** Phasen) |

**Achtung Vorzeichen:** Die Eingänge verwenden immer „Netz: Bezug positiv“ und „Batterie: Laden positiv“ — unabhängig von der DVhub-Anzeigeeinstellung. Liefert Loxone ein anderes Vorzeichen, in Loxone umrechnen (z. B. Formelbaustein `-I1`).

### B.3 In Loxone Config einrichten (HTTP, ohne Zusatzhardware)

1. **Peripherie → Virtuelle Ausgänge → Virtueller Ausgang** hinzufügen.
   - **Adresse:** `http://<dvhub>`
2. Darunter **je Wert einen Virtueller Ausgang Befehl** anlegen. Ein Befehl sendet immer nur seinen eigenen Wert (`<v>`), deshalb ein Befehl pro Messwert:

   | Befehl | Befehl bei EIN | HTTP-Methode bei EIN |
   |---|---|---|
   | DVhub Netz | `/api/input/push?grid_w=<v>` | GET |
   | DVhub SoC | `/api/input/push?soc_pct=<v>` | GET |
   | DVhub Batterie | `/api/input/push?battery_w=<v>` | GET |
   | DVhub PV | `/api/input/push?pv_w=<v>` | GET |
   | DVhub Hausverbrauch (optional) | `/api/input/push?load_w=<v>` | GET |

   Bei **jedem** Befehl:
   - **HTTP-Header bei EIN:** `X-DVhub-Push-Key: <dein Push-Schlüssel>`
   - **Als Digitalausgang verwenden:** aus (es sind Analogwerte).
3. Den jeweiligen Loxone-Messwert (Zähler, Wechselrichter, Speicher-Baustein) auf den Eingang des Befehls legen.

### B.4 Wichtig: Werte regelmäßig senden

Loxone schickt einen Analogwert über einen Virtuellen Ausgang nur, **wenn er sich ändert**. DVhub betrachtet einen Wert aber nach **90 Sekunden ohne Aktualisierung als veraltet** — bei veraltetem Netzwert erklärt DVhub den Zähler für ungültig (statt mit 0 W weiterzuregeln) und meldet im Leitstand „Netzwerte fehlen oder sind veraltet“; veraltete SoC-/Batteriewerte werden als Fehler markiert.

Ein SoC, der längere Zeit gleich bleibt, würde so fälschlich veralten. Deshalb die Werte **periodisch erneut senden**, z. B. alle 10 Sekunden:

- einen **Impulsgeber** (10 s) verwenden, der die Werte über einen **Analogspeicher** (Eingang = Messwert, Trigger = Impulsgeber) an die Befehle weitergibt, oder
- für jeden Befehl in den Eigenschaften eine **Wiederholung/Mindestzeitabstand** so einstellen, dass spätestens alle 10–30 s gesendet wird (je nach Loxone-Config-Version verfügbar).

Ob es klappt, zeigt die DVhub-Kachel: Das Alter jedes Eingangs sollte dauerhaft unter 30 s bleiben, „VERALTET“ darf nicht erscheinen.

### B.5 Alternative: per MQTT über das LoxBerry-MQTT-Gateway

Wer bereits ein LoxBerry mit MQTT-Gateway nutzt, kann die Werte stattdessen als MQTT-Topics schicken (Schema: `docs/MQTT-SCHEMA.md` §2.1):

| Topic | Wert |
|---|---|
| `dvhub/input/grid/total_w` | Netz, Bezug positiv |
| `dvhub/input/battery/soc_pct` | SoC |
| `dvhub/input/battery/power_w` | Batterie, Laden positiv |
| `dvhub/input/pv/total_w` | PV gesamt |
| `dvhub/input/consumption/total_w` | Hausverbrauch (optional) |

In DVhub dann unter „MQTT-Bridge (Universal)“ die **Broker-URL des LoxBerry** eintragen (z. B. `mqtt://<loxberry>:1883`, ggf. Benutzer/Passwort). Nicht als *retained* publizieren; auch hier regelmäßig senden (B.4).

### B.6 Sollwerte von DVhub in Loxone umsetzen

Ist die Anlage nur über Loxone steuerbar, liest Loxone die Vorgaben von DVhub wie in **Teil A** (`dvhub_control_grid_setpoint_w`, `dvhub_control_min_soc_pct`, `dvhub_control_max_discharge_w`, `dvhub_control_charge_current_a`) und setzt sie am Speicher/Wechselrichter um. Ohne MQTT-Broker speichert DVhub die Sollwerte nur und stellt sie dort bereit — Loxone muss sie aktiv abholen.

---

## Teil C — Testen und Fehlersuche

### C.1 Von Hand testen (vom PC im Heimnetz)

```bash
# Lesen (Teil A)
curl http://<dvhub>/api/integration/loxone

# Schreiben (Teil B) — mehrere Werte in einem Aufruf sind beim Test erlaubt
curl -H "X-DVhub-Push-Key: <schlüssel>" "http://<dvhub>/api/input/push?grid_w=-1500&soc_pct=64&battery_w=1000&pv_w=5000"
# → {"ok":true,"accepted":["grid_w","soc_pct","battery_w","pv_w"],"errors":[]}
```

Danach zeigt die DVhub-Kachel die Werte, und im Leitstand erscheinen Netz, SoC, PV und Batterie.

### C.2 Antworten von `/api/input/push`

| Antwort | Bedeutung | Abhilfe |
|---|---|---|
| `200` mit `accepted` | Werte übernommen; unbekannte Felder/ungültige Werte stehen in `errors` | Feldnamen und Grenzen prüfen (B.2) |
| `401 push_key_invalid` | Schlüssel fehlt oder ist falsch | Header `X-DVhub-Push-Key` prüfen; ggf. neuen Schlüssel erzeugen |
| `400 keine_gueltigen_werte` | kein einziger gültiger Wert | Zahlenformat (Punkt oder Komma), Grenzen (SoC 0–100) |
| `409 input_push_inactive` | falsches Hersteller-Profil | Profil „Universal (DVhub-MQTT-Schema: HA/Loxone)“ wählen (B.1) |
| `503 input_push_split_process` | DVhub läuft im getrennten Web-/Runtime-Betrieb | HTTP-Push nur im Normalbetrieb; alternativ MQTT (B.5) |

### C.3 Typische Probleme

- **Leitstand „Netzwerte fehlen oder sind veraltet“:** Loxone sendet den Netzwert nicht (oft genug). → B.4.
- **SoC/Batterie als Fehler markiert, obwohl alles verbunden ist:** gleichbleibender Wert wird von Loxone nicht erneut gesendet. → B.4.
- **Vorzeichen verkehrt** (DVhub zeigt Bezug, obwohl eingespeist wird): Loxone liefert „Einspeisung positiv“. → in Loxone umrechnen (B.2).
- **Hausverbrauch passt nicht:** Liefert Loxone `load_w` nicht, berechnet DVhub ihn aus PV, Netz und Batterie. Das stimmt nur, wenn alle drei am selben Anschluss gemessen werden; sonst `load_w` direkt senden.

---

Siehe auch: `docs/MQTT-SCHEMA.md` (vollständiges Schema inkl. Home Assistant), README → Integrationen.
