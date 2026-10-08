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

## §14a: Aufteilung und Mindestleistung

DVhub ist das Energie-Management-System im Sinne der BNetzA-Festlegung BK6-22-300 (Anlage 1,
Ziffer 4.4.b „Steuerung mittels EMS“). Einstellungen: **System → §14a**, Geräteliste und Rechenweg:
**Integrationen → §14a**.

- **Quellen:** die EEBUS-Steuerbox schickt einen Wert. Eine FNN-Steuerbox mit **Relais** meldet nur
  „gedimmt“ (MQTT-Thema, z. B. Digitaleingang des Victron GX oder ein Shelly-Eingang) — dann gilt die
  Mindestleistung. Kommen beide, gilt die kleinere Grenze.
- **Mindestleistung Pmin,14a** (Ziffer 4.5.2, bestätigt vom VDE FNN Hinweis zu Tenorziffer 2f, 04/2025):
  `4,2 kW + (n − 1) × GZF × 4,2 kW`; mit Wärmepumpen oder Klimaanlagen über 11 kW ersetzt
  `max(0,4 × ΣP_WP ; 0,4 × ΣP_Klima)` die ersten 4,2 kW. GZF: 0,8 bei zwei SteuVE, je weitere 0,05
  weniger, ab neun 0,45. Beispiele: Wallbox + Speicher 7,56 kW; mit Wärmepumpe 10,5 kW.
  - Steuerbare Verbrauchseinrichtungen (SteuVE) sind nur Anlagen über 4,2 kW; mehrere Wärmepumpen bzw.
    Klimaanlagen zählen je Fallgruppe als eine (Ziffer 2.4.2).
  - Direkt angesteuerte Anlagen (Ziffer 4.4.a) haben eine eigene Mindestleistung und zählen nicht mit.
- **Geräte:** automatisch die Wallbox (EOS-Steuerung), der Stromspeicher (Max. Ladeleistung) und
  gekoppelte EEBUS-Geräte; Anlagen, die DVhub nicht steuert, von Hand. Sie zählen für Pmin,14a.
- **Budget:** begrenzt ist nur der netzwirksame Bezug (Ziffer 2.3): Grenze + PV-Überschuss
  (abschaltbar).
- **Aufteilung** (Ziffer 4.5.2 Satz 6, nach eigener Maßgabe): nach Vorrang (Standard: Wärmepumpe →
  Klima → Wallbox → Speicher) oder anteilig nach Leistung. Der Speicher lädt höchstens mit seinem
  Anteil aus dem Netz (Grid-Setpoint, der Haushalt zählt mit), die Wallbox bekommt ihren Anteil als
  Obergrenze, EEBUS-Geräte als LPC-Grenze.
- Liegt die Vorgabe unter Pmin,14a, setzt DVhub sie trotzdem um (Ziffer 4.6) und meldet es
  (`paragraph14a_below_minimum`, Leitstand, Installateurportal).
- Der Failsafe-Vorgabewert der Bezugsgrenze ist ohne eigenen Wert Pmin,14a (mindestens 4,2 kW).

## Was DVhub mit den Grenzen macht

| Vorgabe | Umsetzung |
|---|---|
| Bezugsgrenze (LPC) | Aufteilung auf Wärmepumpe, Wallbox und Speicher wie oben (§14a); unter dem Mindeststrom lädt die Wallbox nicht. |
| Einspeisegrenze (LPP) | Einspeisebegrenzer des Wechselrichters (Victron `MaxFeedInPower`, Reg. 2706; der vorherige Wert wird gesichert und zurückgeschrieben). Gilt gleichzeitig eine Teilvorgabe des Direktvermarkters (LUOX), gilt die kleinere. Ohne Begrenzer wird die Einspeisung gesperrt. |
| Netzanschlusspunkt (MGCP) | Leistung (Bezug positiv) und Zählerstände Bezug/Einspeisung, die DVhub seit dem Einschalten selbst zählt. |

Die Wallbox wird nur begrenzt, wenn DVhub sie steuert (Integrationen → Wallbox, EOS-Steuerung).

Geräte ohne EEBUS können der Grenze über MQTT folgen: DVhub veröffentlicht sie unter
`dvhub/control/grid_limit/*` (mit Home-Assistant-Erkennung) und für Loxone als
`dvhub_control_grid_limit_*` — siehe [MQTT-SCHEMA.md](MQTT-SCHEMA.md).

## Anzeige

- **Leitstand → „§14a / §9 · EEBUS“** (nur bei eingeschaltetem EEBUS): Steuerbox verbunden/getrennt,
  Bezugsgrenze (§14a EnWG, LPC) und Einspeisegrenze (§9 EEG, LPP) mit Zustand und Ablauf, was DVhub gerade umsetzt.
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
  Steuerbox, heat_pump als Gerät), 27 Prüfungen.
- `dvhub/eebus/test/e2e-dvhub.py` — laufendes DVhub mit EEBUS, nur über die API: Kopplung,
  §14a-Grenze → Akku/Wärmepumpe, Einspeisegrenze, Aufhebung, Failsafe nach 120 s, 16 Prüfungen.
- Node-Tests `test/eebus-*.test.js`.

Von Hand geprüft mit dem EEBUS-Handwerkertool (Installateurs-Tester) in der Rolle der
Steuerbox; die automatischen Tests laufen gegen die Beispielprogramme von openeebus. Mit einer
echten Steuerbox eines Netzbetreibers, einem echten EEBUS-Gerät (z. B. Wärmepumpe) und einem
EEBUS-Konformitätstester steht der Test noch aus; eine Zertifizierung hat DVhub nicht.

## Fehlersuche

| Meldung | Ursache |
|---|---|
| „nicht installiert“ | Bau läuft noch oder schlug fehl: `journalctl -u dvhub-eebus-provision` |
| „EEBUS-Port … ist belegt“ | anderer EEBUS-Dienst auf dem Gerät, Port in den Einstellungen ändern |
| Gegenstelle „nicht verbunden“ | DVhubs SKI in der Gegenstelle fehlt, Port 4712 gesperrt, mDNS (Avahi) läuft nicht |
| Grenze kommt nicht an | Gegenstelle als „Gerät“ statt „Steuerbox“ gekoppelt (Grenzen nimmt DVhub nur von der Steuerbox) |
