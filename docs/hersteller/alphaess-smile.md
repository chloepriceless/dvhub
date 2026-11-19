# AlphaESS SMILE (SMILE5/B3/G3) — nur Anzeige (Beta)

Stand 18.11.2026. Profil `alphaess-smile` (`dvhub/hersteller/alphaess-smile.json`).

**Nur Anzeige, keine Steuerung, am Gerät ungeprüft.** Das Profil trägt `"readOnly": true`: DVhub schreibt nichts an
das Gerät. Die Abregelung bleibt aus, auch wenn „Aktive Anlagensteuerung“ eingeschaltet ist. Es ist `"beta": true`
und erscheint nur im Bleeding-Edge-Kanal (`updateChannel: dev`), weil es an keinem Gerät getestet ist.

> **Abstand zwischen Anfragen.** AlphaESS verlangt mehr als 300 ms Abstand zwischen zwei Anfragen. DVhub hält 400 ms
> ein (`victron.requestPacing.minRequestGapMs`, gemessen ab dem Ende der Antwort). Ein Takt mit sechs Lesungen (Netz,
> SoC, Akku, PV1–PV3) dauert damit gut 2 s, einmal je Minute kommen zwei dazu (Grenzen).

## Geräte

| Geräte | Passt? |
|---|---|
| SMILE5, SMILE-B3 / B3-Plus, SMILE-Hi, Storion-SMILE (einphasige Plattform) | ja |
| SMILE-G3 (einphasig und T-Serie, z. B. SMILE-G3-T10) | ja (gleiche Leseregister) |
| EMS mit Seriennummer **AL701…** | Modbus TCP vorhanden |
| EMS mit Seriennummer **AL200…** | nur RS485 (Modbus RTU): über ein RS485-Gateway, siehe „AL200… über ein RS485-Gateway“ (ungeprüft) |
| Storion-T30/T50 (C&I) | ungeprüft |
| AC-gekoppelte PV am AlphaESS-PV-Zähler | PV und Hauslast ohne diesen Anteil (siehe „Was fehlt“) |

## Anschluss

- Modbus TCP, Port **502**, Unit-ID **85** (0x55). Die Herstellerdoku schreibt „Port 0x502“; gemeint ist 502, so nutzen
  es evcc und Home Assistant.
- Anlagenadresse in DVhub = IP des EMS.
- Zum Lesen ist keine Freigabe im AlphaESS-Portal nötig; die Dispatch-Freigabe betrifft nur das Steuern.
- Zeitlimit je Anfrage 2 s. AlphaESS antwortet laut Doku in unter 300 ms.

### AL200… über ein RS485-Gateway

EMS mit Seriennummer AL200… sprechen nur Modbus RTU (RS485, 9600 8N1, Unit-ID 85). DVhub erreicht sie über ein
RS485-Ethernet-Gateway (z. B. Waveshare RS485 TO ETH, Elfin EW11, USR-TCP232). Serielle Einstellungen (9600 8N1) nur
am Gateway. Zwei Betriebsarten:

- **Gateway im Modus „Modbus TCP“** (übersetzt selbst): das Profil bleibt, wie es ist. Nur wenn das Gateway nicht auf
  Port 502 lauscht, in `/etc/dvhub/hersteller/alphaess-smile.json` unter `victron` den `"port"` anpassen.
- **Gateway im Durchreiche-Modus** (transparent, „RTU over TCP“, oft „TCP Server“ ohne Modbus-Umsetzung): im selben
  Profil unter `victron` den Port des Gateways und den Rahmen eintragen:

  ```json
  "victron": { "transport": "modbus", "port": 4196, "unitId": 85, "timeoutMs": 2000,
    "framing": "rtu-over-tcp",
    "requestPacing": { "minRequestGapMs": 400 } }
  ```

  4196 steht nur als Beispiel; es gilt der Port, den das Gateway nennt. DVhub schickt dann RTU-Rahmen (Unit-ID + Daten +
  CRC) statt Modbus TCP, die 400 ms Abstand gelten weiter. Danach `sudo systemctl restart dvhub`.

Wichtig im Durchreiche-Modus:

- **Nur DVhub fragt das Gateway.** Keine zweite Verbindung (Home Assistant, evcc, ein zweites DVhub, der Register-Scan
  der Diagnose-Seite) und kein zweiter Master am RS485-Bus. RTU hat keine Transaktions-ID, und viele Gateways geben die
  Antworten an jede verbundene Verbindung weiter; eine fremde Antwort gleicher Form wäre von der eigenen nicht zu
  unterscheiden.
- „Heartbeat“- oder „Registrierungs“-Pakete des Gateways ausschalten: sie landen sonst zwischen den Antworten und
  erscheinen in der Diagnose als `modbus rtu: …`-Fehler.
- Der Register-Scan der Diagnose-Seite spricht nur Modbus TCP und geht über ein Gateway im Durchreiche-Modus nicht.
- Ein selbst geändertes Profil ersetzt ein Update nicht mehr automatisch, es legt die neue Fassung als `.dist` daneben
  (`docs/HERSTELLERPROFIL-MIGRIEREN.md`).

## Was gelesen wird

Alle Register FC 03 (Holding), 32-bit-Werte High-Wort zuerst.

| Wert | Register | Typ | Umrechnung in DVhub | Beleg |
|---|---|---|---|---|
| Netz gesamt | 0x21 = 33 „Total Active power (Grid Meter)“ | S32, 1 W | unverändert (+ = Bezug) | neuere AlphaESS-Registerliste; [COMM] evcc und ha-alphaess-modbus lesen 0x21. V1.17 nennt 0x06 (siehe unten) |
| PV | 0x41F + 0x423 + 0x427 (PV1–PV3) | je U32, 1 W | Summe | [SPEC] V1.17 und neuere Liste gleich; evcc liest sie |
| Akku-Leistung | 0x126 = 294 „Battery Power“ | S16, 1 W | `sign −1` (Gerät: „− Laden, + Entladen“) | [SPEC]; evcc ebenso, Plexlog liest es |
| SoC | 0x102 = 258 „Battery SOC“ | U16, 0,1 % | `scale 0.1` | [SPEC]; evcc ebenso, Plexlog liest es |
| Hauslast | — | — | Energiebilanz: PV + Bezug − Einspeisung − Akku | kein Lastregister in der Spec |
| Max. Ladeleistung | 0x12C = 300 | U16, 1 W | nur Anzeige, einmal je Minute | [SPEC] |
| Max. Entladeleistung | 0x12D = 301 | U16, 1 W | nur Anzeige, einmal je Minute | [SPEC] |

Vorzeichen in DVhub: Netz + = Bezug, Akku + = Laden. Typ-Extremwerte (U16 0xFFFF, S16 0x7FFF/0x8000, U32 0xFFFFFFFF,
S32 0x7FFFFFFF/0x80000000) zeigt DVhub vorsorglich als „kein Wert“; AlphaESS nennt selbst keinen.

**Netzregister — Abweichung von der Spec.** Das Protokoll V1.17 (August 2020) legt den Netzzähler ab 0x0000 an: Phasen
0x00–0x05, Summe 0x06, Energien 0x08/0x0A, dann der PV-Zähler 0x0C–0x15 und die schreibbaren Register „CT Enable“
0x16 und „CT Rate“ 0x17. Die neuere Registerliste der G3-Generation hat diesen Block umgebaut (Einspeise-/Bezugsenergie
0x10/0x12, Spannungen ab 0x14, Ströme 0x17–0x19, Phasenleistung 0x1B–0x1F, **Summe 0x21**). evcc und die
Home-Assistant-Integration lesen 0x21 auf aktuellen Geräten, auch einphasigen. Das Profil folgt der neueren Liste. Ein
Gerät mit der alten Belegung kennt 0x21 vermutlich nicht: DVhub meldet dann einen Zählerfehler statt einer falschen
Zahl (bitte melden).

**PV nur MPPT 1–3:** In der neueren Liste liegen PV4–PV6 an 0x42B/0x42F/0x433. In V1.17 ist 0x42A–0x42B aber
„Inverter warning“. Auf einem Gerät mit alter Belegung läse DVhub dort ein Warn-Bitfeld als PV-Leistung. PV1–PV3
liegen in beiden Fassungen gleich.

Quellen (abgerufen 18.11.2026): AlphaESS „Modbus_RTU/TCP Protocol“ V1.17
([PDF bei Loxone](https://www.loxone.com/cscz/wp-content/uploads/sites/7/2021/01/Alpha-Modbus-Protocol_V1.17.pdf)),
neuere Registerliste und Integration
[ramonvanraaij/ha-alphaess-modbus](https://github.com/ramonvanraaij/ha-alphaess-modbus) (`all_registers.txt`,
`integration_alpha_ess.yaml`), evcc
[alpha-ess-smile.yaml](https://github.com/evcc-io/evcc/blob/master/templates/definition/meter/alpha-ess-smile.yaml),
Zusammenfassung in `.planning/docs/research/2026-11-15-alphaess-modbus-control-spec.md` §2–3.

## Was fehlt

| Lücke | Folge | Braucht |
|---|---|---|
| PV4–PV6 | Geräte mit mehr als drei MPPT zeigen zu wenig PV | Fassungsprüfung (E10), dann per `combine` nachtragen |
| AC-gekoppelte PV am PV-Zähler (neu 0xA1, alt 0x12) | fehlt in PV und Hauslast | Fassungsprüfung (E10) |
| Netz je Phase (0x1B/0x1D/0x1F) | Phasenwerte bleiben leer | ginge heute als `meter.phases`; drei Anfragen mehr (je gut 0,4 s) |
| Fassung/Plattform (V1.17 oder neu, Dispatch 0x0722 oder 0x0880) | DVhub prüft nicht, welche Belegung antwortet | Kennungsprobe (E10) |
| RS485-EMS (AL200…) über ein Gateway im Durchreiche-Modus | geht mit `victron.framing` (oben), am Gerät ungeprüft | Feldtest |

## Am Gerät prüfen (Feldtest)

Für den ersten Test zusätzlich `DVHUB_READ_ONLY=1` setzen. Das sperrt jeden Modbus-Write im Prozess, unabhängig vom
Profil.

1. **Verbindung und Taktung:** Laufen Netz, PV und SoC durch? Häufen sich trotz 400 ms Abstand Fehler oder
   Zeitüberschreitungen in der Diagnose, `victron.requestPacing.minRequestGapMs` in
   `/etc/dvhub/hersteller/alphaess-smile.json` testweise auf 1000 stellen und melden, ob sie verschwinden.
2. **Netzregister:** Meldet DVhub einen Zählerfehler („exception 2“), hat das Gerät die alte V1.17-Belegung. Dann
   bitte melden (mit EMS-Firmware); die Summe läge dort an 0x06.
3. **Netz-Vorzeichen:** Bei Netzbezug (abends, Akku leer) muss DVhub Bezug zeigen. Zeigt es Einspeisung, in
   `/etc/dvhub/hersteller/alphaess-smile.json` bei `meter` `"sign": -1` ergänzen und melden.
4. **Akku-Vorzeichen:** Akku sichtbar laden lassen. DVhub muss die Akku-Leistung **positiv** zeigen. Ist sie
   negativ, bei `batteryPowerW` die Zeile `"sign": -1` entfernen und melden.
5. **PV:** Mit der AlphaESS-App vergleichen. Fehlt PV, hat das Gerät mehr als drei MPPT oder AC-gekoppelte PV am
   PV-Zähler (bitte melden).
6. **Hauslast:** Mit dem Verbrauch in der AlphaESS-App vergleichen. Abweichungen um die Wandlerverluste (einige
   Prozent) sind erwartet.

Einzelne Register lassen sich mit dem Register-Scan prüfen (`POST /api/meter/scan` mit
`{"host":"<IP>","port":502,"unitId":85,"fc":3,"start":33,"end":33,"step":1,"quantity":2,"onlyNonZero":false}`,
Ergebnis per `GET /api/meter/scan`).

Ergebnisse bitte an info@bikinibottom.capital.
