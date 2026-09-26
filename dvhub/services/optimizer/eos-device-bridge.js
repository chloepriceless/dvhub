// services/optimizer/eos-device-bridge.js -- fährt planbare Verbraucher (2026-09-26).
//
// Muster wie eos-evcc-bridge.js: eigener 30-s-Poller, Dedup über commandKey,
// sicheres Fail (kein Befehl ⇒ AUS für deferrable; 0 W für modulierend).
//
//   deferrable (Geschirrspüler): EOS plant es als home_appliance; die Bridge liest
//     den Dispatch aus der Lösung (parseApplianceRowsDispatch), prüft ob JETZT ein
//     Lauffenster ist, und schaltet den Endpunkt an/aus.
//   modulating (Elwa/AC Thor): DVhub-seitiger PV-Überschuss-Regler
//     (computeHeaterPowerW) → Leistungs-Sollwert am Endpunkt.
//
// Gate: nur wenn nicht Lese-Modus. Jedes Gerät hat zusätzlich seinen enabled-Flag.

import { safeInterval } from '../safe-async.js';
import { loadSchedulableDevices } from '../devices/schedulable.js';
import { parseApplianceRowsDispatch, applianceDispatchToPlanSlots } from './eos-devices.js';
import { computeHeaterPowerW } from '../devices/modulating-heater.js';
import { isReadOnlyMode } from '../../read-only-guard.js';

/** Ist `nowMs` in einem Dispatch-Fenster dieses Geräts? */
export function deferrableOnNow(dispatch, eosId, nowMs) {
  const windows = dispatch?.[eosId];
  if (!Array.isArray(windows)) return false;
  return windows.some((w) => Number(w.startMs) <= nowMs && nowMs < Number(w.endMs));
}

/** Aktueller PV-Überschuss (W). Export (grid < 0) plus die schon laufende Heizlast. */
export function surplusW(state, alreadyDrawingW = 0) {
  const grid = Number(state?.meter?.grid_total_w);
  const exportW = Number.isFinite(grid) ? Math.max(0, -grid) : 0;
  return exportW + Math.max(0, Number(alreadyDrawingW) || 0);
}

/**
 * @param {object} deps
 * @param {()=>object} deps.getCfg
 * @param {(limit:number)=>Promise<object|null>} deps.getSolution  inspector.getEos → {rows, generatedAt}
 * @param {object} deps.actuator  createDeviceActuator(...)
 * @param {object} deps.state
 * @param {(event:string,data?:object)=>void} [deps.pushLog]
 * @param {()=>number} [deps.now]
 */
export function createEosDeviceBridge(deps) {
  const { getCfg, getSolution, actuator, state, pushLog = () => {}, now = () => Date.now() } = deps;

  let timer = null;
  let ticking = false;
  let lastTickAt = 0;
  let lastError = null;
  const lastCmd = new Map();      // deviceId → commandKey
  const lastPower = new Map();    // deviceId → letzte Heizleistung (für Überschuss-Ramp)
  let lastStatus = [];

  async function actuate(device, command) {
    const key = actuator.commandKey(device, command);
    if (lastCmd.get(device.id) === key) return { unchanged: true, command };
    const r = await actuator.apply(device, command);
    if (r?.ok) {
      lastCmd.set(device.id, key);
      if (device.kind === 'modulating') lastPower.set(device.id, Number(command.powerW) || 0);
      pushLog('device_command', { id: device.id, kind: device.kind, endpoint: device.endpoint?.type, ...command });
    } else {
      pushLog('device_command_error', { id: device.id, error: r?.error || 'unknown', ...command });
    }
    return r;
  }

  async function tick({ force = false } = {}) {
    if (ticking) return { ok: false, error: 'busy' };
    ticking = true;
    lastTickAt = now();
    if (force) lastCmd.clear();
    try {
      const cfg = getCfg() || {};
      if (isReadOnlyMode()) return { ok: false, skipped: 'read_only' };
      const { devices } = loadSchedulableDevices(cfg);
      const enabled = devices.filter((d) => d.enabled !== false);
      if (!enabled.length) return { ok: true, skipped: 'no_devices' };

      const deferrable = enabled.filter((d) => d.kind === 'deferrable');
      const modulating = enabled.filter((d) => d.kind === 'modulating');
      const status = [];
      const devicePlan = [];

      // --- deferrable: aus dem EOS-Dispatch ---
      if (deferrable.length) {
        let dispatch = {};
        const idMap = state?.optimizer?.eosApplianceIdMap || {};
        try {
          const sol = await getSolution(8 * 24 * 4);
          dispatch = parseApplianceRowsDispatch(sol?.rows || [], idMap);
        } catch (e) { lastError = e?.message || String(e); }
        const byDevId = {};
        for (const [eosId, devId] of Object.entries(idMap)) byDevId[devId] = eosId;
        // Zukünftige Fenster in den Geräte-Plan (für MQTT/Anzeige).
        for (const s of applianceDispatchToPlanSlots(dispatch, idMap)) devicePlan.push({ ...s, kind: 'deferrable' });
        for (const d of deferrable) {
          const eosId = byDevId[d.id];
          const on = eosId ? deferrableOnNow(dispatch, eosId, now()) : false;
          const r = await actuate(d, { on });
          status.push({ id: d.id, kind: 'deferrable', on, ok: r?.ok !== false });
        }
      }

      // --- modulating: PV-Überschuss-Regler ---
      for (const d of modulating) {
        const p = d.plan || {};
        const avail = surplusW(state, lastPower.get(d.id) || 0);
        const { powerW, reason } = computeHeaterPowerW({
          maxPowerW: p.maxPowerW, minPowerW: p.minPowerW,
          surplusW: avail,
          socPct: null,               // v1: kein thermischer Sensor → reine Überschuss-Folge
          targetPct: p.targetPct ?? null,
          capacityWh: p.capacityWh ?? null,
          deadlineMs: null,           // Deadline-Boost aktiv, sobald socPct verfügbar (Folgearbeit)
          nowMs: now(),
        });
        const r = await actuate(d, { powerW });
        status.push({ id: d.id, kind: 'modulating', powerW, reason, ok: r?.ok !== false });
        devicePlan.push({ device: d.id, kind: 'modulating', powerW, reason, at: new Date(now()).toISOString() });
      }

      lastStatus = status;
      // Geräte-Plan für optimizer-plan.js (plan.devices) / MQTT ablegen.
      if (state) { state.optimizer = state.optimizer || {}; state.optimizer.devicePlan = devicePlan; }
      return { ok: true, status };
    } catch (err) {
      lastError = err?.message || String(err);
      pushLog('device_bridge_error', { error: lastError });
      return { ok: false, error: lastError };
    } finally {
      ticking = false;
    }
  }

  return {
    start(intervalMs = 30_000) {
      if (timer) return;
      timer = safeInterval('eos-device-bridge.tick', () => tick(), intervalMs);
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
    tick,
    apply: () => tick({ force: true }),
    getStatus() {
      return {
        lastTickAt: lastTickAt ? new Date(lastTickAt).toISOString() : null,
        lastError,
        devices: lastStatus,
      };
    },
  };
}
