# FoxESS H1/AC1 — nur Anzeige (Beta)

Stand 18.11.2026. Herstellerprofil `foxess-h1` **nur zum Lesen**.

**Nur Anzeige, keine Steuerung, am Gerät ungeprüft.** Das Profil trägt `"readOnly": true`: DVhub schreibt nichts an
den Wechselrichter. Die Abregelung bleibt aus, auch wenn „Aktive Anlagensteuerung“ eingeschaltet ist. Das Profil ist
`"beta": true` und erscheint nur im Bleeding-Edge-Kanal (`updateChannel: dev`), weil es an keinem Gerät getestet ist.

## Geräte

FoxESS legt die Register je **Modell und Firmware** an verschiedene Stellen. Darum trägt das Profil die Familie im
Namen.

| Familie | Passt `foxess-h1`? | Grund |
|---|---|---|
| H1, AIO-H1, AC1 der ersten Generation bzw. mit LAN-Anschluss (foxess_modbus: H1_G1, H1_LAN) | ja | Holding-Block 31000 |
| H1 G2 (H1_G2_SET) | nur teilweise | Netz, Last, Akku, SoC gleich; PV liegt an 39280/39282 → PV falsch oder 0 |
| KH | nein | Netz-CT mit umgekehrtem Vorzeichen, weitere PV-Register |
| H3, AIO-H3, H3 Pro/Smart (3-phasig) | nein | andere Register (31036/31038 bzw. 39xxx) |

Für H1 G2, KH und H3 braucht es eigene Profile. AC1 hat keine PV-Eingänge; dort zeigt DVhub 0 W PV.

## Anschluss

- Am Wechselrichter: RS485 (COM-Port), 9600 8N1, **Slave-ID 247** (Standard bei evcc und foxess_modbus; manche
  Installationen nutzen 1).
- DVhub spricht nur Modbus TCP:
  - über den **LAN-Anschluss** des Wechselrichters bzw. neuere Dongles, die Modbus TCP auf Port 502 anbieten, oder
  - über ein **RS485-Ethernet-Gateway** (z. B. Waveshare, Elfin-EW11) im Modus **Modbus TCP**, Port 502.
- Der FoxESS-Cloud-Dongle belegt den COM-Port. Für RS485 muss er ab.
- In DVhub ist die Anlagenadresse die IP des Wechselrichters bzw. Gateways.
- Lesen mit Funktionscode 3 (Holding-Register), alle Werte 16 bit. „0,001 kW“ heißt 1 W.

## Was gelesen wird

| Wert | Register | Typ | Vorzeichen am Gerät | Im Profil | Beleg |
|---|---|---|---|---|---|
| Netz | 31014 „Grid CT“ | I16, 1 W | + = Einspeisung, − = Bezug | gedreht (`sign: -1`) | [COMM] foxess_modbus; Plexlog; **strittig** |
| PV | 31002 + 31005 (PV1 + PV2) | I16, 1 W | — | Summe (`combine`) | Spec §2.1; [COMM]; Plexlog |
| Akku-Leistung | 31022 | I16, 1 W | + = Entladen, − = Laden | gedreht (`sign: -1`) | Spec §2.1; [COMM]; Plexlog |
| SoC | 31024 | U16, % | — | — | Spec §2.1; [COMM] |
| Hauslast | 31016 „Load power“ | I16, 1 W | — | — | Spec §2.1; [COMM] |

Belege:
- **[COMM]** nathanmarlor/foxess_modbus (`entity_descriptions.py`): `grid_ct` 31014 mit dem Kommentar „Negative =
  import“, „Feed-in“ = positiver Teil; `invbatpower` 31022, „Battery discharge“ = positiver Teil; `load_power` 31016;
  `pv1_power`/`pv2_power` 31002/31005; `battery_soc` 31024.
- **Plexlog** FoxESS-Treiber (nur gelesen): Netz = 31014 × −1 in der Plexlog-Konvention „+ = Bezug“, Akku 31022
  unverändert in „+ = Entladen“.
- **Spec** `.planning/docs/research/2026-11-15-foxess-modbus-control-spec.md` §2.1 (aus Community-Quellen).

**Netz-Vorzeichen (strittig):** Die Spec und die Lücken-Analyse nennen für 31014 „+ = Bezug“. foxess_modbus und
Plexlog lesen das Register übereinstimmend als „+ = Einspeisung“; nur KH-Geräte melden es umgekehrt. Das Profil folgt
foxess_modbus und Plexlog. Die offizielle FoxESS „Modbus definition“ V1.05 (nur im FoxESS-Forum) ist nicht
gegengelesen.

**PV:** Kleine negative Werte (nachts einige Watt) zeigt DVhub so an; foxess_modbus und Plexlog setzen sie auf 0.

## Was fehlt

| Lücke | Folge | Braucht |
|---|---|---|
| Modell-/Firmware-Erkennung | DVhub prüft nicht, welche FoxESS-Karte antwortet; ein falsches Profil liefert falsche Werte | Kennungsprobe (E10) |
| H1 G1 über RS485 mit Input-Block 11000 (FC 4) | falls das Gerät den Block 31000 am RS485 nicht beantwortet, keine Werte | eigenes Profil (Netz 11021, Akku 11008, SoC 11036, Last 11023, PV 11002/11005) |
| Lade-/Entladestromgrenzen 41007/41008 | nicht gelesen; nur in foxess_modbus belegt, nicht in der Spec | Gerätetest |
| H1 G2, KH, H3 | nicht abgedeckt | eigene Profile |

## Am Gerät prüfen (Feldtest)

Für den ersten Test zusätzlich `DVHUB_READ_ONLY=1` setzen. Das sperrt jeden Modbus-Write im Prozess, unabhängig vom
Profil.

1. **Erreichbarkeit und Slave-ID:** Mit dem Register-Scan der Diagnose-Seite (oder `POST /api/meter/scan`) lesen:
   Host = IP, Unit-ID 247, FC 3, Start = Ende = 31024, Menge 1. Erwartet: der SoC in %. Kommt ein Fehler, mit
   Unit-ID 1 wiederholen; antwortet nur Unit 1, im Profil `victron.unitId` auf 1 stellen und melden.
2. **Netz-Vorzeichen (wichtigster Punkt):** Bei Bezug muss DVhub das Netz **positiv** zeigen. Mit dem Netzzähler
   vergleichen. Ist es umgekehrt, `meter.sign` im Profil entfernen und melden (dann stimmt die Spec).
3. **Akku-Vorzeichen:** Akku laden lassen → DVhub muss die Akku-Leistung **positiv** zeigen.
4. **PV:** mit der FoxESS-App vergleichen. Zeigt DVhub 0 W bei Sonne, ist es vermutlich ein H1 G2 (PV an 39280/39282).
5. **Hauslast:** 31016 mit der App vergleichen.

Ergebnisse bitte an info@bikinibottom.capital.
