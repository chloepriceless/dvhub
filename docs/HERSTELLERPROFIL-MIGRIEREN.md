# Herstellerprofil migrieren (`.dist`-Datei nach einem Update)

**Kurz:** Wenn du ein Herstellerprofil selbst angepasst hast (z. B. `victron.json` mit
deiner Broker-IP oder eigenen Registern) und ein DVhub-Update eine neuere Version dieses
Profils mitbringt, **überschreibt DVhub deine Datei nicht**. Stattdessen legt es die neue
Version als `<name>.dist` daneben — damit deine Anpassungen sicher sind. Diese Anleitung
zeigt, wie du die neuen Verbesserungen übernimmst, ohne deine Anpassungen zu verlieren.

---

## 1. Warum gibt es eine `.dist`-Datei?

DVhub gleicht beim Update die ausgelieferten Herstellerprofile mit deinen aktiven Profilen
in `/etc/dvhub/hersteller/` ab:

- **Unverändertes Profil** → wird automatisch auf die neue Version aktualisiert (du bekommst
  Bugfixes ohne Zutun).
- **Von dir geändertes Profil** → bleibt unangetastet; die neue Version landet als
  `/etc/dvhub/hersteller/<name>.json.dist`. Du entscheidest, was du übernimmst.

So bekommst du Verbesserungen (z. B. neue Telemetrie- oder Alarm-Register), ohne dass ein
Update deine sorgfältig eingestellten Werte überschreibt.

## 2. Unterschiede ansehen

```bash
cd /opt/dvhub
sudo node scripts/vendor-profile-diff.mjs victron.json
```

`sudo`, weil `/etc/dvhub` nur dem Dienstbenutzer gehört (0750).

Die Ausgabe teilt die Unterschiede in drei Gruppen:

- **NEU in der neuen Version (sicher übernehmbar)** — Felder, die es in deiner Version noch
  nicht gibt (z. B. eine neue `alarms`-Sektion). Diese kannst du gefahrlos übernehmen.
- **DEINE Anpassung, in neuer Version anders** — Felder, die du geändert hast (z. B. die
  Broker-IP). Bleiben, wie sie sind — du entscheidest bewusst, ob du den neuen Wert willst.
- **NUR bei dir** — Felder, die du ergänzt hast (z. B. ein zusätzliches Register) und die die
  neue Version nicht kennt. Bleiben erhalten.

## 3. Neue Felder übernehmen (der sichere Weg)

```bash
sudo node scripts/vendor-profile-diff.mjs victron.json --apply-additions
sudo systemctl restart dvhub
```

`--apply-additions` übernimmt **ausschließlich die neu hinzugekommenen Felder** ins aktive
Profil und legt vorher automatisch ein Backup an (`<name>.bak-<zeitstempel>`). Es **ändert
oder entfernt niemals** ein bestehendes Feld — deine Broker-IP, Register und sonstigen
Anpassungen bleiben exakt erhalten. Nach dem Neustart ist das aktualisierte Profil aktiv.

## 4. Geänderte oder entfernte Felder (manuell)

Werte, die du bewusst angepasst hast, und Felder, die in der neuen Version wegfallen, nimmt
das Werkzeug **nicht** automatisch — das könnte eine laufende Steuerung stören. Wenn du einen
geänderten Standardwert doch übernehmen willst, editiere `/etc/dvhub/hersteller/<name>.json`
von Hand (mit `sudoedit`) (die `.dist`-Datei zeigt den neuen Wert), sichere vorher eine Kopie und starte
danach neu.

## 5. Aufräumen

Ist die Migration erledigt, kannst du die `.dist`-Datei löschen:

```bash
sudo rm /etc/dvhub/hersteller/victron.json.dist
```

Beim nächsten Update, das das Profil erneut ändert, wird sie bei Bedarf neu erzeugt.

---

## 6. Lese-Schlüssel für neue Hersteller (Profil-Referenz)

Seit der Lese-Engine (November 2026) kann ein Profil Netz, PV, Akku, SoC, Hauslast und Gerätegrenzen auch dann
lesen, wenn das Gerät sie nicht so ablegt wie Victron. Die Schlüssel stehen in `meter` und in `points.<name>`. Die
mitgelieferten Profile nutzen sie nicht; sie verhalten sich unverändert. Für ein reines Lese-Profil gehört zusätzlich
`"readOnly": true` auf die oberste Ebene (keine Schreibziele, keine Abregelung).

Vorzeichen in DVhub: **Netz + = Bezug**, **Akku + = Laden**. Meldet ein Gerät es andersherum, dreht `sign: -1` den
Wert (`gridPositiveMeans` in der config.json ändert nur die Ausgabe, nicht die Lesart des Geräts).

**`sign` — Vorzeichen drehen** (Punkte, Zähler, `combine`-Einträge). Wert = Rohwert × `scale` × `sign` + `offset`.

```json
"batteryPowerW": { "enabled": true, "fc": 3, "address": 294, "quantity": 1, "signed": true, "sign": -1 }
```

**`meter.scale` / `meter.sign`** — Skala und Vorzeichen auf jedem Modbus-Zählerweg (3×s16, `float32`, `int32`). Das
Ersatzregister `meter.fallback` hat eigene `scale`/`sign`. Gerät meldet 0,01 kW, Einspeisung positiv:

```json
"meter": { "fc": 3, "address": 1160, "quantity": 1, "scale": 10, "sign": -1 }
```

**`meter.layout: "point"`** — der Zähler ist ein gewöhnlicher Lesepunkt (gleiche Typen und Schlüssel wie `points`).
Ohne `phases` bleiben L1–L3 leer statt fremde Register zu lesen. `phases` erben Verbindung, Typ, Skala, `sign` und
`sfAddress` vom Zähler:

```json
"meter": {
  "layout": "point", "fc": 3, "address": 37113, "readType": "int32", "sign": -1,
  "phases": [{ "address": 37132 }, { "address": 37134 }, { "address": 37136 }]
}
```

**`combine` — Summe oder Differenz beliebiger Register** (Punkte und Zähler mit `layout: "point"`). Jeder Eintrag hat
eigene Adresse und optional eigenen `readType`, `wordOrder`, `scale`, `sign`; Verbindung, Funktionscode und fehlende
Typangaben erbt er vom Punkt. `scale`/`sign`/`offset` des Punkts gelten für die Summe. Meldet ein Eintrag „kein
Wert“, ist die Summe unbekannt. Akku = Laden − Entladen:

```json
"batteryPowerW": { "enabled": true, "fc": 3, "unitId": 3, "readType": "uint32",
  "combine": [{ "address": 31393 }, { "address": 31395, "sign": -1 }] }
```

**`split` — 32-bit-Wert aus zwei getrennten Registern** (Low- und High-Wort nicht benachbart). Braucht `readType`
`int32` oder `uint32`. DVhub liest High, Low, High und nimmt nur ein Paar, bei dem sich das High-Wort dazwischen
nicht geändert hat:

```json
"selfConsumptionW": { "enabled": true, "fc": 3, "readType": "uint32", "split": { "low": 653, "high": 659 } }
```

**`sfAddress` / `sunspec.sfOffset` — SunSpec-Skalenfaktor zur Laufzeit.** Der Faktor (−10…10) wird im selben Takt
gelesen; „nicht implementiert“ (0x8000) macht den Wert unbekannt. Liegt er höchstens 8 Register vom Wert entfernt,
kommen beide aus einer Anfrage, sonst (oder wenn das Gerät die Register dazwischen nicht kennt) prüft DVhub ihn vor
und nach dem Wert. `sfOffset` muss im Modell liegen; beim Zähler gilt der Faktor nur mit `layout: "point"`. Absolut
oder relativ zum SunSpec-Modell:

```json
"pvPowerW": { "enabled": true, "fc": 3, "address": 40083, "quantity": 1, "signed": true, "sfAddress": 40084 }
"pvPowerW": { "enabled": true, "fc": 3, "quantity": 1, "signed": true, "sunspec": { "model": 103, "offset": 14, "sfOffset": 15 } }
```

**SunSpec auch für den Zähler und auf eigener Unit/Port.** `meter` (und `meter.phases`) dürfen `sunspec` tragen. Ein
SunSpec-Punkt wird auf genau der Verbindung gescannt, von der er gelesen wird: setzt der Punkt `unitId`/`port`, gilt
diese, sonst `victron.unitId`/`victron.port`. SunSpec-Zähler auf Unit 126:

```json
"meter": { "layout": "point", "fc": 3, "unitId": 126, "signed": true,
  "sunspec": { "model": 203, "offset": 16, "sfOffset": 20 } }
```

**`wordOrder`** — `be` (Standard, High-Wort zuerst) oder `le`/`little`/`swap`/`swapped` (Low-Wort zuerst), gleich
im Lese- und Schreibpfad.

**Hauslast ohne Lastregister.** `derive: "energy_balance"` rechnet Last = PV + Bezug − Einspeisung − Akku in jedem
Takt, in dem der Lastpunkt keinen Wert liefert — auch als einzige Quelle. Ohne Akku-Punkt zählt der Akku als 0 W:

```json
"selfConsumptionW": { "enabled": false, "derive": "energy_balance" }
```

**Gerätegrenzen (nur Anzeige)** — `deviceMaxChargeW`, `deviceMaxDischargeW`, `deviceMaxChargeA`,
`deviceMaxDischargeA` sind gewöhnliche Lesepunkte; DVhub zeigt sie an und begrenzt damit nichts. `pollEveryMs` liest
selten änderliche Grenzen seltener:

```json
"deviceMaxChargeA": { "enabled": true, "fc": 3, "address": 212, "quantity": 1, "pollEveryMs": 60000 }
```

**`victron.requestPacing` — Anfrage-Taktung je Verbindung (E7).** Für Geräte, die keine Anfragen direkt
hintereinander vertragen. Gilt für die Anlagen-Verbindung `victron.host:victron.port` und dort für **jede** Anfrage,
Lesen und Schreiben, in der Reihenfolge der Warteschlange (Writes werden nie vertauscht). Wallboxen, Zähler an einer
anderen Adresse und der Register-Scan (eigene Verbindung) sind nicht betroffen. Fehlt der Block, ist alles wie
bisher; ungültige oder fehlende Werte gelten als „aus“.

| Schlüssel | Bedeutung |
|---|---|
| `minRequestGapMs` | Mindestabstand vom **Ende** einer Anfrage (Antwort, Fehler, Zeitüberschreitung) bis zur nächsten auf derselben Verbindung, auch über einen Neuaufbau der Verbindung hinweg. Höchstens 600 000. Die Wartezeit zählt nicht gegen `timeoutMs` |
| `connectDelayMs` | Pause nach jedem (Neu-)Aufbau der TCP-Verbindung vor der ersten Anfrage. Höchstens 60 000 |
| `maxRegistersPerRequest` | höchstens so viele Register je Lese-Anfrage (FC 3/4, 1–124). Längere Blöcke werden in Teil-Anfragen zerlegt, direkt hintereinander gelesen und wieder zusammengesetzt. Bei 32-bit-Werten eine gerade Zahl wählen |
| `minPollIntervalMs` | Mindestabstand der Poll-Takte. Hebt einen kürzeren „Poll Intervall (ms)“ an, senkt ihn nie. Höchstens 30 000 |

Die Not-Halt-Sperre wirkt wie bisher: ein Write, der auf seinen Abstand wartet und vor dem Not-Halt eingereiht wurde,
geht nicht mehr raus; die Rücknahme danach wartet ihren Abstand ab. Der Lese-Modus (`DVHUB_READ_ONLY=1`) lehnt Writes
sofort ab, ohne Wartezeit. SMA (höchstens eine Anfrage je 10 s, höchstens 5 Werte je Anfrage):

```json
"victron": { "transport": "modbus", "port": 502, "unitId": 3,
  "requestPacing": { "minRequestGapMs": 10000, "maxRegistersPerRequest": 10, "minPollIntervalMs": 10000 } }
```

**`combineBlock: true` — `combine` aus einer Anfrage.** Liest alle Einträge mit einer Anfrage über ihre Spanne
(höchstens 125 Register, Register dazwischen werden mitgelesen) statt einer je Eintrag. Wichtig mit
`minRequestGapMs`: eine Differenz wie Bezug − Einspeisung aus zwei Lesungen 10 s auseinander ergäbe bei einem
Richtungswechsel einen erfundenen Wert. Alle Einträge teilen Verbindung und Funktionscode des Punkts; `split`, eigene
Skalenfaktoren und `sunspec` gibt es im Block nicht:

```json
"meter": { "layout": "point", "fc": 3, "readType": "int32", "combineBlock": true,
  "combine": [{ "address": 30865 }, { "address": 30867, "sign": -1 }] }
```

**Victron-Schlüssel.** `acPvSource`, `acPvSource2` (AC-PV-Register 808–816) und „PV-Anbindung“ (`pvCoupling`)
beschreiben ein Victron-System. Sie wirken nur beim Profil `victron` und bei MQTT-Profilen; ein anderes Modbus-Profil
behält seine eigenen `acPv*`-Adressen und seine PV-Punkte.

---

*Kein Zugriff auf die Kommandozeile? Dann ignoriere die `.dist`-Datei einfach — dein aktives
Profil funktioniert unverändert weiter; du verpasst nur die neuen optionalen Felder.*
