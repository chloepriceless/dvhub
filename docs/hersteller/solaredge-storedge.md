# SolarEdge StorEdge (SunSpec + Akku) — nur Anzeige (Beta)

Stand 18.11.2026. Profil `solaredge-storedge` (`dvhub/hersteller/solaredge-storedge.json`).

**Nur Anzeige, keine Steuerung, am Gerät ungeprüft.** Das Profil trägt `"readOnly": true`: DVhub schreibt nichts an
den Wechselrichter. Die Abregelung bleibt aus, auch wenn „Aktive Anlagensteuerung“ eingeschaltet ist. Es ist
`"beta": true` und erscheint nur im Bleeding-Edge-Kanal (`updateChannel: dev`), weil es an keinem Gerät getestet ist.

## Geräte

| Geräte | Passt? |
|---|---|
| SolarEdge-WR mit StorEdge-Akku: SE…K-RWS (3-phasig), HD-Wave StorEdge (1-phasig), Akku BYD/LG RESU oder SolarEdge Home Battery | ja |
| SolarEdge-Zähler (Export+Import) am Netzanschluss, 3-phasig Stern (SunSpec-Modell 203) | Pflicht für den Netzwert |
| 1-phasiger Zähler (Modell 201) oder Dreieck (204) | erst nach Umstellung im Profil (siehe Feldtest) |
| Synergy-WR (mehrere Leistungsteile) | ja, der Zähler wird per Scan gefunden |
| Home Hub / 48-V-Home-Battery | **ungeprüft**: Foren berichten, dass die Akkudaten per Modbus fehlen |
| SolarEdge-WR ohne Akku | **nein**: die Akku-Bank fehlt, und neuere Firmware hängt bei unbekannten Registern |

## Anschluss

- Modbus TCP, Port **1502**, Unit-ID **1**. In der SetApp unter Kommunikation → LAN → Modbus/TCP einschalten. Die
  erste Verbindung muss laut Community innerhalb von zwei Minuten kommen, sonst Modbus aus- und wieder einschalten.
- Anlagenadresse in DVhub = IP des Wechselrichters.
- **Nur eine Modbus-Verbindung.** Läuft schon Home Assistant, evcc oder ein Proxy am Gerät, weist der Wechselrichter
  DVhub ab. Den anderen Client vorher abschalten.
- **Akkudaten:** Sie sind nicht auf jedem System per Modbus offen; teils schaltet sie erst der SolarEdge-Support frei.
  Ohne sie zeigt DVhub weder Akku noch PV (siehe unten).
- Nach einem Firmware-Update hängt Modbus manchmal; dann Modbus in der SetApp aus- und wieder einschalten.

## Was gelesen wird

Alle Register FC 03 (Holding). SunSpec-Register High-Wort zuerst mit Skalenfaktor, den DVhub in jedem Takt in
derselben Anfrage wie den Wert liest. Die Akku-Bank (0xE100ff.) ist Float32 mit Low-Wort zuerst.

| Wert | Register | Typ | Umrechnung in DVhub | Beleg |
|---|---|---|---|---|
| Netz gesamt | SunSpec-Zähler 203, W (Offset 16) mit W_SF (Offset 20); ohne Synergy 40206/40210 | I16 × 10^SF | `sign −1` (Annahme: Rohwert + = Einspeisung) | Register [SPEC]; Vorzeichen [COMM] evcc `203:W` mit `scale −1`; Spec nennt keine Richtung |
| PV | 40100 DCW mit DCW_SF 40101, plus Akku 0xE174 | I16 × 10^SF + Float32 | PV = DC-Leistung + Akku-Leistung (+ = Laden) | DCW [SPEC]; Rechenweg [COMM] evcc |
| Akku-Leistung | 0xE174 = 57716 | Float32, W | unverändert (Annahme: Rohwert + = Laden) | Register [SPEC]; Vorzeichen [COMM] evcc `scale −1` bei + = Entladen, [DECOMP] Plexlog ×(−1) |
| Ladestand | 0xE184 = 57732 „State of Energy“ | Float32, % | unverändert | [SPEC]; evcc und Plexlog lesen ihn als SoC |
| Hauslast | — | — | Energiebilanz: PV + Bezug − Einspeisung − Akku | kein Lastregister |
| Max. Ladeleistung (dauerhaft) | 0xE144 = 57668 | Float32, W | nur Anzeige, einmal je Minute | [SPEC] |
| Max. Entladeleistung (dauerhaft) | 0xE146 = 57670 | Float32, W | nur Anzeige, einmal je Minute | [SPEC] |

Vorzeichen in DVhub: Netz + = Bezug, Akku + = Laden.

**Warum PV = DC + Akku:** Bei StorEdge sitzt der Akku am DC-Bus. Die DC-Leistung des Wechselrichters (40100) sinkt
beim Laden und steigt beim Entladen. Die reine PV-Leistung ist deshalb DC-Leistung plus Akku-Leistung (Laden
positiv); evcc rechnet genauso. Daraus folgt für die Hauslast PV + Netz − Akku = DC-Leistung + Netz. Die Hauslast
hängt damit nicht vom Akku-Vorzeichen ab, wohl aber die PV-Anzeige.

**Skalenfaktoren:** SolarEdge ändert W_SF und DCW_SF je nach Leistungsbereich. DVhub liest Wert und Faktor in einer
Anfrage (Zähler 40206–40210, PV 40100–40101), damit beide zur selben Messung gehören.

**Warum der Zähler per Scan, PV fest:** Der Wechselrichterblock liegt laut SolarEdge immer ab 40069, der Zähler 1 ab
40121. Bei Synergy-Geräten steht dort aber erst das MPPT-Modell 160, und der Zähler rutscht um 50 oder 70 Register
nach hinten. Den Zähler sucht DVhub darum per SunSpec-Scan. PV bleibt auf der festen Adresse, weil DVhub je Punkt nur
ein SunSpec-Modell suchen kann und der Wechselrichter je nach Phasenzahl 101 oder 103 meldet.

**„Kein Wert“:** SunSpec meldet „nicht implementiert“ als 0x8000 (Wert und Skalenfaktor), die Akku-Bank als Float-NaN
(0xFFFFFFFF). DVhub zeigt dann keinen Wert. Beim Netz gilt das als Zählerfehler. Fehlt ein PV-Summand (DC-Leistung
oder Akku), ist auch PV unbekannt; die Hauslast wird dann nicht gerechnet.

Quellen (abgerufen 18.11.2026): SolarEdge „SunSpec Implementation Technical Note“ v2.4 und „Power Control Protocol
for SolarEdge Inverters“ v1.3 (Kopien im Repo [nmakel/solaredge_modbus](https://github.com/nmakel/solaredge_modbus)),
evcc [solaredge-hybrid.yaml](https://github.com/evcc-io/evcc/blob/master/templates/definition/meter/solaredge-hybrid.yaml),
[WillCodeForCats/solaredge-modbus-multi](https://github.com/WillCodeForCats/solaredge-modbus-multi) (Known Issues),
Zusammenfassung in `.planning/docs/research/2026-11-15-solaredge-modbus-control-spec.md` §1–2.

**Kennungsprobe:** DVhub liest vor dem ersten Wert und danach alle 10 Minuten den Hersteller im SunSpec-Common-Modell
(40004, 16 Register). Beginnt er nicht mit „SolarEdge“, zeigt DVhub keinen Wert an — Akku-Bank, PV-Rechenweg und
Zähler-Vorzeichen gelten nur für SolarEdge — und nennt den Grund als Hinweis im Leitstand. Die Akku-Bank liest DVhub
an einem fremden Gerät dann gar nicht erst (neuere SolarEdge-Firmware hängt an unbekannten Registern, andere Geräte
womöglich auch).

## Was fehlt

| Lücke | Folge | Braucht |
|---|---|---|
| Mehrere SunSpec-Modelle je Punkt (Zähler 201/203/204) | ein 1-phasiger oder Dreieck-Zähler bleibt unaufgelöst (Zählerfehler) | Modell-Liste je Punkt in der Engine; bis dahin Profil anpassen |
| Netz je Phase (Modell 203 WphA–C) | Phasenwerte bleiben leer; je eine Anfrage mehr am Ein-Client-Gerät | ginge heute als `meter.phases` mit `sunspec`, erst nach dem Gerätetest |
| Akku ohne Modbus-Freigabe | Akku, SoC, PV und Hauslast leer | Freischaltung durch SolarEdge; ein „PV ohne Akku“-Rückfall fehlt in der Engine |
| Akku 2 und 3 (0xE200, 0xE300) | nicht gelesen | weitere Punkte |
| Status 40107 (5 = abgeregelt) | nicht angezeigt | Statuspunkt |

## Am Gerät prüfen (Feldtest)

Für den ersten Test zusätzlich `DVHUB_READ_ONLY=1` setzen. Das sperrt jeden Modbus-Write im Prozess, unabhängig vom
Profil.

1. **Verbindung und Scan:** Im Log muss `sunspec_scan_ok` mit den Modellen `1, 101/103, 1, 203` stehen. Fehlt 203
   (`missing: meter`), meldet der Zähler 201 oder 204: in `/etc/dvhub/hersteller/solaredge-storedge.json` bei
   `meter.sunspec` `"model": 203` durch die gemeldete Zahl ersetzen und melden.
2. **Netz-Vorzeichen:** Bei Netzbezug (abends, Akku leer) muss DVhub Bezug zeigen. Zeigt es Einspeisung, bei `meter`
   die Zeile `"sign": -1` entfernen und melden.
3. **Akku-Vorzeichen:** Akku sichtbar laden lassen. DVhub muss die Akku-Leistung **positiv** zeigen. Ist sie negativ,
   bei `batteryPowerW` `"sign": -1` ergänzen **und** beim zweiten Eintrag von `pvPowerW.combine` ebenso, dann melden.
4. **PV:** Mit der SolarEdge-App vergleichen, am besten während der Akku lädt. Liegt DVhub um die doppelte
   Ladeleistung daneben, stimmt das Akku-Vorzeichen nicht (Punkt 3).
5. **Akkudaten fehlen:** Zeigt die Diagnose bei `batteryPowerW` keinen Wert, sind die Akkudaten nicht freigeschaltet.
   Dann bitte melden (mit Wechselrichter- und Akkutyp).
6. **Hauslast:** Mit dem Verbrauch in der SolarEdge-App vergleichen. Die Wandlerverluste zählen hier zur Last;
   einige Prozent Abweichung sind erwartet.

Einzelne Register lassen sich mit dem Register-Scan prüfen. **Vorsicht:** SolarEdge erlaubt nur eine Verbindung,
und neuere Firmware hängt bei unbekannten Registern. Nur bekannte Adressen lesen, z. B. `POST /api/meter/scan` mit
`{"host":"<IP>","port":1502,"unitId":1,"fc":3,"start":40206,"end":40210,"step":1,"quantity":1,"onlyNonZero":false}`
(Ergebnis per `GET /api/meter/scan`), und DVhub dafür kurz anhalten.

Ergebnisse bitte an info@bikinibottom.capital.
