# Solis Hybrid — nur Anzeige (Beta)

Stand 18.11.2026. Herstellerprofil `solis` **nur zum Lesen**.

**Nur Anzeige, keine Steuerung, am Gerät ungeprüft.** Das Profil trägt `"readOnly": true`: DVhub schreibt nichts an
den Wechselrichter. Die Abregelung bleibt aus, auch wenn „Aktive Anlagensteuerung“ eingeschaltet ist. Das Profil ist
`"beta": true` und erscheint nur im Bleeding-Edge-Kanal (`updateChannel: dev`), weil es an keinem Gerät getestet ist.

## Geräte

Solis-Hybrid-Wechselrichter (Ginlong) mit der Registerkarte ab 33000: S5-EH1P, S6-EH1P, S6-EH3P und die RHI-Serie.
Reine String-Wechselrichter (S5-GR, Mini) nutzen eine andere Karte (3000 ff.) und sind nicht abgedeckt.

## Anschluss

- Am Wechselrichter: RS485 (COM-Port), 9600 8N1, Slave-ID 1 (am Gerät 1–99 einstellbar).
- DVhub spricht nur Modbus TCP. Zwei Wege:
  - **RS485-Ethernet-Gateway** (z. B. Waveshare RS485 TO ETH) im Modus **Modbus TCP**, Port 502. Empfohlen.
  - **Solis-Datenlogger**, der Modbus TCP spricht: laut Community der S2-WL-ST auf Port 502. Ob der DLS-LAN-Stick auf
    Port 8899 rohes Modbus TCP spricht, ist ungeprüft. Der S3-WIFI-ST geht laut Community nicht.
- Ein Solarman-WLAN-Stick (V5-Protokoll) und ein transparentes RTU-Gateway gehen nicht.
- In DVhub ist die Anlagenadresse die IP des Gateways bzw. Datenloggers.
- Alle Werte sind Input-Register (Funktionscode 4). 32-bit-Werte liegen mit dem High-Wort zuerst.

## Was gelesen wird

| Wert | Register | Typ | Vorzeichen | Beleg |
|---|---|---|---|---|
| Netz | 33130–33131 | S32, 1 W | + = Export → im Profil gedreht (`sign: -1`) | [SPEC] 2018; solis-modbus |
| Netz je Phase | 33257/33259/33261 | S32, 1 W | + = Export → gedreht | [COMM] evcc, nur neuere Firmware |
| PV | 33057–33058 | U32, 1 W | — | [SPEC]; evcc |
| Akku-Leistung | 33149–33150 | S32, 1 W | **strittig**, Profil: + = Laden (wie evcc) | [SPEC] „mit 33135“; [COMM] evcc |
| SoC | 33139 | U16, % | — | [SPEC]; evcc |
| Hauslast | 33147 | U16, 1 W | — | [SPEC] |
| BMS-Ladestromgrenze | 33143 | U16, 0,1 A | — | [SPEC]; solis-modbus |
| BMS-Entladestromgrenze | 33144 | U16, 0,1 A | — | [SPEC]; solis-modbus |

Belege:
- **[SPEC]** Solis „RS485_MODBUS RTU energy storage grid-connected inverter communication protocol“ (Hybrid, 2018-11).
- **[COMM]** evcc `solis-hybrid.yaml`, solis-modbus (Registerliste), Plexlog-Solis-Treiber (nur gelesen).

**Netz:** Die Herstellerdoku 2018 kennt nur 33130. Neuere Firmware hat zusätzlich den Zählerblock 33250 ff. mit der
Summe 33263 und den Phasen; evcc und Plexlog lesen die Summe dort. Das Profil nimmt 33130, weil es auf alter und neuer
Firmware vorhanden ist, und liest die Phasen aus dem neuen Block. Fehlt der Block, bleiben L1–L3 leer und die Summe
gilt.

**Akku-Vorzeichen (strittig):** Die Herstellerdoku sagt „Vorzeichen mit 33135“ (0 = Laden, 1 = Entladen). evcc liest
33149 trotzdem als vorzeichenbehafteten Wert (Laden positiv). solis-modbus und Plexlog nehmen das Vorzeichen aus 33135.
DVhub kann ein Richtungsregister nicht anwenden (E8). Das Profil folgt evcc. Liefert das Gerät nur den Betrag, zeigt
DVhub das Entladen als Laden.

## Was fehlt

| Lücke | Folge | Braucht |
|---|---|---|
| Vorzeichen aus 33135 | falls 33149 nur der Betrag ist, falsches Akku-Vorzeichen beim Entladen | Richtungsregister (E8) |
| Modelltyp 33000 | DVhub prüft nicht, ob ein Solis-Hybrid antwortet | Kennungsprobe (E10) |
| Backup-Last 33148 | nicht gelesen | — |
| Solarman-V5 / transparentes Gateway | geht nicht | Transport (E12) |

## Am Gerät prüfen (Feldtest)

Für den ersten Test zusätzlich `DVHUB_READ_ONLY=1` setzen. Das sperrt jeden Modbus-Write im Prozess, unabhängig vom
Profil.

1. **Akku-Vorzeichen (wichtigster Punkt):** Akku laden lassen → DVhub muss die Akku-Leistung **positiv** zeigen. Dann
   entladen lassen → **negativ**. Bleibt sie beim Entladen positiv, ist 33149 nur der Betrag; bitte melden.
   Gegenprobe mit dem Register-Scan der Diagnose-Seite (oder `POST /api/meter/scan`): Host = IP des Gateways,
   Unit-ID 1, **FC 4**, Start = Ende = 33149, Menge 2; dazu 33135 (Menge 1).
2. **Netz:** Bezug muss positiv erscheinen. Mit dem Netzzähler vergleichen. Per Scan 33130 und 33263 (je Menge 2)
   lesen und notieren, ob beide gleich sind.
3. **Phasen:** Erscheinen L1–L3 leer, kennt die Firmware den Block 33250 ff. nicht (Log `meter_phase_read_error`).
4. **Lesefehler:** DVhub hält 400 ms zwischen zwei Anfragen (Solis verlangt laut Community > 300 ms;
   `victron.requestPacing.minRequestGapMs`). Kommen im Log trotzdem regelmäßig Zeitüberschreitungen, den Wert in
   `/etc/dvhub/hersteller/solis.json` testweise auf 1000 stellen und melden.
5. **Hauslast:** mit der Solis-App vergleichen, dabei Backup-Verbraucher an- und abschalten.
6. **BMS-Grenzen:** mit dem Display vergleichen (bei Hochvolt-Akkus S6-EH3P besonders).

Ergebnisse bitte an info@bikinibottom.capital.
