# SMA Speedwire (SMA-Modbus-Profil) — nur Anzeige (Beta)

Stand 18.11.2026. Profil `sma-speedwire` (`dvhub/hersteller/sma-speedwire.json`).

**Nur Anzeige, keine Steuerung, am Gerät ungeprüft.** Das Profil trägt `"readOnly": true`: DVhub schreibt nichts an
das Gerät. Die Abregelung bleibt aus, auch wenn „Aktive Anlagensteuerung“ eingeschaltet ist. Es ist `"beta": true`
und erscheint nur im Bleeding-Edge-Kanal (`updateChannel: dev`), weil es an keinem Gerät getestet ist.

## Geräte

DVhub liest **ein** SMA-Gerät über das SMA-Modbus-Profil (Unit-ID 3).

| Gerät | Netz | PV | Akku + SoC | Hauslast |
|---|---|---|---|---|
| Sunny Tripower Smart Energy (Hybrid, STP x.0-3SE-40) | ja | ja (Eingang A + B) | ja | ja (Bilanz) |
| Sunny Boy Storage (SBS) | ja | **nein** (keine PV-Eingänge) | ja | nein (PV fehlt) |
| Sunny Boy / Sunny Tripower mit Energy Meter | ja | ja | **nein** | nein, bis Akku-Punkte aus sind (siehe Feldtest 5) |
| ennexOS (Sunny Tripower X, Tripower Storage X, Data Manager M) | **nein**, eigene Registerkarte | | | |

Der Netzwert braucht einen SMA Energy Meter bzw. Sunny Home Manager im selben Speedwire-Netz; das Gerät reicht dessen
Messung über Modbus weiter.

## Anschluss

- Modbus TCP, Port **502**, Unit-ID **3** (SMA-Werkseinstellung, am Gerät 3…123 einstellbar). Anlagenadresse in DVhub =
  IP des Wechselrichters.
- **Modbus ist ab Werk aus** und nach einem Zurücksetzen wieder aus. Mit Installateur-Zugang in der Benutzeroberfläche
  des Geräts „Modbus TCP-Server“ einschalten (Menüpfad je Gerät und Firmware, ungeprüft).
- Die Registernummern sind die Modbus-Adressen (der Abzug von 1 gilt laut SMA nur im SunSpec-Profil).
- Zeitlimit je Anfrage 5 s.

## Taktung: eine Anfrage je 10 Sekunden

SMA schreibt vor (SMA-Modbus-general-TI-en-10, §3.7): *„For system stability reasons, the time period between data
transfers via the Modbus protocol must be at least ten seconds. No more than five parameters and measured values should
be transmitted per SMA inverter.“* Das Profil setzt dafür die Anfrage-Taktung (E7, `victron.requestPacing`):

| Schlüssel | Wert | Wirkung |
|---|---|---|
| `minRequestGapMs` | 10 000 | jede Anfrage frühestens 10 s nach dem Ende der vorigen, auch nach einem Verbindungsneuaufbau |
| `maxRegistersPerRequest` | 10 | höchstens fünf 32-bit-Werte je Anfrage (das Profil liest höchstens zwei) |
| `minPollIntervalMs` | 10 000 | ein neuer Takt frühestens 10 s nach dem vorigen, auch wenn „Poll Intervall (ms)“ kleiner ist |

Ein Takt hat fünf Anfragen (Netz, SoC, Akku, PV A, PV B). **Die Werte erneuern sich darum etwa alle 50 Sekunden.**
Das ist gewollt. „Poll Intervall (ms)“ kleiner zu stellen ändert daran nichts.

## Was gelesen wird

Alle Register FC 03 (Holding), Unit 3, 32-bit-Werte High-Wort zuerst.

| Wert | Register | Typ | Umrechnung in DVhub | Beleg |
|---|---|---|---|---|
| Netz | 30865 Bezug − 30867 Einspeisung | je S32, 1 W | eine Anfrage (30865, 4 Register); + = Bezug | [COMM] evcc `sma-hybrid`; [DECOMP] Plexlog liest 30865 × 4, Bezug − Einspeisung |
| PV (DC) | 30773 Eingang A + 30961 Eingang B | je S32, 1 W | zwei Anfragen, bis zu 10 s auseinander | [COMM] evcc `sma-hybrid`, Spec §3.2 |
| Akku-Leistung | 31393 Laden − 31395 Entladen | je U32, 1 W | eine Anfrage (31393, 4 Register); + = Laden | [COMM] Spec §3.2, evcc `sma-datamanager` |
| SoC | 30845 | U32, % | unverändert | [COMM] evcc `sma-hybrid`/`sma-sbs-modbus`; [DECOMP] Plexlog |
| Hauslast | — | — | Energiebilanz: PV + Bezug − Einspeisung − Akku | kein Lastregister in der Spec |

Vorzeichen in DVhub: Netz + = Bezug, Akku + = Laden. Bei SMA sind alle vier Leistungen Beträge (≥ 0); die Richtung
ergibt sich aus dem Registerpaar. Darum kommen Bezug/Einspeisung und Laden/Entladen je aus **einer** Anfrage
(`combineBlock`): aus zwei Lesungen im Abstand von 10 s ergäbe ein Richtungswechsel einen Wert, den es nie gab.

**„Kein Wert“:** SMA meldet einen fehlenden Messwert mit NaN je Typ — S32 0x80000000, U32 0xFFFFFFFF (§3.5.7). DVhub
zeigt dann keinen Wert statt −2 147 483 648 W oder 4 294 967 295 %. Beim Netz gilt das als Zählerfehler; die
Hauslast wird dann nicht gerechnet.

Quellen (abgerufen 18.11.2026): [SMA-Modbus-general-TI-en-10](https://files.sma.de/downloads/SMA-Modbus-general-TI-en-10.pdf)
(Unit-IDs §3.5.1, Datentypen und NaN §3.5.6/§3.5.7, Zeitverhalten §3.7, Flash-Hinweis §2), evcc
[sma-hybrid.yaml](https://github.com/evcc-io/evcc/blob/master/templates/definition/meter/sma-hybrid.yaml),
[sma-sbs-modbus.yaml](https://github.com/evcc-io/evcc/blob/master/templates/definition/meter/sma-sbs-modbus.yaml),
[sma-datamanager.yaml](https://github.com/evcc-io/evcc/blob/master/templates/definition/meter/sma-datamanager.yaml),
Zusammenfassung in `.planning/docs/research/2026-11-15-sma-modbus-control-spec.md` §2–3.

## Was fehlt

| Lücke | Folge | Braucht |
|---|---|---|
| SunSpec-Profil (Unit 126, Model 160/714) | nicht genutzt: der Modell-Scan kostet je Modell eine Anfrage, bei 10 s Abstand Minuten | — (SMA-eigene Register reichen) |
| Netz je Phase (31259–31269) | Phasenwerte bleiben leer (sechs Werte, je eine Anfrage mehr) | ginge als `meter.phases`, kostet Takt |
| PV-Eingang C (30967) | nicht gelesen; fehlt er am Gerät, meldet SMA NaN und die PV-Summe wäre leer | eigenes Profil für 3-MPPT-Geräte |
| Akku über Strom × Spannung (30843 × 30851, evcc) | nicht abbildbar, falls 31393/31395 am Gerät nichts liefern | Produkt zweier Register in der Engine |
| Gerätekennung (30051 Geräteklasse) | DVhub prüft nicht, was antwortet | Kennungsprobe (E10) |
| ennexOS-Geräte | nicht abgedeckt | eigenes Profil mit eigener Karte |

**Flash:** SMA warnt, dass zyklisches Schreiben normaler RW-Parameter den Flash-Speicher zerstört (§2); nur die
Netzmanagement-Vorgaben dürfen zyklisch geschrieben werden. Für dieses Profil ohne Bedeutung (kein Write) — wichtig,
sobald ein SMA-Profil steuern soll.

## Am Gerät prüfen (Feldtest)

Für den ersten Test zusätzlich `DVHUB_READ_ONLY=1` setzen. Das sperrt jeden Modbus-Write im Prozess, unabhängig vom
Profil.

1. **Verbindung und Takt:** Laufen Netz, PV und SoC durch? Zwischen zwei Aktualisierungen liegen etwa 50 s. Fehler nur
   direkt nach dem Verbindungsaufbau bitte melden (dann fehlt eine Pause nach dem Verbindungsaufbau,
   `requestPacing.connectDelayMs`).
2. **Netz-Vorzeichen:** Bei Netzbezug (abends, Akku leer) muss DVhub Bezug zeigen. Mit dem Sunny Portal bzw. dem
   Energy Meter vergleichen.
3. **Akku-Vorzeichen:** Akku sichtbar laden lassen. DVhub muss die Akku-Leistung **positiv** zeigen. Zeigt die
   Diagnose für `batteryPowerW` einen Fehler oder bleibt der Wert leer, liefert das Gerät 31393/31395 nicht — melden.
4. **PV mit einem Eingang:** Bleibt PV leer, obwohl die Sonne scheint, hat das Gerät nur Eingang A. Dann in
   `/etc/dvhub/hersteller/sma-speedwire.json` bei `pvPowerW` den Eintrag `{ "address": 30961 }` entfernen und melden.
5. **Ohne Akku (Sunny Boy / Tripower):** Zeigt die Diagnose `batteryPowerW`-Fehler, rechnet DVhub keine Hauslast. Dann
   `batteryPowerW` und `soc` auf `"enabled": false` stellen und melden.
6. **Sunny Boy Storage:** PV bleibt leer (keine PV-Eingänge), also auch die Hauslast. Den PV-Wechselrichter liest
   dieses Profil nicht mit.
7. **Unit-ID:** Antwortet nichts, in der Geräte-Oberfläche die Unit-ID nachsehen (Werkseinstellung 3).

Einzelne Register lassen sich mit dem Register-Scan prüfen (`POST /api/meter/scan` mit
`{"host":"<IP>","port":502,"unitId":3,"fc":3,"start":30865,"end":30865,"step":1,"quantity":4,"onlyNonZero":false}`,
Ergebnis per `GET /api/meter/scan`). **Achtung:** Der Scan öffnet eine eigene Verbindung und hält die 10-s-Regel
nicht ein. Nur einzelne Register prüfen und danach mindestens 10 s warten.

Ergebnisse bitte an info@bikinibottom.capital.
