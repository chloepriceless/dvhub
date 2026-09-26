# Planbare Verbraucher (Geschirrspüler, Heizstab, …)

Stand: 2026-09-26 | Betrifft: DVhub Optimizer + Geräte-Service + MQTT/Home-Assistant

Benutzerdefinierte, planbare Verbraucher, die DVhub **mitplant** und über einen
wählbaren Endpunkt schaltet. Zwei Geräteklassen:

| Klasse | Beispiel | Planung | Ansteuerung |
|---|---|---|---|
| `deferrable` | Geschirrspüler, Waschmaschine | **EOS-nativ** als `home_appliance` (Energie + Mindestlaufzeit + „fertig bis"-Deadline). EOS legt den Lauf in die günstigste/PV-reichste Zeit. | An/Aus |
| `modulating` | MYPV **Elwa**, **AC Thor** | **DVhub-PV-Überschuss-Regler** mit echter Leistungsmodulation (0…max), optional Ziel/Deadline-Boost. | Leistungs-Sollwert |

> **Warum der Heizstab nicht EOS-nativ moduliert:** EOS' genetic-Solver (v0.4)
> optimiert genau **ein** EV-artiges Gerät (das Auto). Ein zweites modulierendes
> Gerät ist dort nicht co-optimierbar. DVhub regelt den Heizstab deshalb selbst dem
> PV-Überschuss nach (wie MYPV es nativ tut); sein Verbrauch senkt die Einspeisung,
> worauf der EOS-Akkuplan im nächsten 15-min-Takt reagiert.

## Gerät anlegen (API)

`POST /api/devices/schedulable` (LAN: kein Token nötig; sonst Bearer):

```jsonc
// deferrable (Geschirrspüler)
{ "id": "dishwasher", "name": "Geschirrspüler", "kind": "deferrable",
  "plan": { "energyWh": 1200, "durationH": 2, "deadline": "18:00", "earliestStart": "08:00" },
  "endpoint": { "type": "shelly", "shellyDeviceId": "shelly-kueche" } }

// modulating (MYPV Elwa)
{ "id": "elwa", "name": "MYPV Elwa", "kind": "modulating",
  "plan": { "maxPowerW": 3000, "minPowerW": 100, "capacityWh": 8000, "targetPct": 80, "deadline": "20:00" },
  "endpoint": { "type": "mqtt_publish", "powerTopic": "elwa/power/set", "powerTemplate": "{value}" } }
```

- `GET /api/devices/schedulable` → Liste + Auswahlhilfen (`shellyDevices`, bekannte
  `mqttTopics`) + `bridge`-Status.
- `DELETE /api/devices/schedulable/<id>` → entfernen.

Validierung: `id` (A-Z a-z 0-9 _ -), `name`, `kind`, `plan` (klassenabhängig),
`endpoint`. Modulierende Geräte akzeptieren **keinen** reinen Shelly-Endpunkt (kann
nicht modulieren).

## Endpunkt-Typen

| `endpoint.type` | Verhalten |
|---|---|
| `mqtt_expose` | DVhub publiziert den **gewollten** Zustand retained unter `<prefix>/device/<id>/desired` (An/Aus) bzw. `…/desired_power_w` (Watt) und legt read-only **HA-Discovery**-Entitäten an (`binary_sensor …_(Plan)`, `sensor …_Soll-Leistung`). Eine HA-Automation schaltet das reale Gerät. |
| `shelly` | DVhub schaltet ein zugeordnetes Shelly-Gerät direkt (`endpoint.shellyDeviceId`). Nur An/Aus. |
| `mqtt_publish` | DVhub publiziert an ein **fremdes** Command-/Leistungs-Topic (`commandTopic` + `onPayload`/`offPayload`, bzw. `powerTopic` + `powerTemplate` mit `{value}`). Für bereits über MQTT verfügbare Schalter/Geräte. |

## MQTT-Topics

- **Geräte-Soll (mqtt_expose):** `dvhub/device/<id>/desired` = `ON`/`OFF` (retained),
  `dvhub/device/<id>/desired_power_w` = Watt (modulierend).
- **Geräte-Plan:** im Gesamtplan `dvhub/optimizer/plan` unter `devices[]`
  (deferrable: `{ device, kind:"deferrable", start, end, action:"on" }`;
  modulating: `{ device, kind:"modulating", powerW, reason }`).

## Ausführung

Eine 30-s-Bridge (`services/optimizer/eos-device-bridge.js`) liest je Takt den
EOS-Dispatch (deferrable) bzw. rechnet den Überschuss-Sollwert (modulating) und setzt
ihn über den Endpunkt um (Dedup: nur bei Änderung). Im Lese-Modus (`DVHUB_READ_ONLY=1`)
schaltet die Bridge nicht.

## Grenzen / offen

- Das exakte EOS-Appliance-Dispatch-Spaltenformat der Lösung ist defensiv geparst
  (`services/optimizer/eos-devices.js: parseApplianceRowsDispatch`) und gegen ein
  echtes EOS mit aktiver Appliance + Forecast final zu bestätigen.
- Modulierende Geräte: der Deadline-Boost wirkt erst mit einem thermischen Ist-Wert
  (`socPct`); ohne Sensor läuft der Heizstab rein überschussgeführt.
