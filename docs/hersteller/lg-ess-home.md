# LG ESS Home 8/10 — nur Anzeige (Beta)

Stand 18.11.2026. Profil `lg-ess-home` (`dvhub/hersteller/lg-ess-home.json`).

**Nur Anzeige, keine Steuerung, am Gerät ungeprüft.** Das Profil trägt `"readOnly": true`: DVhub schreibt nichts an
das Gerät. Die Abregelung bleibt aus, auch wenn „Aktive Anlagensteuerung“ eingeschaltet ist. Es ist `"beta": true`
und erscheint nur im Bleeding-Edge-Kanal (`updateChannel: dev`), weil es an keinem Gerät getestet ist.

**Dieses Profil zeigt nur Netz und PV.** Akku-Leistung, Ladestand und Hauslast fehlen noch (siehe „Was fehlt“).

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
| Akku-Leistung, SoC | — | — | nicht gelesen | Spec nennt keine Feldlage im Modell 802 |
| Hauslast | — | — | nicht abgeleitet | braucht den Akku |

Vorzeichen in DVhub: Netz + = Bezug, Akku + = Laden. „Nicht implementiert“ (SunSpec: I32 0x80000000, I16 0x8000) zeigt
DVhub als „kein Wert“; beim Netz gilt das als Zählerfehler.

**Warum feste Adressen:** Die Referenz liest das Gerät an festen Modellbasen (SunS ab 0, Common ab 2, Modell 103 ab
70, Modell 802 ab 238, Zähler ab 302). Der Netzzähler ist dort kein SunSpec-Standardzähler (201–204), sondern ein
LG-eigenes Modell ohne bekannte Modell-ID; ein SunSpec-Scan fände ihn nicht. Außerdem liest die Referenz nur bis
Register 323. Ob die Modellkette danach mit dem Endzeichen 0xFFFF schließt, ist unbelegt; ohne Endzeichen schlüge ein
Scan ganz fehl.

**Warum feste Skalen:** Laut Referenz liefert das Gerät unzuverlässige SunSpec-Skalenfaktoren; sie werden durch feste
Werte ersetzt (Modell 103: W und DCW mit 0, Zähler-Leistung mit −2). DVhub liest deshalb keinen Skalenfaktor vom Gerät.

Quellen (abgerufen 18.11.2026): LG veröffentlicht keine Modbus-Registerdoku. SunSpec-Informationsmodell 103 für die
Feldlage; Plexlog-Treiber `LgEssHome8And10ReflectionDriver` als Strukturhinweis (nur gelesen, kein Code übernommen);
evcc [LG ESS Home 8/10](https://docs.evcc.io/en/meters/lg-ess-home-8-10.md) für die HTTPS-Steuerung und die
Freischaltung. Zusammenfassung in `.planning/docs/research/2026-11-15-lgess-modbus-control-spec.md` §2.

## Was fehlt

| Lücke | Folge | Braucht |
|---|---|---|
| Akku-Leistung und SoC (SunSpec-Modell 802) | nicht angezeigt | Feldlage im Modell 802 und Vorzeichen; die Spec nennt beides nicht. Die Referenz liest 802 ab Basis 238 in der SunSpec-Standardlage (SoC an 249, Leistung an 285) — Freigabe offen |
| Hauslast | nicht angezeigt. Die Energiebilanz ohne Akku zählte den Akku als 0 W und wäre bei jedem Laden und Entladen falsch | den Akku (dann Energiebilanz) |
| Netz je Phase | Phasenwerte bleiben leer | das LG-Zählermodell nennt in der Referenz keine Phasenleistung |
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
4. **PV:** Mit der LG-App vergleichen. Zeigt DVhub beim Akku-Laden zu wenig PV, zählt DCW den Akku-Zweig mit.
5. **Akku (Modell 802) für den nächsten Schritt:** Register 238 auslesen (Modell-ID 802 erwartet), dann SoC an 249
   (0,1 %) und Leistung an 285 (W) beim Laden und Entladen notieren. Damit lassen sich Akku, SoC und Hauslast
   nachtragen.

Einzelne Register lassen sich mit dem Register-Scan prüfen (`POST /api/meter/scan` mit
`{"host":"<IP>","port":6502,"unitId":255,"fc":3,"start":302,"end":305,"step":1,"quantity":1,"onlyNonZero":false}`,
Ergebnis per `GET /api/meter/scan`).

Ergebnisse bitte an info@bikinibottom.capital.
