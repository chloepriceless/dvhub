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
4. Steuerung erst beobachten, dann einschalten: einen moderaten Netz-Sollwert von Hand setzen (z. B. −1000 W,
   Einspeisen) und in der App prüfen, dass der Wechselrichter in den Zwangsbetrieb geht und sich die Einspeisung
   etwa einstellt. Danach Sollwert löschen bzw. −40 W: der Wechselrichter muss zurück in Self-consumption.
5. Not-Halt einmal auslösen: der Wechselrichter muss in Self-consumption zurückfallen, danach schreibt DVhub nichts.

## Was DVhub schreibt

| Zweck | Register (Doku) | Wann |
|---|---|---|
| Akku: Self-consumption | 13051 = 0xCC, 13050 = 0 | Sollwert nahe 0 (±300 W), ohne frische Messwerte, ohne Sollwert seit 2 min, Not-Halt |
| Akku: Laden/Entladen | 13052 = Leistung (W), 13051 = 0xAA/0xBB, 13050 = 2 | Sollwert außerhalb ±300 W; Leistung alle 10 s nachgeführt, nur bei ≥ 100 W Änderung |
| Abregelung | 13088 = 0, 13074 = 0 W, 13087 = 0xAA | Direktvermarkter, §51 bei negativem Preis |
| Freigabe | gesicherte Werte von 13088/13074/13087 | Ende der Abregelung |

Nach jedem Write liest DVhub das Register zurück. Holding-Register liest DVhub nicht im Takt — das WiNet-S ist dafür
nicht gedacht. Ohne Bezugs-Wunsch lädt DVhub den Akku nie aus dem Netz, ohne Einspeise-Wunsch entlädt es ihn nie ins
Netz.

Wichtig: Im Zwangsbetrieb hat der Wechselrichter keinen eigenen Rückfall. Stürzt DVhub mitten im Laden oder Entladen
ab, läuft der Befehl weiter, bis der Akku an seiner SoC-Grenze steht. Der External-EMS-Modus mit Herzschlag (13080)
würde das abfangen; er folgt nach dem ersten Test.

## Quellen

- Sungrow „Communication Protocol of Residential Hybrid Inverter“ V1.1.9 (2025-06-20)
- Gegenprüfung der Adressen/Vorzeichen (kein Code übernommen): evcc-Template `sungrow-hybrid` (MIT),
  mkaiser/Sungrow-SHx-Inverter-Modbus-Home-Assistant (MIT)
