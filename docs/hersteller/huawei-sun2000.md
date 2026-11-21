# Huawei SUN2000 + LUNA2000 (direkt) — nur Anzeige (Beta)

Stand 18.11.2026. Profil `huawei-sun2000` (`dvhub/hersteller/huawei-sun2000.json`).

**Nur Anzeige, keine Steuerung, am Gerät ungeprüft.** Das Profil trägt `"readOnly": true`: DVhub schreibt nichts an
den Wechselrichter. Die Abregelung bleibt aus, auch wenn „Aktive Anlagensteuerung“ eingeschaltet ist. Es ist
`"beta": true` und erscheint nur im Bleeding-Edge-Kanal (`updateChannel: dev`), weil es an keinem Gerät getestet ist.

## Geräte

| Klasse | Geräte | Passt? |
|---|---|---|
| Residential 1-phasig | SUN2000-2…6KTL-L1 | ja |
| Residential 3-phasig | SUN2000-3…10KTL-M1, M5-Reihe | ja |
| C&I 3-phasig | SUN2000-12…25K-MB0 / -MAP0, direkt angeschlossen | ja (PV-Stringzählung anders, hier nicht gelesen) |
| Akku | LUNA2000-S0 und -S1 (am Wechselrichter) | ja |
| Netzzähler | Huawei Smart Power Sensor DTSU666-H / DDSU666-H am Wechselrichter | Pflicht für den Netzwert |
| SmartLogger3000 | Anlagen mit mehreren WR | **nein**, eigene Registerwelt |
| EMMA | neuere Anlagen mit EMMA-Gerät | **nein**, eigene Registerkarte (ungeprüft, ob der WR dahinter erreichbar bleibt) |

## Anschluss

- Modbus TCP, Port **502**, Unit-ID **1** (SDongle). Manche Firmware antwortet am internen WLAN-/FE-Port nur auf
  Unit-ID 0; dann `victron.unitId` in `/etc/dvhub/hersteller/huawei-sun2000.json` auf `0` stellen und melden.
- Anlagenadresse in DVhub = IP des SDongle (bzw. des Wechselrichters).
- **Modbus TCP am Gerät freigeben:** mit Installateur-Zugang in der FusionSolar-App, Kommunikationseinstellungen des
  SDongle, „Modbus TCP“ uneingeschränkt freigeben. Zum Lesen ist kein Installateur-Login über Modbus nötig. Der genaue
  Menüpfad hängt von App und Firmware ab (ungeprüft).
- **Nur ein Modbus-Client.** Läuft schon Home Assistant, evcc oder ein zweites DVhub am selben Gerät, kappt jede neue
  Verbindung die alte. Den anderen Client vorher abschalten.
- Zeitlimit je Anfrage 5 s (wie evcc). Huawei antwortet langsamer als andere Geräte.

## Was gelesen wird

Alle Register FC 03 (Holding), 32-bit-Werte High-Wort zuerst.

| Wert | Register | Typ | Umrechnung in DVhub | Beleg |
|---|---|---|---|---|
| Netz gesamt | 37113 | I32, 1 W | `sign −1` (Annahme: Rohwert + = Einspeisung) | Register [SPEC]; Vorzeichen [COMM] evcc `scale −1`, [DECOMP] Plexlog invertiert; Spec selbst [GERÄT] |
| PV gesamt (DC) | 32064 „Input power“ | I32, 1 W | unverändert | [SPEC], evcc ebenso |
| Akku-Leistung | 37765 | I32, 1 W | unverändert (Annahme: Rohwert + = Laden) | Register [SPEC]; Vorzeichen [COMM] evcc `scale −1` bei + = Entladen, [DECOMP]; Spec [GERÄT] |
| SoC | 37760 | U16, 0,1 % | `scale 0.1` | [SPEC], evcc ebenso |
| Hauslast | — | — | Energiebilanz: PV + Bezug − Einspeisung − Akku | kein Lastregister in der Spec |
| Max. Ladeleistung | 47075 | U32, 1 W | nur Anzeige, einmal je Minute | [SPEC], Plexlog liest es |
| Max. Entladeleistung | 47077 | U32, 1 W | nur Anzeige, einmal je Minute | [SPEC], Plexlog liest es |

Vorzeichen in DVhub: Netz + = Bezug, Akku + = Laden.

**„Kein Wert“:** Huawei meldet einen fehlenden Messwert mit dem Höchstwert des Typs (I32 0x7FFFFFFF, U16 0xFFFF,
U32 0xFFFFFFFF; wlcrs). evcc behandelt bei I32 zusätzlich 0x80000000 so. DVhub zeigt dann keinen Wert statt
−2 147 483 647 W oder 6553,5 %. Beim Netz gilt das als Zählerfehler; die Hauslast wird dann nicht gerechnet.

Quellen (abgerufen 18.11.2026): Huawei „Solar Inverter Modbus Interface Definitions“ über die Registerkarte
[wlcrs/huawei-solar-lib](https://github.com/wlcrs/huawei-solar-lib), evcc
[huawei-sun2000-hybrid.yaml](https://github.com/evcc-io/evcc/blob/master/templates/definition/meter/huawei-sun2000-hybrid.yaml),
Zusammenfassung in `.planning/docs/research/2026-11-15-huawei-modbus-control-spec.md` §2–3.

## Was fehlt

| Lücke | Folge | Braucht |
|---|---|---|
| Netz je Phase (37132/37134/37136) | Phasenwerte bleiben leer. Die Register sind nur bei dreiphasigem Zähler belegt und kosten je eine Anfrage mehr am Ein-Client-Gerät | ginge heute als `meter.phases`, erst nach dem Gerätetest |
| Gerätekennung (Modell 30000) | DVhub prüft nicht, ob wirklich ein SUN2000 antwortet | Kennungsprobe (E10) |
| Zweiter Wechselrichter / SmartLogger | nicht abgebildet | eigenes Profil |

## Am Gerät prüfen (Feldtest)

Für den ersten Test zusätzlich `DVHUB_READ_ONLY=1` setzen. Das sperrt jeden Modbus-Write im Prozess, unabhängig vom
Profil.

1. **Verbindung:** Laufen Netz, PV und SoC durch? DVhub wartet nach jedem Verbindungsaufbau 1 s, bevor es liest
   (wie evcc; `victron.requestPacing.connectDelayMs`). Fehler direkt nach dem Verbindungsaufbau (Start, nach einem
   Abbruch) trotzdem bitte melden. Häufen sich Zeitüberschreitungen im laufenden
   Betrieb, „Poll Intervall (ms)“ (Einstellungen → Grundsystem, `meterPollMs`) auf 5000 stellen und melden.
2. **Netz-Vorzeichen:** Bei Netzbezug (abends, Akku leer oder nicht entladend) muss DVhub Bezug zeigen. Zeigt es
   Einspeisung, in `/etc/dvhub/hersteller/huawei-sun2000.json` bei `meter` die Zeile `"sign": -1` entfernen und
   melden. Mit dem Netzzähler bzw. der FusionSolar-App vergleichen.
3. **Akku-Vorzeichen:** Akku sichtbar laden lassen. DVhub muss die Akku-Leistung **positiv** zeigen. Ist sie
   negativ, bei `batteryPowerW` `"sign": -1` ergänzen und melden.
4. **Hauslast:** Die abgeleitete Last mit der Verbrauchsanzeige der FusionSolar-App vergleichen. Abweichungen um die
   Wandlerverluste (einige Prozent) sind erwartet.
5. **Ohne Akku:** Liefert 37765 einen Fehler (Diagnose zeigt `batteryPowerW`-Fehler), rechnet DVhub keine Hauslast.
   Dann `batteryPowerW`, `soc` und die beiden Grenzen auf `"enabled": false` stellen und melden.
6. **Unit-ID:** Antwortet nichts, Unit-ID 0 probieren (siehe Anschluss).

Einzelne Register lassen sich mit dem Register-Scan prüfen (`POST /api/meter/scan` mit
`{"host":"<IP>","port":502,"unitId":1,"fc":3,"start":37113,"end":37113,"step":1,"quantity":2,"onlyNonZero":false}`,
Ergebnis per `GET /api/meter/scan`). **Achtung:** Der Scan öffnet eine zweite Verbindung. Bei Huawei kann das die
Sitzung von DVhub kurz unterbrechen; danach baut DVhub sie neu auf.

Ergebnisse bitte an info@bikinibottom.capital.
