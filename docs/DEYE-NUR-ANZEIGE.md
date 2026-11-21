# Deye HP3 und LP1 — nur Anzeige (Beta)

Stand 18.11.2026. Zwei Herstellerprofile **nur zum Lesen**:

| Profil | Geräte | Registerkarte |
|---|---|---|
| `deye-hp3` | SUN-5K…50K-SG01HP3 (Hochvolt-Akku, 3-phasig) | 3-phasig, Deye-Protokoll V105 (Hersteller) |
| `deye-lp1` | SUN-…K-SG01/03/04/05LP1 (48-V-Akku, 1-phasig), baugleich Sunsynk | 1-phasig, nur Community-Quellen |

**Nur Anzeige, keine Steuerung, am Gerät ungeprüft.** Die Profile tragen `"readOnly": true`: DVhub schreibt nichts
an den Wechselrichter. Die Abregelung bleibt aus, auch wenn „Aktive Anlagensteuerung“ eingeschaltet ist. Beide
Profile sind `"beta": true` und erscheinen nur im Bleeding-Edge-Kanal (`updateChannel: dev`), weil sie an keinem
Gerät getestet sind. Für Deye LP3 (Niedervolt, 3-phasig) gibt es das bestehende Profil `deye-lv`.

## Anschluss

Wie bei `deye-lv`: RS485-Ethernet-Gateway (z. B. Waveshare RS485 TO ETH) am Port „Modbus/COM“ des Wechselrichters,
9600 8N1, Slave-ID 1, Gateway im Modus **Modbus TCP**. In DVhub ist die Anlagenadresse die IP des Gateways.
Ein WLAN-Logger (Solarman-V5) geht nicht.

## Was gelesen wird

| Wert | HP3 | LP1 |
|---|---|---|
| Netz | 622–624 je Phase, S16, 1 W | 169, S16, 1 W |
| PV | 672–675 (MPPT 1–4) summiert, U16, **10 W** | 186–189 (MPPT 1–4) summiert, U16, 1 W |
| Akku-Leistung | 590, S16, **10 W**, Vorzeichen gedreht (`scale -10`) | 190, S16, 1 W, Vorzeichen gedreht (`scale -1`) |
| SoC | 588, 1 % | 184, 1 % |
| Hauslast | 653, S16, 1 W | 178, S16, 1 W |

Belege:
- **HP3:** Deye-Protokoll V105 (Hersteller), gegengelesen mit evcc `deye-hybrid-3p` und kellerza/sunsynk.
- **LP1:** nur Community (kellerza/sunsynk `single_phase.py`, evcc `deye-storage`). Das in der Deye-Spec verlinkte
  1-phasige „Hybrid Inverter Protocol (Without Control)“ ist ein Ginlong/Solis-Dokument, kein Deye-Protokoll.

**Netz bei HP3:** 622–624 „folgen der Einstellung intern/extern“ (V105). Das ist der Wert, mit dem der
Wechselrichter selbst regelt, und auch evcc und kellerza lesen ihn. 616–618 wäre nur der externe CT und zeigt ohne
externen CT 0 W.

**Netz bei LP1:** 169 ist der Wert, den evcc und kellerza als Netzleistung lesen. Er misst am Netzanschluss des
Wechselrichters. Hängen Verbraucher zwischen externem CT und Wechselrichter, fehlen sie darin. Dann wäre
172 (externer CT) richtig; der zeigt ohne CT aber 0 W.

## Was fehlt

| Lücke | Folge | Braucht |
|---|---|---|
| HP3 PV5–PV8 (727–730) | Bei HP3 mit mehr als 4 MPPT (20–50 kW) ist die PV-Leistung zu niedrig | Summe getrennter Register (E4) |
| HP3 Akku 2 (589/595) | Zweiter Akku fehlt in SoC und Leistung | E4 |
| High-Words 659 (Last), 687–689 (Netz) | Hauslast über 32 767 W falsch (nur 50-kW-Geräte); Netz je Phase bis ±32 767 W reicht | geteilte 32-bit-Register (E9) |
| BMS-Grenzen (HP3 212/213, LP1 314/315) | Keine Lade-/Entladegrenzen in DVhub | Lesepunkte für Gerätegrenzen (E13) |
| Gerätetyp Register 0 | DVhub prüft nicht, ob das gewählte Profil zum Gerät passt | Kennungsprobe (E10) |

## Am Gerät prüfen (Feldtest)

Für den ersten Test zusätzlich `DVHUB_READ_ONLY=1` setzen. Das sperrt jeden Modbus-Write im Prozess, unabhängig vom
Profil.

1. **Gerätetyp:** Register 0 mit dem Register-Scan der Diagnose-Seite lesen (oder `POST /api/meter/scan`): Host =
   IP des Gateways, Unit-ID 1, FC 3, Start = Ende = 0, Menge 1, „nur Werte ≠ 0“ aus. Die Vorgaben des Scans
   (Unit-ID 0, FC 4) passen nicht zu Deye. Erwartet: `0x0600`/`0x0601` (= 1536/1537) für HP3, `0x0300` (= 768) für
   LP1. Sonst ist das Profil falsch.
2. **Akku-Vorzeichen:** Akku sichtbar laden lassen (Display/App). DVhub muss die Akku-Leistung **positiv** zeigen.
   Ist sie negativ, `scale` in `/etc/dvhub/hersteller/deye-hp3.json` auf `10` (LP1: `1`) stellen und melden.
3. **HV-Skala (HP3):** PV- und Akku-Leistung mit dem Display vergleichen. Zeigt DVhub ein Zehntel oder das
   Zehnfache, stimmt die 10-W-Skala für diese Firmware nicht.
4. **Netz:** Bezug muss positiv erscheinen. Mit dem Netzzähler vergleichen. Bei LP1 zusätzlich 169 und 172 per
   Register-Scan lesen (Start 169, Ende 172, Schritt 1, Menge 1) und notieren, welcher zum Zähler passt. Der Scan
   zeigt Rohwörter; die Spalte `s16` ist der vorzeichenbehaftete Wert.
5. **Hauslast** mit der Last im Display vergleichen.

Ergebnisse bitte an info@bikinibottom.capital.

## Befund zum bestehenden Profil `deye-lv`

`deye-lv.json` bleibt unverändert, weil Feldkunden es nutzen. Laut den Quellen oben sind dort zwei Dinge
wahrscheinlich falsch. Beide müssen am Gerät bestätigt werden, bevor das Profil geändert wird:

- **Netz:** `meter.address` 616 liest „Out-of-grid power“ (nur externer CT/Zähler, V105). Ohne externen CT ist das
  Netz 0 W. Richtig wäre 622 (622–624 folgen der Einstellung intern/extern; so lesen auch evcc und kellerza).
- **Akku-Vorzeichen:** `batteryPowerW` 590 liest mit `scale 1`. 590 heißt „Battery output power“, und evcc liest das
  Register unverändert mit seiner Konvention + = Entladen. Dann zeigt `deye-lv` Laden als Entladen. Richtig wäre
  `scale -1`.
