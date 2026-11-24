# SolaX X1/X3-Hybrid G4 — nur Anzeige (Beta)

Stand 18.11.2026. Profil `solax-g4` (`dvhub/hersteller/solax-g4.json`).

**Nur Anzeige, keine Steuerung, am Gerät ungeprüft.** Das Profil trägt `"readOnly": true`: DVhub schreibt nichts an
den Wechselrichter. Die Abregelung bleibt aus, auch wenn „Aktive Anlagensteuerung“ eingeschaltet ist. Es ist
`"beta": true` und erscheint nur im Bleeding-Edge-Kanal (`updateChannel: dev`), weil es an keinem Gerät getestet ist.

## Geräte

| Geräte | Passt? |
|---|---|
| X1-Hybrid G4 (1-phasig, 3–7,5 kW), X3-Hybrid G4 (3-phasig, 5–15 kW) | ja |
| Speicher Triple Power T-BAT H 5.8, T-BAT-SYS-HV, T58 | ja (nur Akku-Stapel 1) |
| Zähler am WR-COM (Chint DTSU666 oder Eastron SDM) | Pflicht für den Netzwert |
| X1/X3-Hybrid G3 | wahrscheinlich (evcc liest dieselben Register), ungeprüft |
| G5, X3-Ultra, IES | **nein**, abweichende Registerdetails |
| Geräte mit 3 MPPT (z. B. X3-Ultra) | PV3 fehlt in der Summe |

## Anschluss

- Der Wechselrichter spricht Modbus RTU (RS485 am COM-Port). Empfohlen sind zwei Wege mit Modbus TCP:
  - **RS485-Ethernet-Gateway** (z. B. Waveshare) im Modus **Modbus TCP**, nicht transparent. Baudrate am Gateway
    wie am Wechselrichter (je Firmware 9600 bis 115200, oft 19200 bei G4), 8N1. Bei X3-Hybrid G4 laut Community
    Pin 4 = A, Pin 5 = B.
  - **PocketWiFi 3.0 ab Firmware V3.004.03**, Port 502. Ältere PocketWiFi/PocketLAN können es nicht; neuere
    Dongle-Firmware sperrt den lokalen Zugang teils wieder.
- Ein RS485-Gateway im **Durchreiche-Modus** (transparent, „RTU over TCP“) geht seit E12: im Profil
  (`/etc/dvhub/hersteller/solax-g4.json`) unter `victron` `"framing": "rtu-over-tcp"` und `"port"` = Port des Gateways
  ergänzen. Dann darf nur DVhub am Gateway fragen (keine zweite Verbindung, kein zweiter Master am Bus). Am Gerät
  ungeprüft; Einzelheiten in `docs/HERSTELLERPROFIL-MIGRIEREN.md` §6.
- Unit-ID **1** (Feldberichte nennen auch 15). Anlagenadresse in DVhub = IP des Gateways bzw. des PocketWiFi.
- Modbus muss am Wechselrichter eingeschaltet sein (Installateur-Menü). Zum Lesen ist das Entsperren über Register
  0x00 nicht nötig; DVhub schreibt es nicht.
- **Nur eine Modbus-Verbindung.** Läuft schon Home Assistant oder evcc am selben Gerät, stören sich die Clients.

## Was gelesen wird

Alle Register sind Input-Register (FC 04). 32-bit-Werte Low-Wort zuerst.

| Wert | Register | Typ | Umrechnung in DVhub | Beleg |
|---|---|---|---|---|
| Netz am Anschlusspunkt | 0x46 = 70 `feedin_power` | int32, 1 W | `sign −1` (Gerät: + = Einspeisung) | [SPEC] „positiv = Einspeisung“; evcc `int32s`, `scale −1` [COMM] |
| PV | 0x0A + 0x0B = 10 + 11 `Powerdc1/2` | je U16, 1 W | summiert | [SPEC], evcc ebenso |
| Akku-Leistung | 0x16 = 22 `Batpower_Charge1` | int16, 1 W | unverändert (Annahme: + = Laden) | Register [SPEC], [DECOMP]; Vorzeichen [COMM] evcc `scale −1` bei + = Entladen; Spec nennt die Richtung nur über 0x19 |
| SoC | 0x1C = 28 `Battery Capacity` | U16, 1 % | unverändert | [SPEC], [DECOMP], evcc ebenso |
| Hauslast | — | — | Energiebilanz: PV + Bezug − Einspeisung − Akku | kein Lastregister in der Spec |
| Max. Ladestrom (BMS) | 0x24 = 36 | U16, 0,1 A | `scale 0.1`, nur Anzeige, einmal je Minute | [SPEC] |
| Max. Entladestrom (BMS) | 0x25 = 37 | U16, 0,1 A | `scale 0.1`, nur Anzeige, einmal je Minute | [SPEC] |

Vorzeichen in DVhub: Netz + = Bezug, Akku + = Laden. Für „kein Wert“ nennt die Spec keinen Sentinel; DVhub
behandelt vorsorglich die Extremwerte jedes Typs (int32 0x7FFFFFFF/0x80000000, int16 0x7FFF/0x8000, U16 0xFFFF)
als „kein Wert“, weil sie als Messwert unmöglich sind.

Quellen (abgerufen 18.11.2026): SolaX „Hybrid-X1X3-G4-ModbusTCP/RTU“ V3.21 (06/2022, public version,
[PDF](https://www.gbc-solino.cz/files/uploads/FAQ%20SolaX/Hybrid-X1X3-G4-ModbusTCPRTU-V3.21-English_0622-public-version.pdf)),
evcc [solax.yaml](https://github.com/evcc-io/evcc/blob/master/templates/definition/meter/solax.yaml), Zusammenfassung in
`.planning/docs/research/2026-11-15-solax-modbus-control-spec.md` §1, §3.

## Was fehlt

| Lücke | Folge | Braucht |
|---|---|---|
| Richtungs-Flag 0x19 `BDCStatus` (0 = Entladen, 1 = Laden) | DVhub liest 0x16 als vorzeichenbehafteten Wert (wie evcc). Liefert ein Gerät nur Beträge, erscheint Entladen als Laden | E8 (`direction`) gibt es; bewusst nicht eingeschaltet, weil keine Integration 0x19 nutzt und unbelegt ist, ob es im Ruhezustand weitere Werte meldet (dann wären Akku und Hauslast leer). Nach dem Gerätetest einschalten |
| PV3 0x124 (3 MPPT) | PV zu niedrig auf 3-MPPT-Geräten. Ins Profil genommen, legte ein fehlendes Register auf 2-MPPT-Geräten die ganze PV lahm | ginge heute per `combine`, je Gerät nach Test |
| Zweiter Akku-Stapel (0x129/0x12D) | zweiter Akku fehlt | eigener Punkt bzw. `combine` |
| Netz je Phase | Phasenwerte bleiben leer; 0x70–0x75 sind WR-Werte, nicht der Zähler | — |
| Gerätekennung/Generation | DVhub prüft nicht, ob ein G4 antwortet | Kennungsprobe (E10) |
| RS485 direkt (serielle Schnittstelle am DVhub-Gerät) | geht nicht, nur über ein Gateway | — |

## Am Gerät prüfen (Feldtest)

Für den ersten Test zusätzlich `DVHUB_READ_ONLY=1` setzen. Das sperrt jeden Modbus-Write im Prozess, unabhängig vom
Profil.

1. **Verbindung und Unit-ID:** Antwortet nichts, Unit-ID 15 probieren (`victron.unitId` in
   `/etc/dvhub/hersteller/solax-g4.json`) und die Baudrate am Gateway prüfen.
2. **Netz-Vorzeichen:** Bei Netzbezug muss DVhub Bezug zeigen. Mit dem Zähler bzw. der SolaxCloud-App vergleichen.
   Zeigt DVhub Einspeisung, bei `meter` die Zeile `"sign": -1` entfernen und melden.
3. **Akku-Vorzeichen:** Akku sichtbar laden lassen, dann entladen lassen. Laden muss **positiv**, Entladen
   **negativ** erscheinen. Laden negativ: bei `batteryPowerW` `"sign": -1` ergänzen. Beide positiv: das Gerät
   liefert nur Beträge — bei `batteryPowerW` `"direction": { "address": 25, "values": { "0": -1, "1": 1 } }`
   ergänzen (Vorzeichen aus BDCStatus 0x19) und melden. Vorher 0x19 per Register-Scan beim Laden, Entladen und im
   Ruhezustand lesen: nur 0 und 1 dürfen vorkommen.
4. **PV:** Summe mit der App vergleichen. Bei 3 MPPT fehlt PV3.
5. **Hauslast:** Die abgeleitete Last mit der App vergleichen. Abweichungen um die Wandlerverluste (einige
   Prozent) sind erwartet.

Register-Scan: `POST /api/meter/scan` mit
`{"host":"<IP>","port":502,"unitId":1,"fc":4,"start":22,"end":25,"step":1,"quantity":1,"onlyNonZero":false}`
(0x16–0x19: Akku-Leistung, BMS-Status, Temperatur, Richtung), Ergebnis per `GET /api/meter/scan`.
**Achtung:** Der Scan öffnet eine zweite Verbindung und kann DVhubs Sitzung kurz stören.

Ergebnisse bitte an info@bikinibottom.capital.
