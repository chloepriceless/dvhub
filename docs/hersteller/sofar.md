# SOFAR HYD — nur Anzeige (Beta)

Stand 18.11.2026. Herstellerprofil `sofar` **nur zum Lesen**.

**Nur Anzeige, keine Steuerung, am Gerät ungeprüft.** Das Profil trägt `"readOnly": true`: DVhub schreibt nichts an
den Wechselrichter. Die Abregelung bleibt aus, auch wenn „Aktive Anlagensteuerung“ eingeschaltet ist. Das Profil ist
`"beta": true` und erscheint nur im Bleeding-Edge-Kanal (`updateChannel: dev`), weil es an keinem Gerät getestet ist.

## Geräte

SOFAR-Hybrid-Wechselrichter mit der Registerkarte **„SOFAR Modbus Protocol – General“** (Register ab 0x0400):
HYD 5…20K-3PH, HYD 3…6K-EP, HYD-KTL-3PH/-PRO.

**Nicht abgedeckt:** ME3000SP und HYD 3…6K-ES. Sie nutzen eine ältere Karte (ab 0x0200) und teils den Funktionscode
0x42, den DVhub nicht kennt. Woran man die Karte erkennt, steht unten im Feldtest.

## Anschluss

- Am Wechselrichter: RS485, 9600 8N1, Slave-ID 1.
- Empfohlen: **RS485-Ethernet-Gateway** (z. B. Waveshare RS485 TO ETH) im Modus **Modbus TCP**,
  Port 502. In DVhub ist die Anlagenadresse die IP des Gateways.
- Ein Solarman-WLAN-Stick (V5-Protokoll) geht nicht. Laut Community sperrt er teils auch Funktionscodes.
- Ein RS485-Gateway im **Durchreiche-Modus** (transparent, „RTU over TCP“) geht seit E12: im Profil
  (`/etc/dvhub/hersteller/sofar.json`) unter `victron` `"framing": "rtu-over-tcp"` und `"port"` = Port des Gateways
  ergänzen. Dann darf nur DVhub am Gateway fragen (keine zweite Verbindung, kein zweiter Master am Bus). Am Gerät
  ungeprüft; Einzelheiten in `docs/HERSTELLERPROFIL-MIGRIEREN.md` §6.
- Lesen mit Funktionscode 3, alle Werte 16 bit.

## Was gelesen wird

Leistungen meldet SOFAR in 0,01 kW. Das Profil rechnet mit `scale: 10` in Watt um.

| Wert | Register | Typ | Vorzeichen | Beleg |
|---|---|---|---|---|
| Netz | 0x0488 (1160) | I16, 0,01 kW | + = Einspeisung → im Profil gedreht (`sign: -1`) | [SPEC]; Plexlog × −10 |
| Netz je Phase | 0x0493 / 0x049E / 0x04A9 | I16, 0,01 kW | wie die Summe angenommen | [SPEC]; [COMM] |
| PV | 0x0586 + 0x0589 (PV1 + PV2) | U16, 0,01 kW | — | [SPEC]; Plexlog × 10 |
| Akku-Leistung | 0x0606 (Akku 1) | I16, 0,01 kW | + = Laden, unverändert | [SPEC] |
| SoC | 0x0608 (Akku 1) | U16, % | — | [SPEC] |
| Hauslast | 0x04AF (1199) | U16, 0,01 kW | — | [SPEC]; [COMM] „Active Power Load Sys“ |
| Max. Ladestrom | 0x104B (4171) | U16, 0,01 A | — | [SPEC] Installateur-Wert; [COMM] |
| Max. Entladestrom | 0x104C (4172) | U16, 0,01 A | — | [SPEC] Installateur-Wert; [COMM] |

Belege:
- **[SPEC]** SOFAR „Modbus Protocol – General, valid for HYD 5…20K-3PH and HYD3…6K-EP“ (Stand 23.11.2020).
- **Plexlog** SOFAR-Treiber (nur gelesen): liest 0x0488 × −10, PV1 0x0586 × 10, PV2 0x0589 × 10.
- **[COMM]** wills106 `solax_modbus` (`plugin_sofar.py`).

Hinweise:
- **PV** kommt aus zwei getrennten Registern (`combine`). Die Gesamt-PV 0x05C4 hat nur 0,1 kW Auflösung und ist in der
  Herstellerkarte nicht bestätigt.
- **Hauslast** ist 0x04AF. 0x0504 ist laut Community die Off-Grid-/EPS-Leistung, nicht die Hauslast.
- **Akku:** Das Profil liest Akku 1. 0x0485/0x0487 haben in der Herstellerkarte widersprüchliche Vorzeichen und werden
  nicht verwendet.
- **Stromgrenzen** sind die am Wechselrichter eingestellten Werte, keine Live-Grenzen des BMS. DVhub zeigt sie nur an.

## Was fehlt

| Lücke | Folge | Braucht |
|---|---|---|
| PV3 und folgende (0x058C ff.) | bei Geräten mit mehr als 2 MPPT fehlt PV; ein fehlendes Register ließe die ganze PV-Summe ausfallen | Adressmaske lesen (E10) |
| Akku 2 ff. (0x060D ff.) bzw. Akku gesamt 0x0667/0x0668 | bei mehreren Akku-Eingängen fehlen die weiteren in Leistung und SoC | Gerätetest, dann ggf. 0x0667/0x0668 |
| Kartenerkennung / Adressmasken | DVhub prüft nicht, ob die Karte „General“ antwortet | Kennungsprobe (E10) |
| Legacy-Karte (ME3000SP, HYD-ES) | nicht unterstützt | eigenes Profil, ggf. FC 0x42 |
| Solarman-V5 | geht nicht | eigener Transport (Solarman V5) |

## Am Gerät prüfen (Feldtest)

Für den ersten Test zusätzlich `DVHUB_READ_ONLY=1` setzen. Das sperrt jeden Modbus-Write im Prozess, unabhängig vom
Profil.

1. **Karte:** Mit dem Register-Scan der Diagnose-Seite (oder `POST /api/meter/scan`) lesen: Host = IP des Gateways,
   Unit-ID 1, FC 3, Start = Ende = 1028 (0x0404), Menge 1. Ein Wert 0–7 (SysState, 2 = am Netz) heißt: Karte
   „General“. Kommt ein Fehler, ist es vermutlich die Legacy-Karte; dann passt dieses Profil nicht.
2. **Netz:** Bezug muss positiv erscheinen. Mit dem Netzzähler vergleichen, auch die Phasen.
3. **Akku-Vorzeichen:** Akku laden lassen → DVhub muss die Akku-Leistung **positiv** zeigen.
4. **Mehrere Akkus:** Hat das Gerät mehr als einen Akku-Eingang belegt, per Scan 1639–1641 (0x0667–0x0669) lesen
   und mit 0x0606/0x0608 vergleichen. Bitte melden, dann stellt das Profil auf die Gesamtwerte um.
5. **PV:** Mit dem Display vergleichen. Hat das Gerät mehr als 2 MPPT, fehlt deren Leistung.
6. **Hauslast:** 0x04AF mit der Last im Display vergleichen.

Ergebnisse bitte an info@bikinibottom.capital.
