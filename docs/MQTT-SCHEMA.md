# DVhub MQTT-Schema — Status, Steuerbefehle, Eingänge

Stand: 2026-09-14 | Zielgruppe: Betreiber mit Home Assistant, Loxone, Node-RED o. ä. | Voraussetzung: ein gemeinsamer MQTT-Broker (Integrationen → MQTT Hub)

DVhub spricht über MQTT in drei Richtungen. Alle Topics liegen unter dem **Topic-Prefix** (Standard `dvhub`, einstellbar unter Integrationen → MQTT Hub → Einstellungen):

| Richtung | Topic-Muster | Wer publiziert | Wozu |
|---|---|---|---|
| Status nach außen | `dvhub/energy/…`, `dvhub/battery/…`, `dvhub/solar/…`, `dvhub/price/…`, `dvhub/optimizer/…`, `dvhub/system/…` | DVhub, retained, alle 5 s | Messwerte und Zähler für Dashboards |
| **Steuerbefehle nach außen** | `dvhub/control/<ziel>` | DVhub, retained, alle 5 s | Was DVhub gerade will (Sollwerte), damit ein fremder Akku/Wechselrichter in HA oder Loxone daran hängen kann |
| **Eingänge von außen** | `dvhub/input/…` (Lesewerte) und `dvhub/control/<ziel>/set` (Befehle an die Anlage) | HA/Loxone liefern `input`, DVhub sendet `…/set` | Anlagen, deren Akku/PV/Zähler nur in HA oder Loxone existieren (Profil „Universal (DVhub-MQTT-Schema)") |

Payload ist überall eine **nackte Zahl** (`-2500`, `17.5`) bzw. `null`, wenn ein Wert unbekannt ist; Zeichenketten und Objekte sind JSON-kodiert. DVhub erfindet keine 0: `null` heißt „kein Wert", nicht „0 W".

---

## 1. Steuerbefehle nach außen: `dvhub/control/*`

DVhub schreibt seine Sollwerte über Modbus oder die MQTT-Bridge an die Anlage. Diese Topics **spiegeln** denselben Zustand — transparent, retained, alle `publishIntervalMs` (Standard 5 s). Sie sind die Schnittstelle, um einen Home-Assistant-Akku oder eine Loxone-Logik an die DVhub-/EOS-Entscheidungen zu hängen, ohne dass DVhub die Anlage selbst kennen muss.

| Topic | Einheit | Bedeutung |
|---|---|---|
| `dvhub/control/grid_setpoint_w` | W | Netz-Sollwert am Einspeisepunkt. Negativ = einspeisen/entladen, positiv = beziehen/laden, 0 = Nulleinspeisung |
| `dvhub/control/charge_current_a` | A | Maximaler Ladestrom (DC) |
| `dvhub/control/min_soc_pct` | % | Untere SoC-Grenze, unter die der Speicher nicht entladen werden soll |
| `dvhub/control/max_discharge_w` | W | Entladegrenze (AC). `0` = Entladung halten, `-1` = unbegrenzt |
| `dvhub/control/source` | Text | Herkunft des Sollwerts: `eos` (EOS-Plan), `optimizer` (interner Prognose-Optimizer), `market_automation` (Kleinmarkt-Automation), `rule` (manuelle Zeitplan-Regel), `override` (manueller Eingriff über die API), `default` (Grundzustand), `runtime` (Laufzeit-Schutz wie Abregelung/SoC-Boden), `none` |
| `dvhub/control/rule` | Text | Regel-ID, wenn eine Regel den Sollwert bestimmt (z. B. `opt-1789…-3`), sonst `null` |
| `dvhub/control/updated_at` | ISO-8601 | Zeitpunkt der letzten Sollwert-Änderung (Europe/Berlin-Anlage, UTC-Zeitstempel) |
| `dvhub/control/paused` | bool | `true`, wenn der Not-Halt die freiwilligen Schreibvorgänge pausiert |
| `dvhub/control/state` | JSON | Alle vier Ziele mit `{ value, source, at, origin }` in einem Objekt (`origin`: `active` = aktiver Sollwert, `readback` = Rücklesung der Anlage) |

Auflösung je Ziel: zuerst der zuletzt **gewollte** Wert aus dem Steuerpfad (auch wenn er gerade unverändert gehalten wird), sonst die Rücklesung der Anlage, sonst `null`.

Nicht im Schema: `feedExcessDcPv` und `dontFeedExcessAcPv`. Das sind Victron-Register (OvervoltageFeedIn, PreventFeedback) und ergeben für andere Hersteller keinen Sinn. Wer sie braucht, hat einen Victron-GX und damit Modbus.

### Home Assistant

Mit aktivierter Auto-Discovery (Integrationen → Home Assistant) erscheinen die Sollwerte automatisch als Sensoren `sensor.dvhub_control_grid_setpoint_w`, `…_charge_current_a`, `…_min_soc_pct`, `…_max_discharge_w`, `…_source`, `…_updated_at`. Beispiel-Automation, die einen fremden Akku (hier eine `number`-Entität des Wechselrichters) nachführt:

```yaml
automation:
  - alias: DVhub Netz-Sollwert an Akku weiterreichen
    trigger:
      - platform: state
        entity_id: sensor.dvhub_control_grid_setpoint_w
    condition:
      - condition: template
        value_template: "{{ states('sensor.dvhub_control_grid_setpoint_w') not in ['unknown', 'unavailable', 'null'] }}"
    action:
      - service: number.set_value
        target:
          entity_id: number.mein_wechselrichter_grid_setpoint
        data:
          value: "{{ states('sensor.dvhub_control_grid_setpoint_w') | int }}"
```

### Loxone

Der Text-Endpunkt `GET /api/integration/loxone` liefert dieselben Werte als flache Zeilen für einen **Virtual HTTP Input** (Kommando-Erkennung `dvhub_control_grid_setpoint_w=\v`):

```
dvhub_control_grid_setpoint_w=-2500
dvhub_control_charge_current_a=50
dvhub_control_min_soc_pct=20
dvhub_control_max_discharge_w=-1
dvhub_control_source=rule:abend-entladen
dvhub_control_rule=abend-entladen
dvhub_control_updated_at=2026-09-14T11:02:10.000Z
dvhub_control_paused=false
```

Die bisherigen Felder (`gridSetpointW`, `minSocPct`, `soc`, …) bleiben unverändert; `gridSetpointW` ist dort die Rücklesung der Anlage, `dvhub_control_grid_setpoint_w` der aktive Sollwert.

---

## 2. Eingänge von außen: Profil „Universal (DVhub-MQTT-Schema: HA/Loxone)"

Für Anlagen, deren Speicher, PV oder Zähler nur in Home Assistant oder Loxone erreichbar sind. Einstellungen → Verbindung → Hersteller: **Universal (DVhub-MQTT-Schema: HA/Loxone) — Beta**; Broker-URL und Topic-Prefix unter „MQTT-Bridge (Universal)". Das Profil ist die herstellerneutrale Alternative zur Venus-Bridge (`docs/DEYE-NODERED-BRIDGE.md`), gleicher Funktionsumfang.

### 2.1 Lesewerte, die der Lieferant publiziert (`dvhub/input/…`)

| Topic | Einheit | Pflicht | Bedeutung |
|---|---|---|---|
| `dvhub/input/grid/l1_w`, `l2_w`, `l3_w` | W | ja (mind. L1) | Leistung am Einspeisepunkt je Phase, Bezug positiv |
| `dvhub/input/battery/soc_pct` | % | ja | Ladezustand |
| `dvhub/input/battery/power_w` | W | ja | Batterieleistung, Laden positiv |
| `dvhub/input/pv/dc_w` | W | empfohlen | PV-Leistung DC (MPPT) |
| `dvhub/input/pv/ac_l1_w`, `ac_l2_w`, `ac_l3_w` | W | optional | AC-gekoppelte PV je Phase |
| `dvhub/input/consumption/l1_w`, `l2_w`, `l3_w` | W | empfohlen | Hausverbrauch je Phase (Lastprognose, EOS) |
| `dvhub/input/control/grid_setpoint_w`, `min_soc_pct`, `charge_current_a`, `max_discharge_w` | W / % / A / W | optional | Rücklesung der Sollwerte, wie die Anlage sie wirklich fährt (Schreib-Verifikation) |

Regeln:

- **Periodisch publizieren, nicht retained.** DVhub verwirft retained Replays bewusst (ein Replay beweist keine Frische). Ein Wert, der älter als `staleMaxAgeMs` ist (Profil: 90 s), gilt als unbekannt; dann hält DVhub die Entladung an, statt mit einem eingefrorenen SoC zu rechnen. Empfehlung: alle 5–10 s.
- Payload: nackte Zahl (`4200`, `-350.5`). JSON `{"value": 4200}` wird ebenfalls verstanden. `unavailable`, leer oder Text werden ignoriert.
- Phasen, die es nicht gibt, einfach nicht publizieren (1-phasige Anlage: nur `l1_w`).

Home-Assistant-Beispiel (`configuration.yaml`, publiziert alle 10 s ohne retain):

```yaml
automation:
  - alias: DVhub Eingänge publizieren
    trigger:
      - platform: time_pattern
        seconds: "/10"
    action:
      - service: mqtt.publish
        data: { topic: dvhub/input/battery/soc_pct, payload: "{{ states('sensor.akku_soc') }}", retain: false }
      - service: mqtt.publish
        data: { topic: dvhub/input/battery/power_w, payload: "{{ states('sensor.akku_leistung') }}", retain: false }
      - service: mqtt.publish
        data: { topic: dvhub/input/grid/l1_w, payload: "{{ states('sensor.netz_l1') }}", retain: false }
      - service: mqtt.publish
        data: { topic: dvhub/input/pv/dc_w, payload: "{{ states('sensor.pv_leistung') }}", retain: false }
```

### 2.2 Befehle, die DVhub an die Anlage sendet (`dvhub/control/<ziel>/set`)

| Topic | Einheit | Payload |
|---|---|---|
| `dvhub/control/grid_setpoint_w/set` | W | nackte Zahl |
| `dvhub/control/charge_current_a/set` | A | nackte Zahl |
| `dvhub/control/min_soc_pct/set` | % | nackte Zahl |
| `dvhub/control/max_discharge_w/set` | W | nackte Zahl (`0` halten, `-1` unbegrenzt) |

`…/set` ist der **Befehl** (nicht retained, QoS aus dem Profil), `dvhub/control/<ziel>` ohne `/set` der **retained Zustandsspiegel** aus Abschnitt 1 — dieselbe Trennung wie bei HA-Entitäten (command_topic / state_topic). Der Lieferant setzt den Befehl an seinem Gerät um und publiziert die Rücklesung nach `dvhub/input/control/<ziel>`; fehlt sie, kann DVhub den Schreibvorgang nicht verifizieren, steuert aber weiter.

Home-Assistant-Beispiel: Befehl entgegennehmen und an den Wechselrichter geben.

```yaml
automation:
  - alias: DVhub Befehl Netz-Sollwert ausführen
    trigger:
      - platform: mqtt
        topic: dvhub/control/grid_setpoint_w/set
    action:
      - service: number.set_value
        target: { entity_id: number.mein_wechselrichter_grid_setpoint }
        data: { value: "{{ trigger.payload | int }}" }
```

Loxone: ein **Virtual Output** mit MQTT-Gateway (z. B. Loxberry MQTT-Plugin) auf `dvhub/control/grid_setpoint_w/set` abonnieren; Lesewerte über dasselbe Gateway nach `dvhub/input/…` publizieren.

---

## 3. Status nach außen (Bestand)

Unverändert seit INTG-02: `dvhub/energy/grid_power_w`, `grid_l1_w`…`l3_w`, `import_wh`, `export_wh`, `cost_eur`, `revenue_eur`; `dvhub/battery/soc_pct`, `power_w`, `min_soc_pct`; `dvhub/solar/pv_total_w`, `pv_dc_w`; `dvhub/price/epex_current_ct_kwh`; `dvhub/system/uptime_sec`, `meter_ok`, `victron_updated_at`. Alle retained, alle `publishIntervalMs`.

Optimizer (seit 2026-09-14 aus dem echten Optimizer-Zustand, nicht mehr nur aus der Kleinmarkt-Automation):

| Topic | Werte |
|---|---|
| `dvhub/optimizer/source` | `eos`, `internal` (Prognose-Optimizer), `auto` (Konfiguration „best", noch kein Lauf), `market_automation` (nur Kleinmarkt-Automation aktiv), `gated` (Lizenz fehlt), `none` |
| `dvhub/optimizer/status` | `active`, `starting` (aktiviert, erster Lauf steht aus), `error`, `disabled` |
| `dvhub/optimizer/last_run_at` | ISO-8601 des letzten Optimizer-Laufs (Kleinmarkt-Automation: Datum) oder `null` |
| `dvhub/optimizer/rules_count` | Anzahl der vom Optimizer erzeugten Zeitplan-Regeln |
| `dvhub/optimizer/error` | Fehlertext des letzten Laufs oder `null` |

Kodierung: Zeichenketten werden **roh** gesendet (`eos`, nicht `"eos"`), Zahlen, Booleans und `null` als JSON, Objekte als JSON. Die HA-Discovery-Entitäten tragen ein `value_template`, das `null` in „unbekannt" übersetzt.

### Der Plan: `dvhub/optimizer/plan`

Der Plan ist die Liste der vom Optimizer (EOS, interner Optimizer, Kleinmarkt-Automation) erzeugten Zeitplan-Slots, also das, was DVhub ausführen wird: „von … bis … → Befehl". Abgelaufene Slots fallen heraus, der laufende bleibt drin. Retained, alle `publishIntervalMs`.

| Topic | Inhalt |
|---|---|
| `dvhub/optimizer/plan` | JSON `{ source, generatedAt, slotMinutes, validFrom, validUntil, slotCount, rangeCount, slots: [...], devices: [] }` |
| `dvhub/optimizer/plan/ranges` | JSON mit `ranges: [...]`: aufeinanderfolgende Slots mit gleichem Befehl zu Bereichen „von … bis …" zusammengefasst (`{ start, end, action, value, slots }`, dazu `chargeReserveW` und `source`, wenn sie vom Plan abweicht). Kompakt, ohne Regel-IDs; das ist das Attribut-Topic für Home Assistant (16-KB-Grenze für Attribute) |
| `dvhub/optimizer/plan/current` | der gerade laufende Slot oder `null` |
| `dvhub/optimizer/plan/next` | der nächste Slot mit `startsInMin`, oder `null` |
| `dvhub/optimizer/plan/next_start` | ISO-8601 des nächsten Slot-Beginns oder `null` |
| `dvhub/optimizer/plan/slot_count` | Anzahl Slots |

Ein Slot:

```json
{ "start": "2026-09-14T16:00:00.000Z", "end": "2026-09-14T16:15:00.000Z",
  "target": "gridSetpointW", "value": -4000, "action": "export",
  "source": "eos", "rule": "opt-1789…-3" }
```

`action`: `export` (Netz-Sollwert < 0, einspeisen/entladen), `import` (> 0, beziehen/laden), `hold` (0), `export_surplus` (PV-Überschuss über die Ladereserve einspeisen; dann zusätzlich `chargeReserveW`, ggf. `targetSocPct`). `devices` ist reserviert für Geräte-Slots (`{ device, start, end, action: "on" | "off" }`), sobald EOS flexible Verbraucher (Geschirrspüler, Heizstab, Wallbox) plant.

Home Assistant: `sensor.dvhub_optimizer_plan` (Zustand = Anzahl Slots, Attribute = die Bereiche aus `plan/ranges`) und `sensor.dvhub_optimizer_plan_next` (Zeitstempel des nächsten Slots, Attribute = der Slot). Beispiel für eine Template-Karte:

```yaml
type: markdown
content: >-
  {% for r in state_attr('sensor.dvhub_optimizer_plan', 'ranges') %}
  {{ as_timestamp(r.start) | timestamp_custom('%H:%M') }}–{{ as_timestamp(r.end) | timestamp_custom('%H:%M') }}
  **{{ r.action }}** {{ r.value }} W
  {% endfor %}
```

Wer die Einzel-Slots braucht (eigene Automation, Node-RED), liest `dvhub/optimizer/plan` direkt vom Broker.

---

## 4. Sicherheit und Grenzen

- Der Steuerpfad bleibt DVhubs Verantwortung: Not-Halt, SoC-Boden, Negativpreis-Schutz und Frische-Disziplin greifen vor jedem `…/set`. Was nach außen geht, ist bereits geprüft.
- Wer `dvhub/control/<ziel>` (ohne `/set`) selbst publiziert, überschreibt nur den Spiegel — DVhub liest ihn nicht zurück. Befehle an DVhub gibt es über MQTT nicht; dafür ist die API da.
- Im Lese-Modus (`DVHUB_READ_ONLY=1`) sendet DVhub keine `…/set`-Befehle; die `dvhub/control/<ziel>`-Spiegel werden weiter publiziert.
- Broker-Zugang: der Hub verbindet mit den Zugangsdaten aus Integrationen → MQTT Hub; für das Eingangs-Profil gelten die Bridge-Einstellungen unter Einstellungen → Verbindung (eigene Verbindung, eigener Broker möglich).
