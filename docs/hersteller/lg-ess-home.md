# LG ESS Home 8/10 — nur Anzeige (Beta)

Stand 19.11.2026. Profil `lg-ess-home` (`dvhub/hersteller/lg-ess-home.json`).

**Nur Anzeige, keine Steuerung, am Gerät ungeprüft.** Das Profil trägt `"readOnly": true`: DVhub schreibt nichts an
das Gerät. Die Abregelung bleibt aus, auch wenn „Aktive Anlagensteuerung“ eingeschaltet ist. Es ist `"beta": true`
und erscheint nur im Bleeding-Edge-Kanal (`updateChannel: dev`), weil es an keinem Gerät getestet ist.

**Netz, PV, Akku-Leistung und Ladestand, dazu die Hauslast aus der Energiebilanz.** Die Akku-Werte stammen nur aus
einer Referenzimplementierung, nicht aus einer Herstellerdoku. Adresse, Skala und Vorzeichen des Akkus sind am Gerät
noch nicht bestätigt (siehe „Am Gerät prüfen“, Schritte 5 und 6).

## Geräte

| Geräte | Passt? |
|---|---|
| LG ESS Home 8 / Home 10 (Komplettgerät mit LG-Hybrid-WR, RESU-Hochvoltakku und LG-Zähler) | ja |
| LG ESS Home 15, Home 4 / Home 6 | vermutlich, ungeprüft |
| LG-RESU-Akku an einem fremden Wechselrichter (SolarEdge, Fronius, SMA …) | **nein**, dort gilt das Profil des Wechselrichters |

## Anschluss

- Modbus TCP über die SunSpec-Schnittstelle, Port **6502** (nicht 502), Unit-ID **255**. Beide Werte stammen aus
  einer Referenzimplementierung, keine öffentliche LG-Quelle nennt sie. Am Gerät bestätigen.
- Anlagenadresse in DVhub = IP des LG ESS im Heimnetz.
- **Modbus am Gerät freischalten:** im Installateur-Menü [PCS] die externe Kommunikation bzw. Modbus aktivieren. Der
  genaue Menüpunkt hängt von Modell und Firmware ab (ungeprüft).
- Die lokale HTTPS-Schnittstelle (Weboberfläche des Geräts, Steuerung per SoC-Ziel) nutzt DVhub nicht. Zum Lesen ist
  sie nicht nötig.

## Was gelesen wird

FC 03 (Holding), 32-bit-Werte High-Wort zuerst. Die Adressen sind fest, nicht per SunSpec-Scan ermittelt (Gründe
unten).

| Wert | Register | Typ | Umrechnung in DVhub | Beleg |
|---|---|---|---|---|
| Netz gesamt | 304–305 (LG-Zählermodell ab 302, Feld ActPower) | I32 | `scale 0.01` (fester Skalenfaktor −2), unverändert (Annahme: Rohwert + = Bezug) | Adresse und Skala [DECOMP]; Vorzeichen **unbelegt** |
| PV gesamt (DC) | 101 (SunSpec-Modell 103 ab 70, Feld DCW) | I16, 1 W | unverändert (fester Skalenfaktor 0) | Feldlage [SUNSPEC], Basis und Skala [DECOMP] |
| Ladestand (SoC) | 249 (SunSpec-Modell 802 ab 238, Feld SoC, Kopf+11) | U16, 0,1 % | `scale 0.1` (fester Skalenfaktor −1) | Feldlage [SUNSPEC], Basis und Skala [DECOMP]; **am Gerät ungeprüft** |
| Akku-Leistung (DC) | 285 (SunSpec-Modell 802 ab 238, Feld W, Kopf+47) | I16, 1 W | `sign -1` (Annahme: Rohwert + = Entladen) | Feldlage [SUNSPEC], Basis und Skala [DECOMP], Vorzeichen aus der Referenz abgeleitet; **am Gerät ungeprüft** |
| Hauslast | — | — | Energiebilanz: PV + Bezug − Einspeisung − Akku | abgeleitet (E6) |

Vorzeichen in DVhub: Netz + = Bezug, Akku + = Laden. „Nicht implementiert“ (SunSpec: I32 0x80000000, I16 0x8000,
U16 0xFFFF) zeigt DVhub als „kein Wert“; beim Netz gilt das als Zählerfehler. Ohne gültigen Akkuwert bleibt die
Hauslast leer, DVhub rechnet sie nie mit Akku = 0 W.

**Warum feste Adressen:** Die Referenz liest das Gerät an festen Modellbasen (SunS ab 0, Common ab 2, Modell 103 ab
70, Modell 802 ab 238, Zähler ab 302). Der Netzzähler ist dort kein SunSpec-Standardzähler (201–204), sondern ein
LG-eigenes Modell ohne bekannte Modell-ID; ein SunSpec-Scan fände ihn nicht. Außerdem liest die Referenz nur bis
Register 323. Ob die Modellkette danach mit dem Endzeichen 0xFFFF schließt, ist unbelegt; ohne Endzeichen schlüge ein
Scan ganz fehl. Die Basen sind genau die aufaddierten SunSpec-Standardlängen (Common, 103, 111, 120, 123, 802, Zähler).
Fehlt am Gerät eines dieser Modelle, verschiebt sich alles dahinter, auch der Akku.

**Warum feste Skalen:** Laut Referenz liefert das Gerät unzuverlässige SunSpec-Skalenfaktoren; sie werden durch feste
Werte ersetzt (Modell 103: W und DCW mit 0, Modell 802: SoC mit −1 und W mit 0, Zähler-Leistung mit −2). DVhub liest
deshalb keinen Skalenfaktor vom Gerät.

**Warum das Akku-Vorzeichen gedreht wird (Annahme):** SunSpec beschreibt 802 W nur als Leistung „zum oder vom Akku“,
ohne Richtung. Die Referenz gibt 802 W unverändert als Entladeleistung aus. Dort heißt das Feld
`BatteryTotalDischargingPower` (+ = Entladen), und Hersteller mit nativem + = Laden (Huawei, Sigenergy) werden davor
ausdrücklich umgedreht, LG nicht. evcc liest 802 W in seiner allgemeinen SunSpec-Akku-Vorlage ebenfalls unverändert
(evcc: + = Entladen). Daraus folgt: Rohwert + = Entladen, DVhub dreht mit `sign -1` auf + = Laden. Gemessen hat das
keine Quelle an einem LG.

**Hauslast aus DC-Werten:** PV (DCW) und Akku (802 W) sind DC-Leistungen, das Netz eine AC-Leistung. Die Verluste des
Wechselrichters (wenige Prozent der umgesetzten Leistung) erscheinen deshalb als Hauslast. Die Hauslast ist also
etwas zu hoch, umso mehr, je mehr Leistung durch den Wechselrichter geht.

Quellen (abgerufen 18./19.11.2026): LG veröffentlicht keine Modbus-Registerdoku. SunSpec-Informationsmodelle 103 und
[802](https://github.com/sunspec/models/blob/master/json/model_802.json) für die Feldlage; Plexlog-Treiber
`LgEssHome8And10ReflectionDriver` samt SunSpec-Bibliothek als Strukturhinweis (nur gelesen, kein Code übernommen);
evcc [SunSpec Battery (Model 802)](https://docs.evcc.io/en/meters/sunspec-battery-model-802) und
[Vorzeichen-Konvention](https://docs.evcc.io/en/reference/configuration/meters) für die Akku-Richtung; evcc
[LG ESS Home 8/10](https://docs.evcc.io/en/meters/lg-ess-home-8-10.md) für die HTTPS-Steuerung und die Freischaltung.
Zusammenfassung in `.planning/docs/research/2026-11-15-lgess-modbus-control-spec.md` §2.

## Was fehlt

| Lücke | Folge | Braucht |
|---|---|---|
| Netz je Phase | Phasenwerte bleiben leer | das LG-Zählermodell nennt in der Referenz keine Phasenleistung |
| Akku-Grenzen (802 WChaRteMax/WDisChaRteMax) | nicht angezeigt | nur Anzeige, für DVhub nicht nötig |
| PV je String | nur DC gesamt | kein Modell 160 bekannt |
| Gerätekennung „LG ELECTRONICS.“ | DVhub prüft nicht, ob ein LG antwortet | Kennungsprobe (E10) |

## Am Gerät prüfen (Feldtest)

Für den ersten Test zusätzlich `DVHUB_READ_ONLY=1` setzen. Das sperrt jeden Modbus-Write im Prozess, unabhängig vom
Profil.

1. **Port und Unit-ID:** Antwortet das Gerät auf Port 6502 und Unit-ID 255? Wenn nicht, mit dem Register-Scan
   (unten) andere Werte probieren und melden.
2. **SunSpec-Kette:** Register 0–1 müssen „SunS“ (0x5375 0x6E53) enthalten, Register 70 die Modell-ID 103 und
   Register 302 die Kennung des Zählermodells. Abweichende Basen bitte mit den gelesenen Werten melden.
3. **Netz-Skala und -Vorzeichen:** Bei bekanntem Netzbezug (abends, Akku leer) muss DVhub Bezug in plausibler Höhe
   zeigen. Ist der Wert 100-fach zu groß oder zu klein, stimmt die feste Skala nicht. Zeigt DVhub Einspeisung, in
   `/etc/dvhub/hersteller/lg-ess-home.json` bei `meter` `"sign": -1` ergänzen und melden.
4. **PV:** Mit der LG-App vergleichen. Zeigt DVhub beim Akku-Laden zu wenig PV oder nachts beim Entladen eine
   PV-Leistung etwa in Höhe der Entladeleistung, zählt DCW den Akku-Zweig mit. Dann ist auch die Hauslast falsch (der
   Akku wird doppelt abgezogen); bitte melden.
5. **Akku-Lage und Ladestand:** Register 238–239 auslesen (Scan unten mit `"start":238,"end":239`). Erwartet:
   238 = 802 (Modell-ID Akku), 239 = 62 (Länge). Steht dort etwas anderes, liegen SoC und Akku-Leistung nicht an 249
   und 285; DVhub zeigt dann Unsinn. Bitte mit den gelesenen Werten melden. Den Ladestand mit der LG-App vergleichen:
   - stimmt bis auf Rundung: in Ordnung;
   - 10-fach zu klein (z. B. 6,5 % statt 65 %): in `/etc/dvhub/hersteller/lg-ess-home.json` bei `soc` `"scale": 1`
     statt `0.1` setzen und melden.
6. **Akku-Vorzeichen und -Skala:** Bei sichtbarem Laden (die LG-App zeigt Laden, mittags mit PV-Überschuss) muss DVhub
   die Akku-Leistung **positiv** zeigen, beim Entladen (abends) **negativ**. Ist es umgekehrt, bei `batteryPowerW` die
   Zeile `"sign": -1` entfernen und melden. Den Betrag mit der App vergleichen: 10-fach zu groß oder zu klein heißt,
   die feste Skala stimmt nicht.
7. **Hauslast:** Mit dem Verbrauch in der LG-App vergleichen. Wegen der DC-Werte ist DVhub etwas höher (Wandlerverluste,
   wenige Prozent). Weicht die Hauslast beim Laden oder Entladen um etwa die doppelte Akku-Leistung ab, stimmt das
   Akku-Vorzeichen nicht (Schritt 6).

Einzelne Register lassen sich mit dem Register-Scan prüfen (`POST /api/meter/scan` mit
`{"host":"<IP>","port":6502,"unitId":255,"fc":3,"start":302,"end":305,"step":1,"quantity":1,"onlyNonZero":false}`,
Ergebnis per `GET /api/meter/scan`). Für den Akku `"start":238,"end":239` (Modellkopf), `249` (SoC) bzw. `285`
(Leistung) einsetzen. Das Ergebnis zeigt je Register den Rohwert (`regs`, vorzeichenlos) und denselben Wert mit
Vorzeichen (`s16`); für die Akku-Leistung an 285 gilt `s16` (Rohwert, vor DVhubs Drehung).

Ergebnisse bitte an info@bikinibottom.capital.
