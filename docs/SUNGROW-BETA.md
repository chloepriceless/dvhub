# Sungrow SH Hybrid — Beta-Test

Stand: 11.11.2026 · Profil `hersteller/sungrow.json` · Ticket T-0422

Das Sungrow-Profil ist eine **Beta**: Es ist nach der offiziellen Sungrow-Registerdoku gebaut und gegen
nachgebildete Geräte getestet, aber noch nicht an einer echten Anlage gelaufen. Es erscheint in der Herstellerliste
nur im Update-Kanal **Bleeding Edge**.

## Welche Geräte

| Serie | Modelle | Phasen |
|---|---|---|
| SH-RS | SH3.0RS, SH3.6RS, SH4.0RS, SH5.0RS, SH6.0RS, SH8.0RS, SH10RS | 1 |
| SH-RT | SH5.0RT–SH10RT, auch -20, -V112, -V122 | 3 |
| SH-T | SH5T, SH6T, SH8T, SH10T, SH12T, SH15T, SH20T, SH25T | 3 |
| MG-RL | MG5RL, MG6RL | 1 |

Jeweils mit Akku und Sungrow-Smart-Meter (DTSU666) am Netzanschluss. Reine String-Wechselrichter (SG-Serie) werden
nicht unterstützt: DVhub erkennt sie am Typcode und schreibt dann nichts.

## Vor dem Test am Gerät prüfen

1. **Modbus TCP erreichbar:** entweder über den LAN-Port des Wechselrichters (zuverlässiger) oder über das
   WiNet-S/WiNet-S2. Beim WiNet-S in dessen Weboberfläche Modbus TCP einschalten. Port 502, Geräteadresse (Unit-ID) 1.
2. **Firmware aktuell:** Wechselrichter und WiNet-S auf den neuesten Stand bringen (iSolarCloud). Ältere
   WiNet-S-Firmware hat Modbus TCP zeitweise verschlüsselt oder Lesevorgänge abgebrochen; ältere Wechselrichter-
   Firmware kennt die Akku-Leistung 5214 und den Zählerblock 5601 noch nicht.
3. **Smart Meter angeschlossen** und in der App sichtbar. Ohne Zähler gibt es keine Netz- und Hauswerte, und DVhub
   steuert den Akku nicht.
4. **Kein anderes EMS aktiv:** Steht der Wechselrichter im Modus „External EMS“ oder „VPP“ (z. B. ein
   Stromanbieter-Programm), schreibt DVhub nichts. Self-consumption muss der Normalzustand sein.
5. **Grenzen am Gerät** (SoC-Untergrenze, Lade-/Entladeleistung, Einspeisegrenze des Netzbetreibers) bleiben, wie
   sie sind. DVhub ändert sie nicht; eine vom Installateur gesetzte Einspeisegrenze wird bei der Abregelung gesichert
   und danach zurückgeschrieben.

## Kanal wechseln (Release → Bleeding Edge)

1. Einstellungen → Status → Kasten „Software“ → Update-Kanal **„Bleeding Edge (Dev)“** wählen (der Wechsel startet
   sofort, nach Rückfrage).
2. DVhub installiert den neuesten Bleeding-Edge-Stand und startet neu.
   - Native Box mit Paketen (Standard seit 1.0.9): klappt ab DVhub 1.0.10 und nur, wenn ein Bleeding-Edge-Paket
     veröffentlicht ist. Ohne Paket meldet die Oberfläche „Für Paket-Installationen ist derzeit kein
     Bleeding-Edge-Paket veröffentlicht. Die Box bleibt auf Stabil.“
   - Native Box mit git: holt den aktuellen Stand von `main`.
   - Docker: Image-Tag `bikinibottomcapital/dvhub:dev` statt `latest`, Container neu starten.
3. Zurück geht es genauso (Kanal **„Stable (Releases)“**). Ein Wechsel von Bleeding Edge zurück auf einen älteren stabilen Stand
   verlangt eine ausdrückliche Bestätigung.

## Einrichten

1. Einstellungen → Anlage verbinden → Hersteller **„Sungrow SH Hybrid (Modbus TCP) — Beta“**, Anlagenadresse = IP des
   Wechselrichters bzw. des WiNet-S. Speichern, DVhub startet die Abfrage neu.
2. Im Protokoll muss „Sungrow SH… erkannt (Beta)“ stehen (`inverter_identified`). Steht dort „kein unterstützter
   Hybrid-Wechselrichter“, steuert DVhub nicht.
3. Leitstand prüfen: SoC, PV-, Akku-, Haus- und Netzleistung bewegen sich. **Vorzeichen prüfen:** Lädt der Akku,
   muss DVhub eine positive Akku-Leistung zeigen; die Netzleistung muss zur App passen. Ist die Akku-Leistung
   verdreht, bitte melden (Profilwert `batteryPowerW.scale`, nicht selbst ändern).
4. Steuermodus prüfen: Einstellungen → Anlage verbinden → „Sungrow-Akkusteuerung (Beta)“. Standard ist
   **External EMS** mit 30 s Herzschlag-Frist. Meldet das Protokoll `sungrow_ems_heartbeat_unsupported`, kennt die
   Firmware das Herzschlag-Register nicht: Firmware aktualisieren oder bewusst „Forced mode“ wählen.
5. Steuerung erst beobachten, dann einschalten: einen moderaten Netz-Sollwert von Hand setzen (z. B. −1000 W,
   Einspeisen) und in der App prüfen, dass der Wechselrichter in „External EMS“ geht und sich die Einspeisung
   etwa einstellt. Danach Sollwert löschen bzw. −40 W: der Wechselrichter muss zurück in Self-consumption.
6. **Rückfall prüfen (der Kernnutzen von External EMS):** während eines Lade- oder Entladebefehls DVhub stoppen. Nach
   der Herzschlag-Frist (30 s) muss der Wechselrichter von selbst in Self-consumption sein. In der App ablesen, ob
   dabei auch „EMS-Modus“ auf Self-consumption springt oder auf External EMS stehen bleibt — bitte melden.
7. Not-Halt einmal auslösen: der Wechselrichter muss in Self-consumption zurückfallen, danach schreibt DVhub nichts,
   auch keinen Herzschlag.

## Steuermodus: External EMS oder Forced mode

| | External EMS (Standard) | Forced mode |
|---|---|---|
| Register 13050 | 3 (belegt, Tabelle 4 Nr. 27, Kap. 3.5) | 2 „Compulsory“ (belegt) |
| Lade-/Entladebefehl | 13051 (0xAA/0xBB/0xCC) + 13052 Leistung in W — Tabelle 9 führt beide unter „Energy Management Parameters“, Kap. 3.5 sagt nur „scheduling command is delivered via Modbus“: **ungeprüft**, ob der Wechselrichter sie im Modus 3 genauso ausführt | 13051 + 13052, ausdrücklich belegt (Kap. 3.5 Schritt 2) |
| Herzschlag | 13080, U16, 0–1000 s, Werk 20 s (Tabelle 4 Nr. 37). Der Wert ist die Frist; ihn innerhalb der Frist erneut schreiben ist der Herzschlag (Kap. 3.5 Schritt 3: „bei 20 s im Schnitt alle 10 s den Wert 20 schreiben“) | keiner |
| Ausfall von DVhub | „returns to self-consumption mode“ nach Ablauf der Frist (Kap. 3.5, belegt). **Ungeprüft:** ob 13050 dabei auf 0 springt oder auf 3 stehen bleibt | Befehl läuft weiter bis zur SoC-Grenze (13058/13059) |
| Zustand am Gerät | Running state 13000 = 0x4000 „Running in External EMS mode“ (Appendix 2) | 0x0800 „Running in compulsory mode“ |
| Firmware | 13080 muss existieren; fehlt es (Exception oder 0xFFFF), steuert DVhub nicht (siehe unten) | alle Firmwares mit 13050–13052 |
| Netz-Zielleistung | **gibt es nicht** — weder im Modus 3 noch sonst kennt die Doku ein Netz-/Bezugs-Sollwert-Register. Vorhanden sind nur die Einspeisebegrenzung am Netzpunkt (13074 W, 13087 an/aus, 13088 Quote 0,1 %, Vorrang) und die Wirkleistungsbegrenzung am WR-Ausgang (13089/13090) | gleich |
| Gegenprüfung | mkaiser: Auswahl „External EMS“ = 3 am Draht-Register 13049 (bestätigt). Herzschlag 13080 nur aus der Sungrow-Doku; evcc nutzt nur Modus 0/2 | evcc und mkaiser: 2 am Draht-Register 13049 |

**DVhubs Werte:** Herzschlag-Frist 30 s (einstellbar 20–300 s). DVhub schreibt den Herzschlag in jedem Regeltakt
(10 s, bei kürzerer Frist alle Frist/3) — also drei Meldungen je Frist: zwei dürfen ausfallen (WiNet-S-Zeitüberschreitung
3 s, Neuverbindung), ohne dass der Wechselrichter zurückfällt; nach einem Absturz endet ein Lade-/Entladebefehl
spätestens nach 30 s. Die Werkseinstellung 20 s wäre nur zwei Takte. Der Herzschlag ist das einzige RW-Register,
das DVhub im Takt schreibt — die Doku verlangt genau das (Note 6 gilt sonst).

**Firmware ohne 13080:** DVhub fällt bewusst **nicht** still auf Forced mode zurück. Wer External EMS gewählt hat,
will den Rückfall des Wechselrichters bei einem DVhub-Ausfall; Forced mode hat ihn nicht. Deshalb: einmal Meldung
im Protokoll, keine Akku-Steuerung (Abregelung und Messwerte laufen weiter). Hatte DVhub den Akku vorher selbst im
Zwangsbetrieb, gibt es ihn einmal an Self-consumption zurück. Forced mode bleibt als bewusste Wahl möglich.

**Moduswechsel zur Laufzeit:** erst Befehl Stopp + Modus 0 (bestätigt), der neue Modus folgt im nächsten Takt.

**Fremdes EMS:** Modus 4 (VPP) ist immer fremd. Modus 3 ist nur dann DVhubs eigener, wenn DVhub ihn gesetzt hat;
das merkt sich DVhub in `sungrow_ems_state.json` im Datenordner (übersteht Neustarts). Fremdes Modus 3/4 wird nie
überschrieben, auch nicht im Not-Halt.

## Eigenverbrauch und Regelgüte

Im External EMS regelt der Wechselrichter den Eigenverbrauch nicht mehr selbst, und eine Netz-Zielleistung, die er
ausregeln würde, gibt es im Protokoll nicht (siehe Tabelle). Bewertete Wege:

| Weg | Bewertung |
|---|---|
| A: immer External EMS, DVhub regelt auch den Eigenverbrauch (Akku-Leistung = so, dass Netz ≈ 0) | Regeltakt über WiNet-S ~10 s (Herzschlag-Takt der Doku, RW-Register nicht schneller gedacht) — jeder Lastsprung (Herd, Wärmepumpe, Wallbox) liefe 10–30 s ungeregelt ins Netz. Schlechter als der Wechselrichter selbst. Verworfen. |
| **B: External EMS nur, solange DVhub etwas vorgibt; sonst Self-consumption (Modus 0)** | **Gewählt.** Sollwert im Band ±300 W (DVhub-Puffer −40 W, „nichts zu tun“) → Modus 0, der Wechselrichter regelt den Eigenverbrauch selbst und schnell. Nur bei echten Vorgaben (Netzladen, Einspeisen, Akku halten, Bezugsgrenze) übernimmt DVhubs Schleife. Der Herzschlag-Rückfall bleibt genau dort erhalten, wo er gebraucht wird: in Modus 0 gibt es nichts zurückzufallen, in Modus 3 läuft der Herzschlag. |
| C: DVhubs „Akku zuerst“-Regelkreis (`services/grid-connection`, `nativeBatteryStep`, Commit 9cbcf92f) wiederverwenden | Nicht passend: er hebt einseitig eine Entladegrenze an, damit der Bezug unter einer Obergrenze bleibt — kein zweiseitiger Netz-Sollwert-Folger. Er bleibt aber im Spiel: seine Decke (`batteryCeilingW`) wirkt über den Sollwert auch auf Sungrow. |

Die Schleife (`services/inverter/sungrow.js`): Akku-Soll = Akku-Ist + 0,7 · (Netz-Soll − Netz-Ist), alle 10 s,
neue Leistung erst ab 100 W Änderung, begrenzt auf die BDC-Nennleistung (5628) und vom Wechselrichter selbst auf
Min-/Max-SoC (13058/13059). Ohne Netzlade-Wunsch nur PV-Laden, ohne Einspeise-Wunsch nur Last-Entladen. Weil sie
von der gemessenen Akku-Leistung ausgeht, zieht sie sich bei einem begrenzten Akku nicht auf.

Getestet gegen eine simulierte Anlage (Akku folgt sofort bzw. mit halber Verzögerung je Takt): Netzladen 3 kW,
Lastsprung +3 kW und −3 kW — Abweichung unter 150 W nach 4 Takten (40 s) bzw. 9 Takten (90 s), Fehler fällt
monoton, kein Pendeln. **Ungeprüft und am Gerät zu messen:** Antwortzeit über WiNet-S/LAN, Rampe des Akkus, ob 10 s
über den LAN-Port kürzer gehen (Profilwert `regulateEveryMs`, mindestens 2 s). Bis dahin gilt ehrlich: in
Phasen mit DVhub-Vorgabe weicht das Netz nach einem Lastsprung für 10–40 s vom Sollwert ab; in allen anderen
Phasen regelt der Wechselrichter selbst.

## Was DVhub schreibt

| Zweck | Register (Doku) | Wann |
|---|---|---|
| Akku: Self-consumption | 13051 = 0xCC, 13050 = 0 | Sollwert nahe 0 (±300 W), ohne frische Messwerte, ohne Sollwert seit 2 min, abgelehnter Sollwert, Not-Halt |
| Akku: Laden/Entladen (External EMS) | 13052 Leistung (W), 13051 = 0xAA/0xBB, 13080 = Frist, 13050 = 3 | Sollwert außerhalb ±300 W; Leistung alle 10 s nachgeführt (ab 100 W Änderung), Herzschlag 13080 jeden Takt |
| Akku: Laden/Entladen (Forced mode) | 13052, 13051, 13050 = 2 | wie oben, ohne Herzschlag |
| Abregelung | 13088 = 0, 13074 = 0 W, 13087 = 0xAA | Direktvermarkter, §51 bei negativem Preis |
| Freigabe | gesicherte Werte von 13088/13074/13087 | Ende der Abregelung |

Nach jedem Write liest DVhub das Register zurück (beim Eintritt in External EMS auch 13080). Holding-Register liest
DVhub sonst höchstens einmal pro Minute. Im Forced mode hat der Wechselrichter keinen eigenen Rückfall: stürzt DVhub
mitten im Laden oder Entladen ab, läuft der Befehl weiter, bis der Akku an seiner SoC-Grenze steht.

## Was EOS und DVhub liefern — und wie Sungrow es umsetzt

Alle Vorgaben laufen durch DVhubs vorhandene Schiedsrichter (`applyControlTarget`: EEG-/MiSpeL-Tor,
Netzanschluss-, Schwellen- und §14a-Decke über `batteryCeilingW`, SoC-Boden, Not-Halt; DV-Sequenz;
Einspeisegrenze `feed-in-cap`/`feed-in-limit-arbiter`). Mehrere gleichzeitige Grenzen kombinieren diese
Schiedsrichter wie bei Victron zu einem Netz-Sollwert (engstes Intervall: kleinste Bezugsdecke, Einspeise-Puffer,
SoC-Boden); erst dieser Wert geht an den Sungrow-Aktuator, der daraus Akku-Leistung macht. Test je Zeile:
`dvhub/test/sungrow-functions.test.js` (Mock-Modbus), Regelgüte und Not-Halt in `sungrow-ems.test.js`.

| Vorgabe | Stellglied am Sungrow | Kombination / Grenzen | Genauigkeit |
|---|---|---|---|
| EOS SELF_CONSUMPTION, keine Regel | Modus 0 (WR regelt selbst) | Puffer −40 W liegt im Band | exakt (WR-eigene Regelung) |
| EOS NON_EXPORT / IDLE (Akku halten) | Akku-Leistung (Modus 3), Sollwert = Last − PV − Puffer | nie Laden aus dem Netz (auch ohne Netzlade-Freigabe), Entladen höchstens Netto-Last | näherungsweise (10-s-Takt) |
| EOS FORCED_CHARGE / GRID_SUPPORT_IMPORT (Faktor) | Akku-Leistung Laden | nur mit Netzlade-Freigabe (EEG/MiSpeL), gedeckelt von Netzanschluss/§14a/Schwelle, BDC | näherungsweise |
| EOS GRID_SUPPORT_EXPORT | Akku-Leistung Entladen | nur mit Freigabe Netzentladung (≤ −1000 W), SoC-Boden, BDC; der WR begrenzt die Entladung zusätzlich auf eine gesetzte Einspeisegrenze (Doku Kap. 3.2 Note 2) | näherungsweise |
| EOS PV-Überschuss einspeisen (dcExportMode) | Akku lädt nur den Rest aus PV | Laden ≤ PV − Last | näherungsweise |
| EOS PEAK_SHAVING mit `peak_shaving_threshold_w` | Akku-Leistung Entladen über der Schwelle | Decke `batteryCeilingW` (EOS-Schwelle, Netzanschluss, §14a — kleinste gilt) | näherungsweise |
| Netzanschluss-Grenze (Bezug) | wie oben, „Akku zuerst“ erkennt den Sollwert als Hebel | Lasten werden erst gekürzt, wenn der Akku nicht reicht | näherungsweise |
| §14a-Dimmung inkl. Akku-Hilfe | wie oben über `batteryAssist` | strengstes Ziel gewinnt | näherungsweise |
| Feste Einspeisegrenze 60/70 %/W | **Gerät selbst** (13074/13088, vom Installateur gesetzt); DVhub überwacht nur | DVhub sichert und restauriert sie bei jeder Abregelung | exakt (WR-eigene Regelung); setzen über DVhub geht nicht |
| DV-Abregelung, §51 negativer Preis | Einspeisebegrenzung 0 W (13088/13074/13087) | gesichert/wiederhergestellt; Akku-Steuerung läuft weiter | exakt (WR regelt am Zähler) |
| DV-Teilvorgabe (LUOX x %), EEBUS LPP | **geht nicht als Teilgrenze** — kein Begrenzer im Profil, DVhub nimmt die volle Sperre (vorhandener Rückfall, sichere Seite) | — | zu streng (0 statt x %) |
| SoC-Boden | Entladung → 0 W → Self-consumption | vor jedem Write | exakt |
| Not-Halt | einmal Stopp + Modus 0, dann nichts (auch kein Herzschlag) | eigener Betrieb nur; fremdes EMS nie | exakt |
| E-Auto / Geräte | eigene Stellglieder, Sungrow nicht berührt | ihre Last zieht der Regler im nächsten Takt mit | näherungsweise |

## Quellen

- Sungrow „Communication Protocol of Residential Hybrid Inverter“ V1.1.9 (2025-06-20): Tabelle 4 (13050, 13051,
  13052, 13080, 13074, 13087, 13088), Kap. 3.1, 3.2, 3.5, Appendix 2 und 6
- Gegenprüfung der Adressen/Vorzeichen (kein Code übernommen): evcc-Template `sungrow-hybrid` (MIT),
  mkaiser/Sungrow-SHx-Inverter-Modbus-Home-Assistant (MIT)
