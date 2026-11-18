# Kostal PLENTICORE / PIKO IQ — nur Anzeige (Beta)

Stand 18.11.2026. Profil `kostal-plenticore` (`dvhub/hersteller/kostal-plenticore.json`).

**Nur Anzeige, keine Steuerung, am Gerät ungeprüft.** Das Profil trägt `"readOnly": true`: DVhub schreibt nichts an
den Wechselrichter. Die Abregelung bleibt aus, auch wenn „Aktive Anlagensteuerung“ eingeschaltet ist. Es ist
`"beta": true` und erscheint nur im Bleeding-Edge-Kanal (`updateChannel: dev`), weil es an keinem Gerät getestet ist.

## Geräte

| Geräte | Passt? |
|---|---|
| PLENTICORE plus (G1), PLENTICORE G2, PLENTICORE G3 (Hybrid) | ja |
| PLENTICORE MP G3, PLENTICORE BI G3 | ja |
| PIKO IQ (ohne Akku) | ja, Akku-Werte bleiben 0 (siehe Feldtest) |
| KOSTAL-Zähler (KSEM, KEM) an Position 2 = Netzanschluss | Pflicht für den Netzwert |
| PIKO CI 30–100 | **nein**, eigene Registerkarte (0x3000ff.), kein Akku |
| PIKO MP plus | **nein**, in keinem Register-Dokument |

## Anschluss

- Modbus TCP, Port **1502** (nicht 502), Unit-ID **71**.
- Anlagenadresse in DVhub = IP des Wechselrichters.
- **Modbus am Gerät freischalten:** im Web-UI des Wechselrichters unter Modbus/SunSpec (TCP) aktivieren (Register
  0x02 = 1). DVhub schreibt dieses Register nicht. Ob das Lesen ohne Freischaltung geht, ist ungeprüft.
- **Byte-Reihenfolge auf der Werkseinstellung lassen:** Register 0x05 = 0 = CDAB („little-endian“). Alle Float-Werte
  im Profil sind so gelesen. Wer für eine andere Software auf ABCD (big-endian) umgestellt hat, bekommt in DVhub
  unsinnige Netz- und PV-Werte.
- **Zählerposition:** Der KOSTAL-Zähler muss am Netzanschluss sitzen (Position 2). Bei Position 1 (Hausverbrauch)
  misst 252 den Verbrauch statt des Netzes.
- KOSTAL empfiehlt eine Zykluszeit über 1 s. DVhub fragt je Takt (Standard 2 s, mindestens 1 s) alle Werte
  nacheinander ab.

## Was gelesen wird

Alle Register FC 03. Float = 2 Register, Low-Wort zuerst (CDAB).

| Wert | Register | Typ | Umrechnung in DVhub | Beleg |
|---|---|---|---|---|
| Netz gesamt | 0xFC = 252 „Total active power (powermeter)“ | Float, W | unverändert (+ = Bezug, − = Einspeisung) | [SPEC] |
| PV gesamt | 0x42A = 1066 „Total DC power (Summe aller PV-Eingänge)“ | Float, W | unverändert | [SPEC]; Schneider Wiser KNX und TapHome lesen PV ebenso aus 1066 [COMM] |
| Akku-Leistung | 0x246 = 582 „Actual battery charge/discharge power“ | S16, W | `sign −1` (Annahme: Rohwert + = Entladen) | Register [SPEC]; Vorzeichen nicht in der Spec, abgeleitet aus KOSTALs sonstiger Zählweise (Akkustrom 0xC8, Anlagen-Akkuleistung 0x60D, Akku-Sollwerte: − = Laden) [ANN] |
| SoC | 0x202 = 514 „Battery actual SOC“ | U16, 1 % | unverändert | [SPEC] |
| Hauslast | — | — | Energiebilanz: PV + Bezug − Einspeisung − Akku | die Spec nennt nur den Anteil aus dem Netz (0x6C) |
| Max. Ladeleistung (vom Akku) | 0x434 = 1076 | Float, W | nur Anzeige, einmal je Minute | [SPEC] |
| Max. Entladeleistung (vom Akku) | 0x436 = 1078 | Float, W | nur Anzeige, einmal je Minute | [SPEC] |

Vorzeichen in DVhub: Netz + = Bezug, Akku + = Laden. Float-NaN gilt als „kein Wert“. Für die beiden
Ganzzahl-Register nennt die Spec keinen solchen Wert; DVhub behandelt vorsorglich SoC 0xFFFF und Akku 0x7FFF/0x8000
(±32 767 W) als „kein Wert“, weil sie als Messwert unmöglich sind.

**Warum 1066 statt 0x64 (100) für PV?** Beide heißen „Total DC power“. 1066 ist ausdrücklich die Summe der
PV-Eingänge. Ob 0x64 bei einem Akku am DC-Eingang 3 die Akkuleistung mitzählt, belegt keine Quelle; dann wäre die
Hauslast aus der Bilanz falsch. Firmware ohne 1066 meldet einen PV-Lesefehler statt eines falschen Werts.

**Warum 514 statt 0xD2 (210) für den SoC?** 514 ist ein Ganzzahl-Register und hängt nicht an der Byte-Reihenfolge.
210 (Float) ist die Gegenprobe im Feldtest.

Quellen (abgerufen 18.11.2026): KOSTAL „Interface description MODBUS (TCP) & SunSpec — PIKO IQ / PLENTICORE
(hybrid), with control information“ Rev. 2.9
([PDF](https://www.kostal-solar-electric.com/fileadmin/downloadcenter/kse/BA/Protokollbeschreibung/BA_KOSTAL_Interface_MODBUS-TCP_SunSpec_with_Control.pdf)),
evcc [kostal-plenticore-gen2.yaml](https://github.com/evcc-io/evcc/blob/master/templates/definition/meter/kostal-plenticore-gen2.yaml)
(Port, Unit, CDAB als Standard), [TapHome](https://taphome.com/en/compatibility/plentycoreinverter/) und
[Schneider Wiser KNX](https://www.productinfo.schneider-electric.com/wiser-knx/0000956364-wiser-knx-aug/English/Wiser_KNX_app_0001139974.xml/$/KOSTALPlenticore-1675FA57)
(PV aus 1066), Zusammenfassung in `.planning/docs/research/2026-11-15-kostal-modbus-control-spec.md` §1–2, §4.

## Was fehlt

| Lücke | Folge | Braucht |
|---|---|---|
| Prüfung der Byte-Reihenfolge (Register 0x05 = 0) | Bei ABCD zeigt DVhub unsinnige Float-Werte, ohne einen Fehler zu melden | Kennungsprobe (E10) |
| Netz je Phase | Phasenwerte bleiben leer; die Spec führt keine Phasenregister auf | — |
| Gesamt-Hauslast als Register | Last kommt aus der Bilanz | — |

## Am Gerät prüfen (Feldtest)

Für den ersten Test zusätzlich `DVHUB_READ_ONLY=1` setzen. Das sperrt jeden Modbus-Write im Prozess, unabhängig vom
Profil.

1. **Byte-Reihenfolge:** Register 5 per Register-Scan lesen, erwartet `0`. Netz und PV müssen plausibel sein (keine
   Werte wie 1e-40 oder 1e+30).
2. **Zählerposition und Netz-Vorzeichen:** Bei Netzbezug muss DVhub Bezug zeigen, bei Einspeisung (mittags, Akku
   voll) Einspeisung. Bleibt das Netz auch beim Einspeisen positiv und folgt dem Hausverbrauch, sitzt der Zähler auf
   Position 1 (Hausverbrauch) — dann bitte melden.
3. **Akku-Vorzeichen:** Akku sichtbar laden lassen. DVhub muss die Akku-Leistung **positiv** zeigen. Ist sie
   negativ, in `/etc/dvhub/hersteller/kostal-plenticore.json` bei `batteryPowerW` die Zeile `"sign": -1` entfernen
   und melden.
4. **PV:** Mit dem Web-UI vergleichen. Meldet DVhub einen PV-Lesefehler, kennt die Firmware Register 1066 nicht;
   dann 100 und 1066 per Scan lesen und melden.
5. **SoC:** 514 mit 210 (Float) und dem Web-UI vergleichen.
6. **PIKO IQ ohne Akku:** Liefert 582 einen Fehler, rechnet DVhub keine Hauslast. Dann `batteryPowerW`, `soc` und
   die beiden Grenzen auf `"enabled": false` stellen und melden.

Register-Scan: `POST /api/meter/scan` mit
`{"host":"<IP>","port":1502,"unitId":71,"fc":3,"start":5,"end":5,"step":1,"quantity":1,"onlyNonZero":false}`,
Ergebnis per `GET /api/meter/scan`. Float-Werte zeigt der Scan als zwei Rohwörter (Low-Wort zuerst).

Ergebnisse bitte an info@bikinibottom.capital.
