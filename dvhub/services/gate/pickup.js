// services/gate/pickup.js — Abholpuffer und Steuer-Spiegel als Senke hinter dem Schreibtor (VCL-Vertrag v6 D.1 R-T3,
// D.2, D.4(2)).
//
// DVhub gibt seine Sollwerte nicht nur per Modbus/MQTT-Brücke an die Anlage, es stellt sie auch zum ABHOLEN bereit:
//   • GET /api/integration/loxone und /api/integration/home-assistant (routes-api.js integrationState): die Zeilen
//     dvhub_control_* und dvhub_control_grid_limit_* sowie der Rohzustand scheduleActive. Beim DVhub-Schema ohne
//     Broker ist das der einzige Weg zur Anlage — transport-mqtt.js mqttWrite kehrt mit ok:true zurück, ohne zu
//     senden (D.2: `unknown` mit `pickupPending`).
//   • der MQTT-Spiegel <prefix>/control/* und <prefix>/control/grid_limit/* (services/mqtt/publisher.js, retained),
//     an dem ein Home-Assistant-Akku, eine Wärmepumpe oder eine Loxone-Logik hängt.
// Wer abholt, setzt den Wert um — der Abholpfad ist ein Schreibpfad (R-T3). Deshalb fragt diese Senke bei JEDER
// Herausgabe das Tor (gate.pickupVerdict: Not-Halt, Lese-Modus, Schreibfreigabe), je Gerät:
//   `inverter`   die vier Akku-Sollwerte und scheduleActive — dieselben Punkte, die applyControlTargetCore über das
//                Tor schreibt. Zu bei Not-Halt, Lese-Modus und ungültiger Konfiguration (writeSafety.ok === false →
//                Schreibfreigabe profileInvalid, dieselbe Abbildung wie schedule-eval.js submitInverter).
//   `gridLimit`  die §14a-/EEBUS-Grenzen zum Nachfolgen. Zu bei Not-Halt (§14a ist dann ausgesetzt,
//                services/emergency-stop/policy.js) und Lese-Modus; NICHT bei ungültigem Herstellerprofil — das betrifft
//                nur den Wechselrichter, die EEBUS-Grenzen an Wallbox/Wärmepumpe laufen dann auch weiter.
// Ist das Tor zu, steht dort „keine Vorgabe“ in der Form, die die Abnehmer schon kennen: derselbe Inhalt wie ohne
// jeden Sollwert (frisch gestartet, nichts zurückgelesen) — Sollwerte null, Herkunft none, Regel und Zeitpunkt null;
// Grenzen aktiv false, Quelle none, Werte null; scheduleActive je Ziel null. Dazu der Grund (`suspended`, flach
// `dvhub_control_suspended`: not_halt | read_only | config_unsafe | not_released | gate_error) — NUR solange das Tor
// zu ist. Offen ist die Herausgabe bit-gleich zu vorher (Nachweis test/gate-pickup-parity.test.js gegen 24eabf21).
// Messwerte und Status — paused, forcedOff, die Rücklesungen gridSetpointW/minSocPct, dvControlValue — laufen in
// integrationState und im Publisher unverändert weiter („Werte laufen weiter“).
//
// Die Bausteine aus services/control-snapshot.js (buildControlSnapshot, controlSnapshotFlat, buildGridLimitSnapshot,
// gridLimitSnapshotFlat) und das Publizieren der Steuer-Topics stehen außerhalb des Tor-Verzeichnisses nirgends mehr
// (R-T1, test/gate-rt1-structure.test.js).

import {
  CONTROL_KEYS, CONTROL_TOPIC_SUFFIX, GRID_LIMIT_TOPIC,
  buildControlSnapshot, buildGridLimitSnapshot, controlSnapshotFlat, gridLimitSnapshotFlat,
} from '../control-snapshot.js';
import { DETAIL } from './constants.js';
import { createLegacyGate, INVERTER_GATE_DEVICE, inverterReleaseState } from './legacy.js';

/** Geräte des Abholpuffers im Tor: Akku-Sollwerte am Wechselrichter, Netzbetreiber-Grenzen zum Nachfolgen. */
export const PICKUP_GATE_DEVICES = Object.freeze({ control: INVERTER_GATE_DEVICE, gridLimit: 'gridLimit' });

/** Gründe für „keine Vorgabe“ (Feld `suspended` bzw. `dvhub_control_suspended`). */
export const PICKUP_SUSPENDED = Object.freeze(['not_halt', 'read_only', 'config_unsafe', 'not_released', 'gate_error']);

/** Urteil des Tors → Grund oder null (offen). */
export function suspensionOf(verdict) {
  if (verdict?.open === true) return null;
  if (verdict?.blockedBy === 'halt') return 'not_halt';
  if (verdict?.blockedBy === 'readOnly') return 'read_only';
  if (verdict?.blockedBy === 'release') return verdict.detail === DETAIL.profileInvalid ? 'config_unsafe' : 'not_released';
  return 'gate_error';
}

/** scheduleActive „keine Vorgabe“: jedes Ziel null — wie der Startzustand (server.js: { gridSetpointW: null, … }). */
function nullEach(active) {
  if (!active || typeof active !== 'object') return active;
  return Object.fromEntries(Object.keys(active).map((k) => [k, null]));
}

/**
 * Abholsenke anlegen. `getGate` liefert das Tor des Prozesses (server.js ctx.gate); ohne Tor (Tests, die Route oder
 * Publisher allein bauen) ein eigenes Legacy-Tor mit derselben Not-Halt-Marke wie die Bestandsprüfungen.
 * @param {{ state: object, getCfg: () => object, getGate?: () => object|null|undefined }} p
 */
export function createPickupSink({ state, getCfg, getGate = () => null }) {
  let ownGate = null;
  const gate = () => getGate?.() || (ownGate ??= createLegacyGate({ isHalted: () => state?.ctrl?.discretionaryWritesPaused === true }));

  /** Ein Urteil je Gerät für EINE Herausgabe (Freigabe wie die Schreibpfade aus derselben Config). */
  function suspensions() {
    try {
      const g = gate();
      g.setRelease(PICKUP_GATE_DEVICES.control, inverterReleaseState(getCfg?.()));
      g.setRelease(PICKUP_GATE_DEVICES.gridLimit, 'open');
      return {
        control: suspensionOf(g.pickupVerdict(PICKUP_GATE_DEVICES.control)),
        gridLimit: suspensionOf(g.pickupVerdict(PICKUP_GATE_DEVICES.gridLimit)),
      };
    } catch {
      return { control: 'gate_error', gridLimit: 'gate_error' }; // Tor nicht befragbar → nichts herausgeben
    }
  }

  /**
   * Eine Herausgabe: Steuer- und Grenzen-Sicht mit je einem Urteil. Offen genau buildControlSnapshot(state, nowMs)
   * bzw. buildGridLimitSnapshot(state); zu die „keine Vorgabe“-Form samt `suspended` (nur dann vorhanden).
   * @param {number} [nowMs]
   */
  function handOut(nowMs = Date.now()) {
    const s = suspensions();
    const control = s.control
      ? { ...buildControlSnapshot({ ctrl: state?.ctrl }, nowMs), suspended: s.control }
      : buildControlSnapshot(state, nowMs);
    const gridLimit = s.gridLimit ? buildGridLimitSnapshot({}) : buildGridLimitSnapshot(state);
    return { suspended: s.control, gridLimitSuspended: s.gridLimit, control, gridLimit };
  }

  /** scheduleActive für integrationState (offen: dieselbe Referenz wie bisher). */
  function scheduleActive(h) {
    return h.suspended ? nullEach(state.schedule.active) : state.schedule.active;
  }

  /** Flache Felder für Loxone/HA in der bisherigen Reihenfolge; `dvhub_control_suspended` nur bei geschlossenem Tor. */
  function flat(h) {
    return {
      ...controlSnapshotFlat(h.control),
      ...(h.suspended ? { dvhub_control_suspended: h.suspended } : {}),
      ...gridLimitSnapshotFlat(h.gridLimit),
    };
  }

  /**
   * Steuer-Topics des MQTT-Spiegels publizieren — dieselben Topics, Nutzlasten (Text roh, sonst JSON), retained, in
   * derselben Reihenfolge wie bisher in publisher.js; jedes Topic kommt in `topics` (Zähler des Publishers).
   * Kein eigenes Topic für den Grund: ein nur zeitweise gesetztes retained Topic bliebe nach dem Aufheben stehen,
   * und ein ständiges wäre im Normalbetrieb neu (docs/MQTT-SCHEMA.md).
   */
  function publishMirror(hub, prefix, topics, nowMs = Date.now()) {
    const h = handOut(nowMs);
    const pub = (suffix, value) => {
      const topic = `${prefix}/${suffix}`;
      hub.publish(topic, typeof value === 'string' ? value : JSON.stringify(value), { retain: true });
      topics.push(topic);
    };
    const { control, gridLimit } = h;
    for (const key of CONTROL_KEYS) pub(CONTROL_TOPIC_SUFFIX[key], control.values[key].value);
    pub('control/source', control.source);
    pub('control/rule', control.rule);
    pub('control/updated_at', control.updatedAt);
    pub('control/paused', control.paused);
    pub('control/state', control.values);
    pub(GRID_LIMIT_TOPIC.active, gridLimit.active);
    pub(GRID_LIMIT_TOPIC.source, gridLimit.source);
    pub(GRID_LIMIT_TOPIC.consumptionW, gridLimit.consumptionW);
    pub(GRID_LIMIT_TOPIC.productionW, gridLimit.productionW);
    pub(GRID_LIMIT_TOPIC.productionBlocked, gridLimit.productionBlocked);
    pub(GRID_LIMIT_TOPIC.state, gridLimit);
    return h;
  }

  return { handOut, scheduleActive, flat, publishMirror };
}
