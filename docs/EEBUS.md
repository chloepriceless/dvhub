# EEBUS in DVhub

DVhub spricht EEBUS (SHIP/SPINE) über den Hilfsprozess **dvhub-eebus**, gebaut auf
[openeebus](https://github.com/NIBEGroup/openeebus) von NIBE (Apache-2.0). Zwei Rollen:

- **§14a-Steuerbox (Netzbetreiber):** DVhub ist das „Controllable System“. Die Steuerbox
  begrenzt den Bezug (LPC, §14a EnWG) und die Einspeisung (LPP) und liest den
  Netzanschlusspunkt (MGCP).
- **EEBUS-Geräte:** DVhub ist Energiemanager. Wärmepumpen und Wallboxen mit EEBUS bekommen
  Leistungsgrenzen (LPC/LPP), melden ihre Leistung (MPC), Wärmepumpen kündigen
  verschiebbare Verdichterläufe an (OHPCF), die DVhub einplant.

## Einrichten

1. **Einstellungen → System → EEBUS → „EEBUS aktivieren“**, speichern, DVhub neu starten.
   - Nativ (Debian/Raspberry Pi OS): Der Neustart baut dvhub-eebus im Hintergrund
     (`eebus-provision.sh`: Toolchain, libwebsockets, cJSON, Avahi, ~1 min auf einem Pi 4).
     DVhub erkennt das fertige Programm von selbst.
   - Container: dvhub-eebus ist im Image. Für mDNS nutzt der Container das Avahi des Hosts
     (D-Bus-Socket eingebunden, balena: `io.balena.features.dbus`) oder startet ein eigenes
     (Host-Netz nötig).
2. **Integrationen → EEBUS** zeigt die eigene **SKI** (Kennung von DVhub, 40 Hex-Zeichen).
3. **Koppeln** — beide Seiten müssen sich vertrauen:
   - In DVhub: Gegenstelle aus „Im Netz gefunden“ wählen, Rolle setzen (Steuerbox / Gerät),
     „Vertrauen“. Alternativ SKI von Hand eintragen oder „Kopplungsanfragen annehmen“.
   - In der Gegenstelle: DVhubs SKI eintragen. Bei der Steuerbox übernimmt das der Netz-
     bzw. Messstellenbetreiber.
4. Port: Standard **4712/TCP** (SHIP), im Heimnetz erreichbar; mDNS (UDP 5353) muss
   durchkommen.

Es kann genau **eine Steuerbox** gekoppelt sein, Geräte beliebig viele.

## Was DVhub mit den Grenzen macht

| Vorgabe | Umsetzung |
|---|---|
| Bezugsgrenze (LPC) | Akku lädt nicht aus dem Netz (Sollwert bleibt beim Eigenverbrauch). Wallbox und gekoppelte EEBUS-Geräte teilen sich die Grenze anteilig nach Nennleistung; unter dem Mindeststrom lädt die Wallbox nicht. |
| Einspeisegrenze (LPP) | Einspeisebegrenzer des Wechselrichters (Victron `MaxFeedInPower`, Reg. 2706; der vorherige Wert wird gesichert und zurückgeschrieben). Gilt gleichzeitig eine Teilvorgabe des Direktvermarkters (LUOX), gilt die kleinere. Ohne Begrenzer wird die Einspeisung gesperrt. |
| Netzanschlusspunkt (MGCP) | Leistung (Bezug positiv) und Zählerstände Bezug/Einspeisung, die DVhub seit dem Einschalten selbst zählt. |

Die Wallbox wird nur begrenzt, wenn DVhub sie steuert (Integrationen → Wallbox, EOS-Steuerung).

## Anzeige

- **Leitstand → „§14a · EEBUS“** (nur bei eingeschaltetem EEBUS): Steuerbox verbunden/getrennt,
  Bezugs- (LPC) und Einspeisegrenze (LPP) mit Zustand und Ablauf, was DVhub gerade umsetzt.
- **Integrationen → EEBUS**: Kopplung, gefundene Gegenstellen, Details.
- **Protokoll**: jeder Schreibversuch der Steuerbox (`paragraph14a_write`, abgelehnt:
  `paragraph14a_write_denied`), angenommene Grenzen (`paragraph14a_limit_received`) und ihre
  Umsetzung (`paragraph14a_consumption_limited` …).

## Zustände (LPC/LPP)

Nach der EEBUS-Spezifikation:

| Zustand | Bedeutung |
|---|---|
| Start | nach dem Start, bis die Steuerbox sich meldet |
| frei | Steuerbox verbunden, keine Grenze |
| begrenzt | Grenze der Steuerbox, bis zu ihrem Ablauf oder ihrer Aufhebung |
| Failsafe | **120 s ohne Heartbeat** der Steuerbox → Failsafe-Grenze, mindestens für die Failsafe-Dauer (2–24 h). Eine neue Grenze der wieder verbundenen Steuerbox beendet ihn vorher. |
| frei (autonom) | Failsafe-Dauer abgelaufen, Steuerbox weiterhin nicht erreichbar |

- Failsafe-Werte setzt die Steuerbox. Bis dahin gelten die Einstellungen: Bezug 4200 W,
  Einspeisung = maximale Einspeiseleistung (keine Einschränkung), jeweils 2 h.
- Von der Steuerbox geschriebene Failsafe-Werte und ein laufender Failsafe überdauern einen
  Neustart (`<Datenordner>/eebus/grid-state.json`). Wird eine andere Steuerbox gekoppelt,
  gelten wieder die Einstellungen.
- **Ohne gekoppelte Steuerbox gibt es keinen Failsafe** — Anlagen ohne §14a bleiben unbegrenzt.

## Verdichterläufe (OHPCF)

Kündigt eine gekoppelte Wärmepumpe einen verschiebbaren Lauf an (frühester Start, spätestes
Ende, Mindestlaufzeit), legt DVhub den Start je nach Einstellung in die günstigste
Börsenpreis-Phase des Fensters, frühestmöglich oder gar nicht. OHPCF ist in openeebus noch
als Entwurf gekennzeichnet.

## Geräte-Tausch

Zertifikat und Schlüssel (`<Datenordner>/eebus/cert.pem`, `key.pem`) sind DVhubs EEBUS-
Identität — die Steuerbox kennt DVhub nur über die SKI daraus. Der verschlüsselte volle Export
enthält sie, Failsafe-Zustand und Zählerstände; nach dem Import gilt die Kopplung weiter.

## Technik

- `dvhub/eebus/bridge/` — dvhub-eebus (C): lokales SPINE-Gerät „EnergyManagementSystem“
  mit vier Entitäten: [1] CEM/CS LPC, [2] CEM/CS LPP, [3] CEM mit EG LPC/LPP, MA MPC, CEM OHPCF,
  [4] GridConnectionPointOfPremises/GCP MGCP. Protokoll mit DVhub: eine JSON-Zeile je
  Befehl (stdin) bzw. Ereignis (stdout), siehe `main.c`.
- `dvhub/eebus/openeebus.pin` — gepinnter openeebus-Stand (Commit + Prüfsumme),
  `dvhub/eebus/patches/` — eigene Korrekturen, als Pull Requests an NIBE gemeldet:
  Absturz bei leeren Eingaben in `ServiceDetailsConstruct`, Verbindung über die von Avahi
  aufgelöste Adresse (ohne nss-mdns kam keine Verbindung zustande), größere
  Websocket-Schreibwarteschlange (die SPINE-Erkennung zwischen umfangreichen Geräten
  überlief sie und trennte die Verbindung).
- `services/eebus/` — Dienst in DVhub (Überwachung, Zustandsmaschinen, Umsetzung),
  `services/feed-in-limit-arbiter.js` — eine Einspeisegrenze für alle Quellen.
- Speicher: dvhub-eebus ~13 MB.

## Tests

- `dvhub/eebus/test/interop.py` — dvhub-eebus gegen die openeebus-Beispiele (hems als
  Steuerbox, heat_pump als Gerät), 26 Prüfungen.
- `dvhub/eebus/test/e2e-dvhub.py` — laufendes DVhub mit EEBUS, nur über die API: Kopplung,
  §14a-Grenze → Akku/Wärmepumpe, Einspeisegrenze, Aufhebung, Failsafe nach 120 s, 16 Prüfungen.
- Node-Tests `test/eebus-*.test.js`.

Geprüft gegen die Referenzprogramme von openeebus. Gegen eine echte Steuerbox und einen
EEBUS-Konformitätstester steht der Test noch aus; eine Zertifizierung hat DVhub nicht.

## Fehlersuche

| Meldung | Ursache |
|---|---|
| „nicht installiert“ | Bau läuft noch oder schlug fehl: `journalctl -u dvhub-eebus-provision` |
| „EEBUS-Port … ist belegt“ | anderer EEBUS-Dienst auf dem Gerät, Port in den Einstellungen ändern |
| Gegenstelle „nicht verbunden“ | DVhubs SKI in der Gegenstelle fehlt, Port 4712 gesperrt, mDNS (Avahi) läuft nicht |
| Grenze kommt nicht an | Gegenstelle als „Gerät“ statt „Steuerbox“ gekoppelt (Grenzen nimmt DVhub nur von der Steuerbox) |
