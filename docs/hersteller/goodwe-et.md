# GoodWe ET/EH/BT/BH (Hybrid) — nur Anzeige (Beta)

Stand 18.11.2026. Profil `goodwe-et` (`dvhub/hersteller/goodwe-et.json`).

**Nur Anzeige, keine Steuerung, am Gerät ungeprüft.** Das Profil trägt `"readOnly": true`: DVhub schreibt nichts an
den Wechselrichter. Die Abregelung bleibt aus, auch wenn „Aktive Anlagensteuerung“ eingeschaltet ist. Es ist
`"beta": true` und erscheint nur im Bleeding-Edge-Kanal (`updateChannel: dev`), weil es an keinem Gerät getestet ist.

## Geräte

| Geräte | Passt? |
|---|---|
| ET, EH, BT, BH (ARM205-Firmware-Familie), ET Plus, ESA, mit Lynx-Home-Speicher (F/U/C) | ja |
| GoodWe-Zähler am Wechselrichter | Pflicht für den Netzwert |
| Firmware vor ARM09 | Netz liegt dort nur in 36008 (S16), siehe Feldtest |
| Netzgeführte GoodWe-WR (DT-Serie) und ältere Familien mit eigener Karte | **nein** |
| Gerät im SunSpec-Modus (Register 45153 = 1) | **nein** (Werkseinstellung ist 0 = GoodWe-Karte) |

## Anschluss

- Modbus TCP, Port **502**, Slave-ID **247** (Werkseinstellung, Register 45127).
- Modbus TCP gibt es nur mit **LAN-Kit** (WiFi+LAN-Modul). Ohne geht nur RS485 (9600 8N1) über ein Gateway im Modus
  Modbus TCP.
- Anlagenadresse in DVhub = IP des LAN-Kits (bzw. des Gateways).
- Ohne DC und ohne AC (nachts dunkel und netzlos) antwortet das Gerät nicht. Dann meldet DVhub Lesefehler, bis es
  wieder antwortet.

## Was gelesen wird

Alle Register FC 03, 32-bit-Werte High-Wort zuerst.

| Wert | Register | Typ | Umrechnung in DVhub | Beleg |
|---|---|---|---|---|
| Netz gesamt | 36025 „Meter Total Active Power“ (ab ARM09; = Quelle von 10418) | S32, 1 W | `sign −1` (Annahme: Rohwert + = Einspeisung) | Register [SPEC]; Vorzeichen [COMM] evcc `scale −1`; Spec [GERÄT] |
| PV | 35105 + 35109 + 35113 + 35117 (PV1–PV4 Power) | je U32, 1 W | summiert (`combine`) | [SPEC], evcc liest dieselben vier |
| Akku-Leistung | 35182 „Battery1 Power“ (= Quelle von 10414) | S32, 1 W | `sign −1` (Annahme: Rohwert + = Entladen) | Register [SPEC]; Vorzeichen [COMM] evcc unverändert bei + = Entladen; Spec „BMS-Konvention“ [GERÄT] |
| SoC | 37007 „BMS1 SOC“ (= Quelle von 10472) | U16, 1 % | unverändert | [SPEC], evcc ebenso |
| Hauslast | — | — | Energiebilanz: PV + Bezug − Einspeisung − Akku | kein Lastregister in der Spec (10416 ist nur der Back-up-Ausgang) |

Vorzeichen in DVhub: Netz + = Bezug, Akku + = Laden. Meldet das Gerät „kein Wert“ (SoC 0xFFFF, PV-String
0xFFFFFFFF; so liest evcc diese Register), bleibt der Wert leer statt einer Zahl wie 6553 % oder 4,3 GW. Ein
String ohne Wert macht die PV-Summe unbekannt.

**Warum nicht der EMS-Block 10400ff.?** Die Spec empfiehlt den zusammengefassten Block (10412 PV, 10414 Akku,
10418 Netz, 10472 SoC). Er verweist auf genau die Rohregister oben. Die Rohregister stehen ebenso in der Spec und
werden von evcc im Feld gelesen; ob der 104xx-Block auf jeder ET-Firmware existiert, belegt keine Quelle. Er bleibt
die Alternative, falls ein Rohregister am Gerät fehlt.

Quellen (abgerufen 18.11.2026): GoodWe „Third-Party EMS Protocol — MODBUS“
([PDF](https://en.goodwe.com/Ftp/EN/Downloads/GW_Third-Party-EMS-Protocol_MODBUS-EN.pdf)), evcc
[goodwe-hybrid.yaml](https://github.com/evcc-io/evcc/blob/master/templates/definition/meter/goodwe-hybrid.yaml),
Zusammenfassung in `.planning/docs/research/2026-11-15-goodwe-modbus-control-spec.md` §1–2.

## Was fehlt

| Lücke | Folge | Braucht |
|---|---|---|
| Netz je Phase (10481/10483/10485 → 36127/36129/36131) | Phasenwerte bleiben leer | ginge heute als `meter.phases`, erst nach dem Gerätetest |
| Zweiter Speicher (35264/39005) | zweiter Akku fehlt | eigener Punkt bzw. `combine`, erst nach Gerätetest |
| Gerätegrenzen | die Spec nennt nur Energie (10476/10478 Wh), keine Lade-/Entladeleistung | — |
| Firmware-/Familienprüfung | DVhub prüft nicht, ob eine ET-Firmware ab ARM09 antwortet | Kennungsprobe (E10) |

## Am Gerät prüfen (Feldtest)

Für den ersten Test zusätzlich `DVHUB_READ_ONLY=1` setzen. Das sperrt jeden Modbus-Write im Prozess, unabhängig vom
Profil.

1. **Netz-Vorzeichen:** Bei Netzbezug muss DVhub Bezug zeigen. Zeigt es Einspeisung, in
   `/etc/dvhub/hersteller/goodwe-et.json` bei `meter` die Zeile `"sign": -1` entfernen und melden. Mit dem
   Netzzähler bzw. der SEMS-App vergleichen.
2. **Akku-Vorzeichen:** Akku sichtbar laden lassen. DVhub muss die Akku-Leistung **positiv** zeigen. Ist sie
   negativ, bei `batteryPowerW` die Zeile `"sign": -1` entfernen und melden.
3. **Netz bleibt 0 W bei älterer Firmware:** Dann liegt das Netz vermutlich nur in 36008 (S16). Per Register-Scan
   36008 und 36025 lesen und melden.
4. **PV:** Summe mit der SEMS-App vergleichen. Meldet DVhub einen PV-Lesefehler, fehlt einer der vier
   String-Register; bleibt PV leer, meldet ein unbelegter String „kein Wert“. In beiden Fällen 35105–35118 und
   10412 per Register-Scan lesen und melden.
5. **Hauslast:** Die abgeleitete Last mit der Verbrauchsanzeige der App vergleichen. Abweichungen um die
   Wandlerverluste (einige Prozent) sind erwartet.

Register-Scan: `POST /api/meter/scan` mit
`{"host":"<IP>","port":502,"unitId":247,"fc":3,"start":36008,"end":36025,"step":17,"quantity":2,"onlyNonZero":false}`,
Ergebnis per `GET /api/meter/scan` (Spalte `s16` = vorzeichenbehaftete Wörter).

Ergebnisse bitte an info@bikinibottom.capital.
