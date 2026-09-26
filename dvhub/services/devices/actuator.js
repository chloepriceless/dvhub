// services/devices/actuator.js -- Endpunkt-Aktor für planbare Geräte (2026-09-26).
//
// Setzt den vom Planer gewollten Zustand eines planbaren Geräts auf seinem
// konfigurierten Endpunkt um. Drei Endpunkt-Typen (services/devices/schedulable.js):
//   - shelly:       direkt über deviceService.setDeviceOutput (nur An/Aus)
//   - mqtt_publish: DVhub publiziert an ein fremdes Command-/Leistungs-Topic
//   - mqtt_expose:  DVhub publiziert den GEWOLLTEN Zustand unter
//                   <prefix>/device/<id>/desired (retained); HA/Node-RED schaltet
//                   das reale Gerät (per Automation) und liefert optional die
//                   Rücklesung. Zusätzlich erscheint das Gerät via HA-Discovery.
//
// command: { on: boolean } (deferrable) ODER { powerW: number } (modulating; 0 = aus).
// Der Aktor ist zustandslos; Dedup/Drift-Korrektur macht die aufrufende Bridge.

function getPrefix(getCfg) {
  return getCfg().mqtt?.topicPrefix || 'dvhub';
}

/**
 * @param {{ hub: object, deviceService: object, getCfg: Function, pushLog: Function }} deps
 */
export function createDeviceActuator(deps) {
  const { hub, deviceService, getCfg, pushLog } = deps;

  function publish(topic, payload, opts = {}) {
    if (!hub?.publish) return { ok: false, error: 'mqtt_hub_unavailable' };
    hub.publish(topic, String(payload), { retain: opts.retain ?? false });
    return { ok: true };
  }

  /**
   * Gewollten Zustand am Endpunkt umsetzen.
   * @param {object} device  normalisiertes planbares Gerät (schedulable.js)
   * @param {{on?:boolean, powerW?:number}} command
   * @returns {Promise<{ok:boolean, [k:string]:any}>}
   */
  async function apply(device, command) {
    const ep = device?.endpoint;
    if (!ep) return { ok: false, error: 'no_endpoint' };
    const isMod = device.kind === 'modulating';
    // Auf An/Aus normieren; bei modulierend gilt powerW>0 als "an".
    const powerW = isMod ? Math.max(0, Math.round(Number(command?.powerW) || 0)) : null;
    const on = isMod ? powerW > 0 : command?.on === true;
    const prefix = getPrefix(getCfg);

    try {
      if (ep.type === 'shelly') {
        // Nur An/Aus. setDeviceOutput adressiert das referenzierte Shelly-Gerät.
        if (!deviceService?.setDeviceOutput) return { ok: false, error: 'device_service_unavailable' };
        const r = await deviceService.setDeviceOutput(ep.shellyDeviceId, on);
        return r?.ok ? { ok: true, endpoint: 'shelly', on } : (r || { ok: false, error: 'shelly_failed' });
      }

      if (ep.type === 'mqtt_publish') {
        if (isMod) {
          const payload = String(ep.powerTemplate || '{value}').replace('{value}', String(powerW));
          const r = publish(ep.powerTopic, payload, { retain: false });
          return r.ok ? { ok: true, endpoint: 'mqtt_publish', powerW } : r;
        }
        const payload = on ? ep.onPayload : ep.offPayload;
        const r = publish(ep.commandTopic, payload, { retain: false });
        return r.ok ? { ok: true, endpoint: 'mqtt_publish', on } : r;
      }

      if (ep.type === 'mqtt_expose') {
        // DVhub publiziert den gewollten Zustand; HA führt aus. Retained, damit ein
        // neu verbundener HA-Client den aktuellen Wunsch sofort kennt.
        const base = `${prefix}/device/${device.id}`;
        if (isMod) {
          publish(`${base}/desired_power_w`, powerW, { retain: true });
          publish(`${base}/desired`, on ? 'ON' : 'OFF', { retain: true });
          return { ok: true, endpoint: 'mqtt_expose', powerW, on };
        }
        publish(`${base}/desired`, on ? 'ON' : 'OFF', { retain: true });
        return { ok: true, endpoint: 'mqtt_expose', on };
      }

      return { ok: false, error: 'unknown_endpoint_type' };
    } catch (err) {
      pushLog?.('device_actuate_error', { id: device.id, endpoint: ep.type, error: err?.message ?? String(err) });
      return { ok: false, error: err?.message ?? String(err) };
    }
  }

  /**
   * Eindeutiger Kommando-Schlüssel für die Dedup in der Bridge (nur schreiben,
   * wenn sich der gewollte Zustand ändert).
   */
  function commandKey(device, command) {
    if (device.kind === 'modulating') return `p:${Math.max(0, Math.round(Number(command?.powerW) || 0))}`;
    return `o:${command?.on === true ? 1 : 0}`;
  }

  return { apply, commandKey };
}
