// services/mqtt/command-subscriber.js -- eingehende Steuerbefehle über MQTT
// (2026-09-26, bidirektionale Steuerung).
//
// Anlass (Christin): "MQTT-Steuerung auf Bidirektionalität ausbauen, sodass in
// Home Assistant alle Regler bedienbar werden — auch das Auto." Bis dahin war
// MQTT bewusst read-only Richtung DVhub (docs/MQTT-SCHEMA.md §4: "Befehle an
// DVhub gibt es über MQTT nicht"). Dieser Subscriber kehrt das um.
//
// Namensraum: <prefix>/cmd/… — bewusst getrennt von
//   <prefix>/control/<ziel>       (retained Zustandsspiegel, Ausgang)
//   <prefix>/control/<ziel>/set   (Befehl an eine FREMDE Anlage, Ausgang)
// sodass keine Richtung mit einer anderen kollidiert.
//
// Sicherheit:
//   - Befehle werden NUR ausgeführt, wenn HA-Discovery aktiv ist
//     (mqtt.haDiscovery.enabled) UND DVhub nicht im Lese-Modus läuft
//     (DVHUB_READ_ONLY). Beides pro Nachricht geprüft — kein unsubscribe nötig,
//     das Abschalten von HA-Discovery deaktiviert die Steuerung sofort.
//   - Jeder Befehl läuft durch dieselben ctx-Primitiven wie die HTTP-API
//     (services/control-commands.js) → applyControlTarget-Chokepoint mit Bounds,
//     Not-Halt-Gate und Min-SoC-Clamp. Der Broker-Zugang ist die Vertrauensgrenze.

import { isReadOnlyMode } from '../../read-only-guard.js';

// Numerische Sollwert-Ziele: cmd-Suffix -> internes applyControlTarget-Ziel.
const NUMERIC_TARGETS = Object.freeze({
  grid_setpoint_w: 'gridSetpointW',
  charge_current_a: 'chargeCurrentA',
  min_soc_pct: 'minSocPct',
  max_discharge_w: 'maxDischargeW',
});

const EVCC_MODES = Object.freeze(['off', 'pv', 'minpv', 'now']);

const MQTT_ACTOR = Object.freeze({ actor_ip: 'mqtt', actor_ua: 'mqtt_command', actor_session: null });

/**
 * Payload -> boolean. HA-Switch sendet ON/OFF; zusätzlich true/false, 1/0.
 * @returns {boolean|null} null = nicht interpretierbar
 */
function parseBool(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (['on', 'true', '1', 'yes'].includes(s)) return true;
  if (['off', 'false', '0', 'no'].includes(s)) return false;
  return null;
}

/**
 * Payload -> endliche Zahl. Nackte Zahl bevorzugt, JSON {"value":x} als Fallback.
 * @returns {number|null} null = nicht interpretierbar
 */
function parseNum(raw) {
  const s = String(raw ?? '').trim();
  if (s === '') return null;
  const n = Number(s);
  if (Number.isFinite(n)) return n;
  try {
    const obj = JSON.parse(s);
    const v = Number(obj?.value);
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * @param {object} hub - MQTT Hub (services/mqtt/index.js)
 * @param {object} ctx - DI context
 */
export function createMqttCommandSubscriber(hub, ctx) {
  const { getCfg, pushLog } = ctx;
  let subscribedPattern = null;

  function getPrefix() {
    return getCfg().mqtt?.topicPrefix || 'dvhub';
  }

  /** Steuerung erlaubt? HA-Discovery an UND nicht im Lese-Modus. */
  function commandsEnabled() {
    return getCfg().mqtt?.haDiscovery?.enabled === true && !isReadOnlyMode();
  }

  async function route(cmd, payload) {
    // Numerische Akku-Sollwerte
    if (cmd in NUMERIC_TARGETS) {
      const target = NUMERIC_TARGETS[cmd];
      const value = parseNum(payload);
      if (value === null) return { ok: false, error: 'value_not_finite' };
      return ctx.applyManualControlWrite({ target, value, actor: MQTT_ACTOR, reason: 'mqtt_command' });
    }

    // Not-Halt
    if (cmd === 'emergency_stop') {
      const on = parseBool(payload);
      if (on === null) return { ok: false, error: 'expected ON/OFF' };
      return ctx.setEmergencyStop({ on, actor: MQTT_ACTOR });
    }

    // E-Auto: EOS-Mitplanung
    if (cmd === 'ev/optimize') {
      const on = parseBool(payload);
      if (on === null) return { ok: false, error: 'expected ON/OFF' };
      return ctx.applyEvConfigPatch({ body: { optimizeEv: on }, actor: MQTT_ACTOR });
    }
    if (cmd === 'ev/only_when_plugged') {
      const on = parseBool(payload);
      if (on === null) return { ok: false, error: 'expected ON/OFF' };
      return ctx.applyEvConfigPatch({ body: { onlyWhenPlugged: on }, actor: MQTT_ACTOR });
    }
    // E-Auto: Ziel-SoC in Prozent -> departure.targetMode=percent
    if (cmd === 'ev/target_soc_pct') {
      const pct = parseNum(payload);
      if (pct === null) return { ok: false, error: 'value_not_finite' };
      return ctx.applyEvConfigPatch({
        body: { departure: { targetMode: 'percent', targetValue: pct } },
        actor: MQTT_ACTOR,
      });
    }
    // Wallbox-Modus (evcc)
    if (cmd === 'ev/mode') {
      const mode = String(payload ?? '').trim().toLowerCase();
      if (!EVCC_MODES.includes(mode)) return { ok: false, error: `mode must be one of ${EVCC_MODES.join('|')}` };
      if (!ctx.evccIntegration || typeof ctx.evccIntegration.setMode !== 'function') {
        return { ok: false, error: 'evcc not available' };
      }
      const lpId = Number(getCfg().optimizer?.evEvccLoadpoint) || Number(getCfg().evcc?.dashboardLoadpoint) || 1;
      const r = await ctx.evccIntegration.setMode(lpId, mode);
      if (r?.ok) pushLog('mqtt_ev_mode', { loadpoint: lpId, mode }, MQTT_ACTOR);
      return r || { ok: false, error: 'mode set failed' };
    }

    // Schaltbare Geräte (Shelly): cmd/device/<id>
    if (cmd.startsWith('device/')) {
      const id = cmd.slice('device/'.length);
      const on = parseBool(payload);
      if (!id) return { ok: false, error: 'device_id_required' };
      if (on === null) return { ok: false, error: 'expected ON/OFF' };
      if (!ctx.deviceService || typeof ctx.deviceService.setDeviceOutput !== 'function') {
        return { ok: false, error: 'device_service_unavailable' };
      }
      const r = await ctx.deviceService.setDeviceOutput(id, on);
      if (r?.ok) pushLog('mqtt_device_output', { id, on }, MQTT_ACTOR);
      return r || { ok: false, error: 'toggle_failed' };
    }

    return { ok: false, error: 'unknown_command' };
  }

  async function handleMessage(topic, payload, packet) {
    const prefix = getPrefix();
    const marker = `${prefix}/cmd/`;
    const idx = topic.indexOf(marker);
    if (idx !== 0) return; // nicht unser Namensraum (bei breiter Subscription)
    const cmd = topic.slice(marker.length);
    if (!cmd) return;

    // Retained-Replay abweisen: Ein Befehl ist eine EINMALIGE Anweisung, nie
    // retained. Ein retained cmd/* (Fehlkonfiguration oder Absicht) würde der
    // Broker bei jedem (Re)connect/Neustart erneut zustellen — ein retained
    // cmd/emergency_stop=OFF könnte so einen später aktivierten Not-Halt ohne
    // Operator-Aktion aufheben. Frische Befehle sind nicht retained.
    if (packet?.retain === true) {
      pushLog('mqtt_command_ignored', { cmd, reason: 'retained_replay' }, 'warn');
      return;
    }

    // Gate: nur bei aktiver HA-Discovery und außerhalb des Lese-Modus.
    if (!commandsEnabled()) {
      pushLog('mqtt_command_ignored', {
        cmd,
        reason: isReadOnlyMode() ? 'read_only_mode' : 'ha_discovery_disabled',
      }, 'warn');
      return;
    }

    const raw = payload == null ? '' : payload.toString();
    try {
      const result = await route(cmd, raw);
      if (!result?.ok) {
        pushLog('mqtt_command_rejected', { cmd, payload: raw.slice(0, 64), error: result?.error || 'unknown' }, 'warn');
      }
    } catch (err) {
      pushLog('mqtt_command_error', { cmd, error: err?.message ?? String(err) }, 'error');
    }
  }

  function start() {
    const pattern = `${getPrefix()}/cmd/#`;
    subscribedPattern = pattern;
    hub.subscribe(pattern, handleMessage);
    pushLog('mqtt_command_subscriber_started', { pattern });
  }

  /**
   * Nach einem Laufzeit-Wechsel des topicPrefix (Integrationen → MQTT Hub) neu
   * abonnieren, damit Befehle auf dem NEUEN Präfix ankommen. Der Hub bietet kein
   * unsubscribe; das alte Abo bleibt registriert, ist aber harmlos: handleMessage
   * prüft gegen das aktuelle Präfix und verwirft Alt-Präfix-Topics. No-op, wenn
   * sich das Muster nicht geändert hat.
   */
  function resubscribe() {
    const pattern = `${getPrefix()}/cmd/#`;
    if (pattern === subscribedPattern) return;
    subscribedPattern = pattern;
    hub.subscribe(pattern, handleMessage);
    pushLog('mqtt_command_subscriber_resubscribed', { pattern });
  }

  function close() {
    // Der Hub bietet kein unsubscribe; der Handler no-opt bei geschlossenem Hub.
    subscribedPattern = null;
  }

  function getSubscriptionTopic() {
    return subscribedPattern || `${getPrefix()}/cmd/#`;
  }

  return {
    start,
    close,
    resubscribe,
    getSubscriptionTopic,
    // Test-Helfer
    _handleMessage: handleMessage,
    _commandsEnabled: commandsEnabled,
  };
}
