# dvhub-eebus: Protokoll, C-Bridge → Go

`dvhub-eebus` ist der EEBUS-Hilfsprozess von DVhub. Diese Fassung ist in Go auf
[enbility eebus-go](https://github.com/enbility/eebus-go) (MIT, dazu ship-go und
spine-go) gebaut und ersetzt die C-Bridge auf openeebus (`../bridge/`, bleibt als
Rückweg). `services/eebus/index.js` startet beide gleich und spricht mit beiden
dasselbe JSON-Zeilen-Protokoll. Neu sind nur die E-Auto-Meldungen und -Befehle
(Abschnitt 6).

Stand: 20.10.2026, eebus-go `v0.7.1-0.20260930170458-8583642861c3` (dev-Zweig,
siehe `go.mod`).

## 1. Aufruf und Lebenszyklus

| | C (`bridge/main.c`) | Go (`main.go`, `args.go`) |
|---|---|---|
| Zertifikat | `--gen-cert <cert> <key> <cn>` | gleich (genau 3 Werte, sonst Nutzungsfehler) |
| Start | `--port 4712 --cert … --key … [--vendor DVhub] [--brand DVhub] [--model DVhub] [--serial 0] [--role auto] [--trust <ski>]…` | gleich, gleiche Vorgaben, höchstens 32 `--trust` |
| `--role` | an openeebus (auto/client/server) | angenommen, aber ohne Wirkung: ship-go lauscht und verbindet immer selbst (Hinweis auf stderr, wenn nicht `auto`) |
| Nutzungsfehler | Text auf stderr, Exit 2 | gleich |
| Port belegt | `{"ev":"fatal","error":"port in use","port":p}`, Exit 1 | gleich |
| Start scheitert | `{"ev":"fatal","error":"start failed"}`, Exit 1 | gleich (Grund auf stderr, z. B. `cannot load certificate …`) |
| stdin | eine JSON-Zeile je Befehl; kaputte Zeile → stderr `ignoring malformed command` | gleich; Zeilen bis 1 MiB (C: 16 KiB) |
| Ende | stdin zu, SIGTERM oder SIGINT → sauber beenden, stderr `stopped`, Exit 0 | gleich |
| Takt | alle 5 s `grid_heartbeat_state` bei Änderung | gleich |
| Diagnose | stderr `dvhub-eebus: …` | gleich; eebus-go-Meldungen (Info/Fehler) ebenfalls; Debug mit `DVHUB_EEBUS_DEBUG=1` |
| mDNS | Avahi-Client (libavahi) | Avahi über D-Bus, sonst Go-Zeroconf (`DVHUB_EEBUS_MDNS=auto\|avahi\|zeroconf`, Vorgabe `auto`) |

Nach dem Start kommt `ready`, danach die Antworten auf die `--trust`-Einträge
(ohne `id`) — Reihenfolge wie bei der C-Bridge.

## 2. Zertifikat und SKI

Gleich wie `bridge/certgen.c`: EC P-256, SHA-256-Signatur, `CN=<cn>`, `O=DVhub`,
gültig ab gestern für 10 Jahre, 63-Bit-Zufallsseriennummer, BasicConstraints
`CA:TRUE` (kritisch), KeyUsage `digitalSignature, keyCertSign` (kritisch),
Subject Key Identifier = SHA-1 des öffentlichen Punkts (OpenSSL `hash`),
Schlüssel als PKCS#8-PEM mit Rechten 0600.

**Vorhandene Zertifikate gelten weiter:** ein von der C-Bridge erzeugtes
Zertifikat ergibt im Go-Binary dieselbe SKI (von Hand geprüft am 20.10.2026,
`7a0c6aed…`; dazu `cert_test.go` mit einer OpenSSL-Vorlage). Gekoppelte
Steuerboxen und Geräte erkennen DVhub also nach dem Wechsel wieder.

## 3. Entitäten

| Entität | C | Go |
|---|---|---|
| [1] CEM | CS LPC | CS LPC (`usecases/cs/lpc`) |
| [2] CEM | CS LPP | CS LPP (`usecases/cs/lpp`) |
| [3] CEM | EG LPC, EG LPP, MA MPC, CEM OHPCF | dieselben + **neu** CEM EVCC, EVCEM, EVSOC, OPEV, OSCEV, CEVC |
| [4] GridConnectionPointOfPremises | GCP MGCP (Leistung, Energie Bezug/Einspeisung) | GCP MGCP (`usecases/gcp/mgcp`), Szenarien 2–4 |

Herzschlag: [1], [2], [4] 60 s wie C; [3] 4 s (neu), weil Wallboxen mit
OPEV/OSCEV den Wert als Frist werten. Wie in der C-Bridge startet der
Herzschlag der Geräteseite erst mit der ersten Vorgabe an ein Gerät
(`device_limit` oder `ev_current_limits`).

## 4. Befehle (stdin)

Jeder Befehl mit `id` bekommt `{"ev":"reply","id":…,"cmd":…,"ok":bool[,"error":…]}`;
`id` kommt als Zahl oder Zeichenkette unverändert zurück. Fehlertexte sind
dieselben wie in `bridge.c`.

| `cmd` | Felder | C | Go | Gleich? |
|---|---|---|---|---|
| `trust` / `untrust` | `ski` (40 Zeichen) | `EEBUS_SERVICE_(UN)REGISTER_REMOTE_SKI` | `RegisterRemoteService` / `UnregisterRemoteService` | ja (`ski must be 40 hex characters`) |
| `pairing` | `on` | `SET_PAIRING_POSSIBLE` | `UserIsAbleToApproveOrCancelPairingRequests` | ja |
| `cancel_pairing` | `ski` | `CANCEL_PAIRING_WITH_SKI` | `CancelPairing` | ja (`ski missing`) |
| `grid_config` | `uc` lpc\|lpp, `nominal_max_w`, `failsafe_w`, `failsafe_duration_s` | `CsLpSetNominalMax`, `…FailsafeActivePowerLimit`, `…FailsafeDurationMinimum` | `SetConsumption/ProductionNominalMax`, `SetFailsafe…ActivePowerLimit`, `SetFailsafeDurationMinimum` | ja (`uc must be lpc or lpp`, `setting grid values failed`; Dauer außerhalb 2–24 h → Fehler) |
| `grid_limit_state` | `uc`, `w`, `active` | `CsLpSetActivePowerLimit` | `SetConsumption/ProductionLimit` | ja (`uc missing`, `w missing`; alles außer `lpc` ist LPP) |
| `gcp` | `power_w`, `energy_consumed_wh`, `energy_feed_in_wh` | MGCP-Cache + Update | `mgcp.Update(UpdateData…)` | ja; Antwort nur mit `id` |
| `device_limit` | `uc` lpc\|lpp, `entity`, `w`, `duration_s`, `active` | `EgLpSetActivePowerLimit` + `write_result` | `WriteConsumption/ProductionLimit` + `write_result` | ja (`unknown device entity`, `write failed`); `active` ohne Angabe = `w` vorhanden; `duration_s <= 0` löscht die Dauer |
| `device_failsafe` | `uc`, `entity`, `w`, `duration_s` | `EgLpSetFailsafe…` | `WriteFailsafe…` | ja; `write_result` über die Antwort auf den Nachrichtenzähler |
| `ohpcf` | `entity`, `action` schedule\|stop\|pause\|resume, `start_in_s` | `CemOhpcf…` | `SchedulePowerConsumptionProcess`, `Abort…`, `Pause…`, `Resume…` | ja (`unknown compressor entity`, `ohpcf command failed`) |
| `status` | – | `{"ev":"status","ski",lpc:{w,active,heartbeat_ok},lpp:{…},id}` | gleich | ja |
| unbekannt / ohne `cmd` | | `unknown command` / `no command` | gleich | ja |
| **`ev_current_limits`** | siehe 6.2 | – | neu | – |

`write_result`: `{"ev":"write_result","id":<id als Ganzzahl, sonst 0>,"ok":bool}` — wie C.

## 5. Meldungen (stdout)

Entitätsbezogene Meldungen tragen wie in C `uc`, `entity` (`"d:_n:NIBE_123/1/1"`)
und `ski`.

| `ev` | Felder | Go-Quelle | Gleich? |
|---|---|---|---|
| `ready` | `ski`, `ship_id` (`<brand>-<model>-<serial>`), `port`, `qr` | Service-Setup | ja; `qr` im ship-go-Format (SKI klein ohne Leerzeichen, mit `SERIAL`, `CAT`) |
| `fatal` | `error`, `port` | – | ja |
| `connected` / `disconnected` | `ski` | `RemoteServiceConnected/Disconnected` | ja |
| `mdns` | `services[]`: `ski`, `name`, `id`, `brand`, `model`, `type` | `VisibleRemoteMdnsServicesUpdated` | **teilweise**: `host`, `port`, `register` gibt ship-go nicht heraus und fehlen (DVhub setzt `null`/`false`); neu `serial` |
| `ship_id` | `ski`, `ship_id` | `ServiceUpdated`, Verbindungsaufbau | ja; nur bei Änderung |
| `ship_state` | `ski`, `state`, `label` waiting_trust\|rejected | `ServicePairingDetailUpdate` | `label` gleich (DVhub nutzt nur das); `state` ist der ship-go-Verbindungszustand statt openeebus' SmeState |
| `grid_eg_added` / `grid_eg_removed` | `uc`, `entity`, `ski` | `UseCaseSupportUpdate` (CS LPC/LPP) | ja |
| `grid_write` | `uc`, `kind` limit\|failsafe_limit\|failsafe_duration, `ski`, `w`/`duration_s`, `active`, `approved` | `LimitWriteApprovalRequired`, `ConfigurationWriteApprovalRequired` | ja, gleiche Regeln (unten) |
| `grid_write_expired` | `uc`, `ski` | – | **entfällt**: Freigaben laufen sofort, nichts verfällt |
| `grid_limit` | `uc`, `w`, `duration_s`, `active` | `DataUpdateLimit` | ja |
| `grid_failsafe_limit` / `grid_failsafe_duration` | `uc`, `w` / `duration_s` | `DataUpdateFailsafe…` | ja; keine „Spiegelmeldungen“ des anderen Anwendungsfalls mehr (eigene Entitäten) |
| `grid_heartbeat` | `uc`, `counter` | `DataUpdateHeartbeat` | jeder 12.; `counter` zählt die empfangenen Herzschläge (eebus-go reicht den Zähler der Steuerbox nicht durch) |
| `grid_heartbeat_state` | `lpc_ok`, `lpp_ok` | Takt, `IsHeartbeatWithinDuration` (2 min) | ja |
| `device_added` / `device_removed` | `uc` lpc\|lpp\|mpc\|ohpcf, `entity`, `ski` | `UseCaseSupportUpdate`; beim Trennen für alle Entitäten der SKI | ja |
| `device_limit` | `uc`, `entity`, `ski`, `w`, `duration_s`, `active` | EG `DataUpdateLimit` | ja |
| `device_failsafe_limit` / `device_failsafe_duration` | `w` / `duration_s` | EG `DataUpdateFailsafe…` | ja |
| `device_nominal_max` | `uc`, `w` | EG `DataUpdatePower…NominalMax` | ja (eebus-go liest sie beim Verbinden selbst) |
| `device_measurement` | `uc` mpc, `name`, `value` | MA MPC `DataUpdate…` | ja, gleiche Namen (`power_w`, `power_l1_w`…, `energy_consumed_wh`, `energy_produced_wh`, `current_l1_a`…, `voltage_l1_v`…, `frequency_hz`) |
| `ohpcf_announce` | `max_power_w`, `earliest_start_s`, `latest_end_s`, `min_duration_s`, `stoppable`, `pausable` | SmartEnergyManagementPs-Daten (eigene Auswertung, `ohpcf.go`) | ja (siehe unten) |
| `ohpcf_state` | `state`, `start_in_s` | dito | ja; Abbruch („invalid“) heißt `stopped` (openeebus: `undefined`) |
| `ohpcf_clear` | | dito | ja |
| `reply`, `status`, `write_result` | | | ja |

**Freigaberegeln** (gleich wie `bridge.c`, `rules.go`): LPC-Grenze `w >= 0`,
LPP-Grenze `w <= 0` [LPP-TS-001], Dauer `>= 0`; Failsafe-Grenze `>= 0`;
Failsafe-Dauer 2–24 h. Abweichung: eebus-go fasst die Failsafe-Werte eines
Schreibvorgangs zusammen — enthält einer Grenze **und** Dauer, wird er nur als
Ganzes angenommen oder abgelehnt (C: je Wert).

**OHPCF:** eebus-go meldet jede Teiländerung einzeln; die Bridge wertet die
Daten des Verdichters selbst aus: keine Alternative → `ohpcf_clear`;
Zustand `inactive` mit Leistung (powerMax, sonst power), frühestem Start,
spätestem Ende und Mindestlaufzeit → `ohpcf_announce` + `ohpcf_state announced`;
sonst `ohpcf_state` (bei `scheduled` mit `start_in_s`). Gleiche Daten werden nur
einmal gemeldet. openeebus unterschied Ankündigung und Ende an
`nodeScheduleInformation`; das Ergebnis gegen openeebus' `heat_pump` ist gleich
(Interop-Test).

## 6. Neu: E-Auto an der Wallbox (DVhub als CEM)

Die entfernte Entität ist die des **Autos** (unter dem Ladepunkt der Wallbox,
z. B. `d:_n:Wallbox_1/1/1`). Meldungen tragen `ski` und `entity`; nur
gelieferte Werte erscheinen, fehlende werden weggelassen.

### 6.1 Meldungen

| `ev` | Felder | Anwendungsfall |
|---|---|---|
| `ev_connected` | – | EVCC: Auto angesteckt (danach `ev_data`) |
| `ev_disconnected` | – | EVCC: Auto abgesteckt; auch beim Trennen der Wallbox |
| `ev_data` | `charge_state` (unplugged\|error\|paused\|active\|finished\|Unknown), `comm_standard` (iso15118-2ed1\|iso15118-2ed2\|iec61851), `asymmetric`, `ids[]` {type, value}, `manufacturer` {brand, device, device_code, vendor, vendor_code, serial, software, hardware, label}, `power_min_w`, `power_max_w`, `power_standby_w`, `sleep` | EVCC |
| `ev_measurement` | `phases`, `current_a[]` (je Phase), `power_w[]`, `power_total_w`, `energy_wh` | EVCEM |
| `ev_soc` | `soc` (%) | EVSOC — nur wenn das Auto ihn liefert (ISO 15118-20) |
| `ev_limits` | `uc` opev\|oscev, `min_a[]`, `max_a[]`, `default_a[]`, `limits[]` {phase a\|b\|c, active, value_a, changeable} | OPEV/OSCEV: zulässige Ströme und aktuelle Grenzen |
| `ev_charge_plan` | `strategy` (nodemand\|directcharging\|minsoc\|timedcharging\|unknown), `demand` {min_wh, opt_wh, max_wh, start_in_s, end_in_s}, `plan[]` {start_ms, end_ms, w, min_w, max_w} | CEVC (nur lesen) |

### 6.2 Befehl `ev_current_limits`

```json
{"cmd":"ev_current_limits","id":7,"ski":"<wallbox>","entity":"<auto, optional>","uc":"opev","amps":[16,16,16]}
```

- `uc`: `opev` (Vorgabe; Höchststrom, Überlastschutz) oder `oscev`
  (Empfehlung für Eigenverbrauch). Sonst `uc must be opev or oscev`.
- `amps`: 1–3 Werte in A je Phase L1–L3; ein einzelner Wert gilt für alle drei
  Phasen (eebus-go überspringt Phasen, die das Auto nicht hat, und begrenzt auf
  die zulässigen Werte). `null` hebt die Grenze auf (inaktiv mit dem Höchststrom
  der Phase). Fehlt `amps` → `amps missing`.
- Auto über `entity` oder, ohne `entity`, das erste der `ski` mit diesem
  Anwendungsfall. Keines → `unknown ev entity`.
- Antwort `reply`, Ergebnis der Wallbox als `write_result` (gleiche `id`).

Node-Seite: `ui.devices[ski].ev` (`connected`, `entity`, `chargeState`, `soc`,
`phases`, `phasesA`, `powerPerPhaseW`, `powerW`, `energyWh`, `vehicle`,
`limits.opev|oscev`, `plan`) und `setEvCurrentLimits(ski, ampsPerPhase|null, {uc})`
in `services/eebus/index.js`.

## 7. Abweichungen und Grenzen (Übersicht)

1. `--role` ohne Wirkung (ship-go entscheidet selbst).
2. `mdns` ohne `host`, `port`, `register`.
3. `ship_state.state` mit anderen Zahlen (nur `label` zählt).
4. `grid_write_expired` gibt es nicht mehr.
5. `grid_heartbeat.counter` ist ein eigener Zähler.
6. Failsafe-Schreibvorgänge werden als Ganzes freigegeben.
7. OHPCF-Abbruch heißt `stopped` statt `undefined`.
8. SPINE-Geräteadresse: eebus-go bildet `d:_n:<vendor>_<model>-<serial>`
   (z. B. `d:_n:DVhub_DVhub-<serial>`), openeebus `d:_n:<vendor>_<serial>`. Die
   Gegenstelle lernt sie bei jeder Verbindung neu; Kopplung hängt an der SKI.
9. Herzschlag der Geräteseite 4 s statt 60 s.
10. eebus-go-Fehler behoben: GCP MGCP meldete sich mit dem Akteur
    `MonitoringAppliance`; die Bridge setzt `GridConnectionPoint` (wie openeebus).
    Ohne das findet eine Steuerbox den Netzanschlusspunkt nicht
    (`integration_test.go`, Gegenprobe rot). Als Upstream-Fehler melden.
11. Speicher: ~18 MB RSS gegen ~8 MB bei der C-Bridge (Interop-Lauf);
    Binary 14,3 MB (arm64) / 15,5 MB (amd64) statisch statt 0,8 MB plus
    libwebsockets/cJSON/OpenSSL/Avahi-Client.

## 8. Bauen, Testen, Rückweg

- Bauen: `dvhub/eebus/build-go.sh <dir> [arm64 amd64]` (statisch, `CGO_ENABLED=0`,
  `-trimpath -ldflags "-s -w"`); ohne lokales Go im Container `golang:1.27.2-alpine`.
  Image: Bau-Stufe `eebus-go` im `Dockerfile` (Quer-Kompilierung auf der
  Build-Plattform, kein QEMU).
- Tests: `go test ./...` in `dvhub/eebus/go` — Protokoll (Meldungsformat,
  Befehle → Antworten, Argumente, Prüfregeln, Zertifikat), Abbildung der
  eebus-go-Ereignisse mit Attrappen (Netzseite, E-Auto, OHPCF), Prozess
  (stdin/stdout, Port belegt, Ende) und zwei eebus-go-Knoten gegeneinander über
  echtes SHIP (Steuerbox → DVhub mit LPC/LPP/Failsafe/Herzschlag/MGCP; DVhub →
  Wärmepumpe mit LPC/MPC/Trennen). `DVHUB_EEBUS_SKIP_INTEGRATION=1` überspringt die
  Netztests.
- Gegen openeebus: `dvhub/eebus/test/interop.py` mit dem Go-Binary gegen
  openeebus' `hems` und `heat_pump` — 27/27 wie die C-Bridge (20.10.2026, im
  Container mit Avahi).
- Nativ: `eebus-provision.sh` lädt Go von go.dev (Version und Prüfsummen in
  `../go-toolchain.pin`, gleich wie im Container), baut mit `build-go.sh` unter
  `/var/tmp` und ersetzt das Binary erst nach dem Selbsttest
  (`test/eebus-provision.test.js`; echter Bau in `debian:trixie` arm64: 13 s,
  unter 600 MB, 20.10.2026).
- Rückweg: `docker buildx build --build-arg EEBUS_IMPL=c …` baut wieder die
  C-Bridge; nativ `touch $DATA_DIR/.eebus-impl-c` und `eebus-provision.sh`.

## 9. Ungeprüft und offene Risiken

- **Abbau nicht gemeldet (ship-go):** in 3 von 75 Läufen von
  `TestIntegrationDVhubGegenWaermepumpe` (20.10.2026) kam nach dem Abschalten der
  Gegenstelle kein `disconnected` (auch nicht nach 150 s), in 2 davon nach einer
  Doppelverbindung beim Aufbau (frühes `disconnected` vor `connected`). DVhub
  zeigt das Gerät dann weiter als verbunden. Ursache liegt in der
  Verbindungsverwaltung von ship-go (dev-Stand); ob es mit echten Geräten
  auftritt, ist ungeprüft. Der Test überspringt diesen Teil dann mit Meldung.

- Echte Steuerbox eines Netzbetreibers, EEBUS-Handwerkertool, echte Wärmepumpe
  oder Wallbox mit dem Go-Binary — nichts davon getestet.
- **E-Auto-Anwendungsfälle nur mit Attrappen geprüft**: eebus-go hat keine
  EVSE/EV-Gegenseite; Verhalten an einer echten Wallbox (Elli, Vaillant, …) und
  mit echten Autos ist ungeprüft, ebenso ob CEVC ohne Leistungsgrenzen/Anreize
  von DVhub einen Ladeplan liefert.
- Avahi über den D-Bus des Hosts im Container (EnergyLink/balena) mit dem
  Go-Binary — nur Avahi im selben Container geprüft (Interop-Lauf).
- Verhalten von Steuerboxen, die die neue SPINE-Geräteadresse (Punkt 7.8) nicht
  erwarten.
