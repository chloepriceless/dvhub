# E3/DC S10 — nur Anzeige (Beta)

Stand 18.11.2026. Herstellerprofil `e3dc` **nur zum Lesen**.

**Nur Anzeige, keine Steuerung, am Gerät ungeprüft.** Das Profil trägt `"readOnly": true`: DVhub schreibt nichts an
das Hauskraftwerk. Die Abregelung bleibt aus, auch wenn „Aktive Anlagensteuerung“ eingeschaltet ist. Das Profil ist
`"beta": true` und erscheint nur im Bleeding-Edge-Kanal (`updateChannel: dev`), weil es an keinem Gerät getestet ist.

## Geräte

E3/DC Hauskraftwerk S10 E, S10 E Compact, S10 E AIO, S10 X, S10 X Compact, S10 Mini, S10 Pro, S10 Pro Compact. Alle
nutzen dieselbe EMS-Plattform und dieselbe Modbus-Karte „E3/DC Simple-Mode“.

Steuern ginge bei E3/DC nur über das eigene Protokoll RSCP (TCP 5033, verschlüsselt, Portal-Login). Das kann DVhub
nicht; für das Lesen braucht man es nicht.

## Anschluss

- Modbus TCP direkt am Hauskraftwerk, **Port 502**, **Unit-ID 1**, Funktionscode 3. Kein Gateway nötig.
- Modbus ist **ab Werk aus**. Am Gerät: Hauptmenü > Funktionen > Funktion Modbus einschalten und als Protokoll
  **„E3/DC Simple-Mode“** wählen. Im „SunSpec-Mode“ liegen andere Register an; dann liest dieses Profil Unsinn.
- In DVhub ist die Anlagenadresse die IP des Hauskraftwerks.
- Die Schnittstelle hat keine Anmeldung. Nur im Hausnetz betreiben, nie ins Internet freigeben.

## Was gelesen wird

Die E3/DC-Doku zählt Register ab 40001. Auf dem Draht ist jede Adresse **um 1 kleiner** (Dok. 40068 = Draht 40067).
32-bit-Werte liegen mit dem **Low-Wort zuerst** (`wordOrder: le`), obwohl die Doku „Big Endian“ schreibt. Das gilt nur
für die Bytes innerhalb eines Registers.

| Wert | Dok.-Register | Draht | Typ | Vorzeichen | Beleg |
|---|---|---|---|---|---|
| Netz | 40074 | 40073 | Int32 W, Low-Wort zuerst | − = Einspeisung → + = Bezug, unverändert | [SPEC] V1.6 |
| PV | 40068 | 40067 | Int32 W, Low-Wort zuerst | — | [SPEC] |
| Akku-Leistung | 40070 | 40069 | Int32 W, Low-Wort zuerst | − = Entladen → + = Laden, unverändert | [SPEC] |
| SoC | 40083 | 40082 | UInt16 % | — | [SPEC] |
| Hauslast | 40072 | 40071 | Int32 W, Low-Wort zuerst | — | [SPEC] |

Belege:
- **[SPEC]** E3/DC „Kurzanleitung Modbus/TCP-Schnittstelle“ V1.6 (2017-04-10): Register, Typen, Vorzeichen.
- **Registerbasis −1 und Wortreihenfolge:** der Plexlog-E3DC-Treiber (Offset −1, „MixEndian“ = erstes Register ist
  das Low-Wort; nur gelesen, kein Code übernommen) und die openHAB-Bindung `modbus.e3dc` (`POWER_REG_START = 67`,
  „from the documented registers subtract 1“, Dekodierung `getSInt32Swap`). Die Community-Stolperfalle „SoC an
  40082 statt 40083“ ist dieselbe Verschiebung um 1.

Die Netzphasen L1–L3 bleiben leer: Der Simple-Mode hat keine Phasenleistungen am Netzpunkt.

**Kennungsprobe:** DVhub liest vor dem ersten Wert und danach alle 10 Minuten Draht 40000 (Dok. 40001, laut
Herstellerdoku „immer 0xE3DC“). Steht dort etwas anderes — etwa „SunS“, wenn am Gerät der SunSpec-Mode gewählt ist,
oder ein Nachbarregister bei anderer Registerbasis —, zeigt DVhub Netz, PV, Akku, Ladestand und Hauslast nicht an und
nennt den Grund als Hinweis im Leitstand (Log `identity_probe_mismatch`). Ist 40000 nicht lesbar, zeigt DVhub die
Werte ungeprüft an und sagt das ebenfalls.

## Was fehlt

| Lücke | Folge | Braucht |
|---|---|---|
| Zusätzliche Einspeiser (Dok. 40076) | Leistung eines weiteren PV-Wechselrichters am E3/DC fehlt in der PV-Anzeige; Vorzeichen in der Community uneinheitlich | Gerätetest, dann `combine` |
| Wallbox (Dok. 40078/40080) | nicht gelesen | — |
| Lade-/Entladegrenzen | nur über RSCP verfügbar | neuer Transport |

## Am Gerät prüfen (Feldtest)

Für den ersten Test zusätzlich `DVHUB_READ_ONLY=1` setzen. Das sperrt jeden Modbus-Write im Prozess, unabhängig vom
Profil.

1. **Kennung und Registerbasis:** Zeigt der Leitstand den Hinweis „Kennungsprobe passt nicht“ oder „nicht lesbar“,
   mit dem Register-Scan der Diagnose-Seite (oder `POST /api/meter/scan`) lesen: Host =
   IP des Hauskraftwerks, Unit-ID 1, FC 3, Start = Ende = 40000, Menge 1. Erwartet: `58332` (= 0xE3DC).
   - Steht der Wert bei 40001 statt 40000, sind alle Adressen im Profil um 1 zu klein.
   - Kommt bei 40000 und 40001 ein Fehler, aber bei Adresse 0 der Wert 58332, zählt dieses Gerät ab 0. Dann gehören
     40000 von jeder Profiladresse abgezogen (openHAB liest so).
2. **Wortreihenfolge:** Bei Sonne die PV-Leistung mit der E3/DC-App vergleichen. Zeigt DVhub Millionen Watt oder
   Unsinn, stimmt `wordOrder` nicht (`le` → `be`).
3. **Akku-Vorzeichen:** Akku laden lassen. DVhub muss die Akku-Leistung **positiv** zeigen.
4. **Netz:** Bezug muss positiv erscheinen. Mit dem Netzzähler oder der App vergleichen.
5. **Hauslast:** mit der App vergleichen, dabei notieren, ob eine E3/DC-Wallbox lädt (enthält 40072 die Wallbox?).
6. **Zusätzlicher Einspeiser:** Hat die Anlage einen weiteren PV-Wechselrichter, Dok. 40076 (Draht 40075, Menge 2)
   per Scan lesen und das Vorzeichen notieren.

Ergebnisse bitte an info@bikinibottom.capital.
