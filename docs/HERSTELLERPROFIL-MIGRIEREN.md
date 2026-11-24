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
lesen, wenn das Gerät sie nicht so ablegt wie Victron. Die Schlüssel stehen in `meter` und in `points.<name>`, die
Verbindungs-Schlüssel (Taktung, Kennungsprobe) unter `victron`. Genutzt werden sie von den Nur-Lese-Profilen der neuen
Hersteller; Victron, Fronius, Sungrow, Deye LV und die MQTT-Profile nutzen sie nicht und verhalten sich unverändert. Für ein reines Lese-Profil gehört zusätzlich
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

**`direction` — Vorzeichen aus einem Richtungsregister** (Punkte, `combine`-Einträge, Zähler mit `layout: "point"`).
Für Geräte, die die Richtung in einem eigenen Statusregister melden (Solis 33135, SolaX 0x19). `values` ordnet jedem
Rohwert des Richtungsregisters (U16, gleiche Verbindung und gleicher Funktionscode wie der Punkt) `1` oder `-1` zu.
Wert = **Betrag** des Punkts (nach Skala, Skalenfaktor, Offset) × Faktor der gemeldeten Richtung — richtig, ob das
Gerät einen Betrag oder schon einen vorzeichenbehafteten Wert liefert. Meldet das Richtungsregister einen Wert, der
nicht in `values` steht, bleibt der Punkt leer und der Grund steht im Lesefehler (kein gehaltener Altwert, kein
geratenes Vorzeichen). `sign` daneben ist ein Fehler. Liegen Wert und Richtung höchstens 16 Register auseinander,
kommen beide aus einer Anfrage; sonst (oder wenn das Gerät den Block abweist bzw. er über `maxRegistersPerRequest`
liegt) liest DVhub die Richtung vor und nach dem Wert und nimmt nur ein Paar mit gleicher Richtung. Zähler-Phasen
erben `direction` nicht; feste Zählerwege (3×s16, `int32`, `float32`) lehnen es ab. Akku, 0 = Laden, 1 = Entladen:

```json
"batteryPowerW": { "enabled": true, "fc": 4, "address": 33149, "quantity": 2, "readType": "int32",
  "direction": { "address": 33135, "values": { "0": 1, "1": -1 } } }
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
| `maxRegistersPerRequest` | höchstens so viele Register je Lese-Anfrage (FC 3/4, 1–124). Blöcke aus unabhängigen Werten (etwa ein Zählerblock Summe + Phasen) werden in Teil-Anfragen zerlegt, direkt hintereinander gelesen und wieder zusammengesetzt. Ein Lesepunkt (ein Wert, Wert + Skalenfaktor, `combineBlock`) ist ein Messzeitpunkt und wird nie zerlegt: liegt er über dem Deckel, meldet DVhub einen Lesefehler statt Teile verschiedener Proben zu mischen |
| `minPollIntervalMs` | Mindestabstand der Poll-Takte. Hebt einen kürzeren „Poll Intervall (ms)“ an, senkt ihn nie. Höchstens 30 000 |

Die Not-Halt-Sperre wirkt wie bisher: ein Write, der auf seinen Abstand wartet und vor dem Not-Halt eingereiht wurde,
geht nicht mehr raus; die Rücknahme danach wartet ihren Abstand ab. Der Lese-Modus (`DVHUB_READ_ONLY=1`) lehnt Writes
sofort ab, ohne Wartezeit. SMA (höchstens eine Anfrage je 10 s, höchstens 5 Werte je Anfrage):

```json
"victron": { "transport": "modbus", "port": 502, "unitId": 3,
  "requestPacing": { "minRequestGapMs": 10000, "maxRegistersPerRequest": 10, "minPollIntervalMs": 10000 } }
```

**`victron.framing: "rtu-over-tcp"` — RS485-Gateway im Durchreiche-Modus (E12).** Für Geräte, die nur Modbus RTU
(RS485) sprechen und über ein Gateway erreicht werden, das **nicht** nach Modbus TCP übersetzt (transparent, „RTU over
TCP“, oft „TCP Server“ ohne Modbus-Umsetzung). DVhub schickt dann statt des Modbus-TCP-Rahmens einen RTU-Rahmen:
Unit-ID, Funktionscode und Daten, dahinter die CRC-16/Modbus (Low-Byte zuerst), ohne MBAP-Kopf. Das gilt wie
`requestPacing` nur für die Anlagen-Verbindung `victron.host:victron.port` und dort für Lesen und Schreiben (FC 1–6,
16) in der Reihenfolge der Warteschlange; `victron.port` ist der Port des Gateways. Jeder andere Wert und eine fehlende
Angabe bedeuten Modbus TCP wie bisher (Wallboxen, Zähler an anderen Adressen, Register-Scan, zweiter Sungrow-WR und
zweite GX sprechen immer Modbus TCP). Zwischen zwei RTU-Anfragen liegen immer mindestens 50 ms ab dem Ende der vorigen
(Stille am Bus: Modbus verlangt 3,5 Zeichen, bei 9600 Baud etwa 4 ms); ein größerer `requestPacing.minRequestGapMs`
gilt stattdessen, und viele RS485-Geräte brauchen ohnehin mehr.

```json
"victron": { "transport": "modbus", "port": 4196, "unitId": 85, "framing": "rtu-over-tcp",
  "requestPacing": { "minRequestGapMs": 400 } }
```

RTU hat keine Transaktions-ID. Deshalb prüft DVhub jede Antwort streng gegen die Anfrage:

| Antwort | Ergebnis |
|---|---|
| passt (Unit-ID, Funktionscode, Länge, CRC, bei Writes Adresse/Anzahl im Echo), nichts dahinter | Wert bzw. Bestätigung wie über Modbus TCP |
| gültige Ausnahme zum eigenen Funktionscode (FC + 0x80) | `modbus exception N` wie über Modbus TCP (gleiche Einordnung im Schreibtor), Verbindung bleibt |
| falsche CRC, fremde Unit-ID, fremder Funktionscode (auch Ausnahme zu einem anderen), falsche Datenlänge, falsches Echo, Bytes nach dem Ende | Fehler `modbus rtu: …`, **nie ein Wert**; Verbindung wird neu aufgebaut |
| keine oder unvollständige Antwort | `modbus timeout` nach `timeoutMs`; Verbindung wird neu aufgebaut |

Nach jedem Fehler, jeder Zeitüberschreitung und jedem Verbindungsabbruch mitten in einer Anfrage wartet DVhub eine
**Ruhezeit** (Zeitlimit der Anfrage, mindestens 1 s), bevor die nächste Anfrage rausgeht; Bytes, die ohne offene Anfrage
ankommen, verwirft es. Hintergrund: viele transparente Gateways geben serielle Bytes an jede verbundene Verbindung
weiter, eine späte Antwort käme sonst auch auf der neuen Verbindung an. Unit-ID 0 (am RS485-Bus ein Broadcast an jedes
Gerät) schickt DVhub über RTU nie (das Schreibtor zählt so einen Write als nicht gesendet). Not-Halt-Sperre und
Lese-Modus wirken unverändert, auch auf Writes, die gerade in der Ruhezeit warten.

Voraussetzungen am Gateway: **nur DVhub fragt** (keine zweite Verbindung von Home Assistant, evcc oder einem zweiten
DVhub, kein zweiter Master am RS485-Bus — eine fremde Antwort gleicher Form wäre nicht von der eigenen zu
unterscheiden), Heartbeat-/Registrierungs-Pakete aus, serielle Werte (Baudrate, 8N1) wie am Gerät. Ein Solarman-V5-
Logger (Port 8899) ist **kein** transparentes Gateway und geht weiterhin nicht.

**`combineBlock: true` — `combine` aus einer Anfrage.** Liest alle Einträge mit einer Anfrage über ihre Spanne
(höchstens 125 Register, Register dazwischen werden mitgelesen) statt einer je Eintrag. Wichtig mit
`minRequestGapMs`: eine Differenz wie Bezug − Einspeisung aus zwei Lesungen 10 s auseinander ergäbe bei einem
Richtungswechsel einen erfundenen Wert. Alle Einträge teilen Verbindung und Funktionscode des Punkts; `split`, eigene
Skalenfaktoren und `sunspec` gibt es im Block nicht:

```json
"meter": { "layout": "point", "fc": 3, "readType": "int32", "combineBlock": true,
  "combine": [{ "address": 30865 }, { "address": 30867, "sign": -1 }] }
```

**`victron.identityProbe` — Kennungsprobe (E10).** Prüft, ob an der Anlagen-Verbindung das Gerät antwortet, für das
die Registerkarte gilt (richtiges Gerät, richtige Betriebsart oder Einstellung). Nur Lesen und Anzeigen: Schreibwege
und Schreibtor sehen das Ergebnis nicht. DVhub liest die Prüfungen vor dem ersten Wert und danach alle `everyMs`
(Standard 600 000 = 10 min, 60 000…86 400 000), nach „passt nicht“ oder „nicht lesbar“ alle 60 s, nach einer Änderung
von Adresse oder Block sofort.

| Schlüssel | Bedeutung |
|---|---|
| `checks` | 1–8 Prüfungen, jede mit `fc` (3 oder 4), `address`, optional `unitId` (sonst die der Anlage) und `label`, und genau einer Bedingung: `equals` (Liste erlaubter Werte), `range` (`[min, max]`, einschließlich) oder `prefix` (Text am Anfang; `quantity` = Register des Texts, 2 Zeichen je Register). Zahlen: u16, mit `signed` s16, mit `readType` `uint32`/`int32` (+ `wordOrder`) |
| `hideOnMismatch` | Werte, deren Registerlage oder Kodierung von Gerät oder Einstellung abhängt: Punktnamen und `"meter"`. Passt die Kennung nicht, liest DVhub sie nicht und zeigt sie leer statt falsch (Grund im Lesefehler, beim Zähler `meter.ok=false` ohne Backoff). Fehlt die Liste, gibt es nur den Hinweis |
| `everyMs` | Abstand der Nachprüfung, solange die Kennung passt |

Ergebnis: `ok` (bestanden), `mismatch` (passt nicht), `unreadable` (nicht lesbar, Werte ungeprüft angezeigt) oder
`invalid` (Block im Profil fehlerhaft, Werte ungeprüft angezeigt). Es steht im Status (`identityProbe`), jedes
Ergebnis außer `ok` zusätzlich als Hinweis im Leitstand und einmal je Wechsel im Log (`identity_probe_<status>`).
Ein nicht lesbarer Nachtest ändert ein festgestelltes `ok` oder `mismatch` nicht. E3/DC im Simple-Mode:

```json
"victron": { "transport": "modbus", "port": 502, "unitId": 1,
  "identityProbe": {
    "checks": [{ "label": "E3/DC-Kennung", "fc": 3, "address": 40000, "equals": [58332] }],
    "hideOnMismatch": ["meter", "pvPowerW", "batteryPowerW", "soc"] } }
```

**Victron-Schlüssel.** `acPvSource`, `acPvSource2` (AC-PV-Register 808–816) und „PV-Anbindung“ (`pvCoupling`)
beschreiben ein Victron-System. Sie wirken nur beim Profil `victron` und bei MQTT-Profilen; ein anderes Modbus-Profil
behält seine eigenen `acPv*`-Adressen und seine PV-Punkte.

---

*Kein Zugriff auf die Kommandozeile? Dann ignoriere die `.dist`-Datei einfach — dein aktives
Profil funktioniert unverändert weiter; du verpasst nur die neuen optionalen Felder.*
