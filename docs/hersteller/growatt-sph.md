# Growatt SPH (Speicher-Block 1000+) — nur Anzeige (Beta)

Stand 18.11.2026. Profil `growatt-sph` (`dvhub/hersteller/growatt-sph.json`).

**Nur Anzeige, keine Steuerung, am Gerät ungeprüft.** Das Profil trägt `"readOnly": true`: DVhub schreibt nichts an
den Wechselrichter. Die Abregelung bleibt aus, auch wenn „Aktive Anlagensteuerung“ eingeschaltet ist. Es ist
`"beta": true` und erscheint nur im Bleeding-Edge-Kanal (`updateChannel: dev`), weil es an keinem Gerät getestet ist.

**Schwächste Beleglage aller Nur-Lese-Profile:** Für den Speicher-Block gibt es keine Herstellerdoku. Alle Register
stammen aus einer Referenzimplementierung (Plexlog) und aus Community-Integrationen (evcc, Node-RED).

## Geräte

Growatt hat drei Registerfamilien, die nicht vermischt werden dürfen. Darum trägt die Profil-ID die Familie.

| Geräte | Registerfamilie | Passt? |
|---|---|---|
| SPH 3000–6000TL BL-UP (1-phasig), SPH 4000–10000TL3 BH-UP (3-phasig) | Speicher-Block 1000+ | ja |
| SPA (AC-gekoppelt) | laut Community derselbe Block | ungeprüft; PV-Wert dort 0 |
| MIN TL-XH, MOD/MID TL3-XH | Block 3000+ | **nein**, eigenes Profil nötig |
| MIN TL-XH2, WIT | Block 30000+ | **nein**, eigenes Profil nötig |
| Growatt-Zähler/CT am Netzanschluss | — | Pflicht für Netz und Hauslast |

## Anschluss

- Der Wechselrichter spricht Modbus RTU (RS485, 9600 Baud, 8N1). Empfohlen: ein **RS485-Ethernet-Gateway
  im Modus „Modbus TCP“**, Port **502**, Unit-ID = Modbus-Adresse des Wechselrichters
  (Werkseinstellung **1**).
- Anlagenadresse in DVhub = IP des Gateways.
- Shine-Sticks (ShineWiFi, ShineLAN) senden an die Growatt-Cloud und bieten in der Regel kein lokales Modbus TCP (je
  Modell und Firmware verschieden, ungeprüft). Ein Stick mit fremder Firmware, die Modbus TCP spricht, geht ebenso.
- Teilt sich das Gateway den RS485-Bus mit einem anderen Master (z. B. Datenlogger), kann es Kollisionen geben.
- Ein RS485-Gateway im **Durchreiche-Modus** (transparent, „RTU over TCP“) geht seit E12: im Profil
  (`/etc/dvhub/hersteller/growatt-sph.json`) unter `victron` `"framing": "rtu-over-tcp"` und `"port"` = Port des
  Gateways ergänzen. Dann darf nur DVhub am Gateway fragen (keine zweite Verbindung, kein zweiter Master am Bus). Am
  Gerät ungeprüft; Einzelheiten in `docs/HERSTELLERPROFIL-MIGRIEREN.md` §6.

## Was gelesen wird

Alle Register FC 04 (Input), 32-bit-Werte High-Wort zuerst, Leistungen in 0,1 W.

| Wert | Register | Typ | Umrechnung in DVhub | Beleg |
|---|---|---|---|---|
| Netz | 1021–1022 „AC power to user“ minus 1029–1030 „AC power to grid“ | je U32, 0,1 W | Differenz × 0,1 (+ = Bezug) | [DECOMP] Plexlog, [COMM] evcc (1021 × 0,1 und 1029 × −0,1) |
| PV gesamt | 1–2 „Ppv“ | U32, 0,1 W | × 0,1 | [COMM] evcc; Growatt-Protokoll V1.24 (Auszug); Plexlog summiert stattdessen die MPPT |
| Akku-Leistung | 1011–1012 „Charge power“ minus 1009–1010 „Discharge power“ | je U32, 0,1 W | Differenz × 0,1 (+ = Laden) | [DECOMP] Plexlog, [COMM] evcc (1009 × 0,1 − 1011 × 0,1 bei + = Entladen) |
| SoC | 1014 | U16, 1 % | unverändert | [DECOMP] Plexlog, [COMM] evcc |
| Hauslast | 1037–1038 „Total power to load“ | U32, 0,1 W **angenommen** | × 0,1; ohne Wert Energiebilanz | [COMM] Node-RED-Registerliste; nicht in Plexlog, nicht in evcc |

Vorzeichen in DVhub: Netz + = Bezug, Akku + = Laden. Growatt liefert Netz und Akku als zwei vorzeichenlose Beträge;
das Vorzeichen entsteht erst aus der Differenz. Fehlt einer der beiden Werte, ist die Differenz unbekannt.

**Hauslast mit Rückfall:** DVhub liest 1037. Liefert das Register einen Fehler oder „kein Wert“, rechnet DVhub die
Last in diesem Takt aus der Energiebilanz (PV + Bezug − Einspeisung − Akku). Die Skala 0,1 W ist eine Annahme (wie
alle übrigen Leistungen des Blocks); eine ESPHome-Konfiguration liest das Register ohne Faktor. Holding-Register 1037
(FC 03) ist der CT-Modus, nicht die Last.

**„Kein Wert“:** Growatt nennt keinen Sentinel. DVhub behandelt vorsorglich U32 0xFFFFFFFF und U16 0xFFFF als „kein
Wert“. Beim Netz gilt das als Zählerfehler; die Hauslast wird dann nicht gerechnet.

Quellen (abgerufen 18.11.2026): evcc
[growatt-hybrid.yaml](https://github.com/evcc-io/evcc/blob/master/templates/definition/meter/growatt-hybrid.yaml),
[8none1/growatt_sph_nodered registers.md](https://github.com/8none1/growatt_sph_nodered/blob/main/registers.md),
Growatt „Modbus RTU Protocol II“ V1.24 (Spiegel im Repo [johanmeijer/grott](https://github.com/johanmeijer/grott)),
Plexlog-Treiber `GrowattProtocollA` als Strukturhinweis (nur gelesen, kein Code übernommen), Zusammenfassung in
`.planning/docs/research/2026-11-15-growatt-modbus-control-spec.md` §1–2.

## Was fehlt

| Lücke | Folge | Braucht |
|---|---|---|
| Familienwahl (Holding 88 Protokollversion, 30099 VPP-Version) | DVhub prüft nicht, ob ein SPH antwortet; ein MIN/MOD liefert im Block 1000+ Fehler oder Unsinn | Kennungsprobe mit Familienwahl (E10) |
| RS485 direkt, Solarman-Stick | nicht erreichbar | Gateway (Modus Modbus TCP oder Durchreiche-Modus mit `framing`); Solarman V5 fehlt |
| Netz je Phase | Phasenwerte bleiben leer | Phasenregister in einer belastbaren Quelle |
| PV je MPPT (Input 5–6, 9–10, …) | nur die Summe | ginge heute per `combine` |
| Gerätegrenzen (max. Lade-/Entladeleistung) | nicht angezeigt | Register in einer Quelle |

## Am Gerät prüfen (Feldtest)

Für den ersten Test zusätzlich `DVHUB_READ_ONLY=1` setzen. Das sperrt jeden Modbus-Write im Prozess, unabhängig vom
Profil.

1. **Familie:** Zeigt DVhub nur Fehler oder Unsinn, ist das Gerät vermutlich kein SPH (MIN/MOD/WIT). Mit Holding 88
   und 30099 (Register-Scan, unten) die Familie bestimmen und melden.
2. **Netz:** Bei Netzbezug (abends, Akku leer) muss DVhub Bezug zeigen, bei Einspeisung negativ. Mit dem Zähler bzw.
   der ShinePhone-App vergleichen. Zeigt DVhub den zehnfachen oder zehnten Teil, stimmt die Skala nicht.
3. **Akku:** Akku sichtbar laden lassen. DVhub muss die Akku-Leistung **positiv** zeigen, beim Entladen negativ.
4. **Hauslast (Skala):** Die Last aus 1037 mit der ShinePhone-App vergleichen. Ist sie zehnmal zu groß oder zu klein,
   in `/etc/dvhub/hersteller/growatt-sph.json` bei `selfConsumptionW` `"scale"` auf `1` bzw. `0.01` setzen und
   melden. Weicht sie stark von PV + Bezug − Einspeisung − Akku ab, bitte beide Werte melden.
5. **PV:** Input 1 mit der Summe der MPPT in der App vergleichen.

Einzelne Register lassen sich mit dem Register-Scan prüfen (`POST /api/meter/scan` mit
`{"host":"<IP>","port":502,"unitId":1,"fc":4,"start":1037,"end":1037,"step":1,"quantity":2,"onlyNonZero":false}`,
Ergebnis per `GET /api/meter/scan`).

Ergebnisse bitte an info@bikinibottom.capital.
