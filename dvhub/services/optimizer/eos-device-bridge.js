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
// Gate: nur wenn nicht Lese-Modus und kein Not-Halt. Jedes Gerät hat zusätzlich seinen enabled-Flag.
//
// Heizstab mit plan.pauseWhileEvCharging: solange die Wallbox lädt, 0 W — der
// PV-Überschuss gehört dann dem Auto. Wallbox-Zustand unbekannt → normal regeln
// (eine ausgefallene Wallbox-Abfrage soll das Warmwasser nicht dauerhaft sperren).

import { safeInterval } from '../safe-async.js';
import { loadSchedulableDevices } from '../devices/schedulable.js';
import { parseApplianceRowsDispatch, applianceDispatchToPlanSlots } from './eos-devices.js';
import { computeHeaterPowerW } from '../devices/modulating-heater.js';
import { isReadOnlyMode } from '../../read-only-guard.js';
import { localDate } from '../../tz-fast.js';

/** Ist `nowMs` in einem Dispatch-Fenster dieses Geräts? */
export function deferrableOnNow(dispatch, eosId, nowMs) {
  const windows = dispatch?.[eosId];
  if (!Array.isArray(windows)) return false;
  return windows.some((w) => Number(w.startMs) <= nowMs && nowMs < Number(w.endMs));
}

/**
 * Aktueller PV-Überschuss (W) für einen Heizstab, auf ≥0 geklemmt. Der SIGNIERTE
 * Netzbezug senkt den Wert, damit der Heizstab bei fallender PV drosselt statt
 * Netzstrom zu verheizen. Nichts bekannt → 0 (fail-safe: kein Überschuss annehmen).
 */
export function surplusW(state, alreadyDrawingW = 0, cfg = null) {
  const own = Math.max(0, Number(alreadyDrawingW) || 0);
  // Nur echter PV-Überschuss (2026-10-04): PV-Leistung, die gerade ins Netz
  // geht, plus die eigene Heizleistung (ohne sie ginge auch die ins Netz) —
  // abzüglich Netzbezug und Akku-Entladung. Damit zählt weder eine geplante
  // Akku-Einspeisung (abends zu hohen Preisen) als „Überschuss“, noch heizt
  // der Stab weiter, wenn die PV einbricht und Akku oder Netz ihn speisen.
  // Die Flüsse sind bereits vorzeichenrichtig aufgeteilt (state.victron.*).
  const v = state?.victron;
  if (v && v.solarToGridW != null && v.gridImportW != null && v.batteryDischargeW != null) {
    const pvToGrid = Number(v.solarToGridW);
    const gridImport = Number(v.gridImportW);
    const discharge = Number(v.batteryDischargeW);
    if (Number.isFinite(pvToGrid) && Number.isFinite(gridImport) && Number.isFinite(discharge)) {
      return Math.max(0, pvToGrid + own - Math.max(0, gridImport) - Math.max(0, discharge));
    }
  }
  // Ohne aufgeteilte Flüsse: Netzwert, mit dem Vorzeichen der Anlage. Vorher
  // stand hier fest „Einspeisung = negativ“ — bei gridPositiveMeans='feed_in'
  // galt damit Netzbezug als Überschuss und der Heizstab lief mit Netzstrom.
  const grid = Number(state?.meter?.grid_total_w);
  if (!Number.isFinite(grid)) return 0;
  const exportW = cfg?.gridPositiveMeans === 'feed_in' ? grid : -grid;
  return Math.max(0, exportW + own);
}

/**
 * @param {object} deps
 * @param {()=>object} deps.getCfg
 * @param {(limit:number)=>Promise<object|null>} deps.getSolution  inspector.getEos → {rows, generatedAt}
 * @param {object} deps.actuator  createDeviceActuator(...)
 * @param {object} deps.state
 * @param {(event:string,data?:object)=>void} [deps.pushLog]
 * @param {()=>Promise<boolean|null>} [deps.isEvCharging]  services/wallbox/ev-charging.js
 * @param {()=>number} [deps.now]
 */
export function createEosDeviceBridge(deps) {
  const { getCfg, getSolution, actuator, state, pushLog = () => {}, isEvCharging = null, now = () => Date.now() } = deps;

  let timer = null;
  let ticking = false;
  let lastTickAt = 0;
  let lastError = null;
  const lastCmd = new Map();      // deviceId → commandKey
  const lastPower = new Map();    // deviceId → letzte Heizleistung (für Überschuss-Ramp)
  // Heute an jeden Heizstab gelieferte Energie (aus der gestellten Leistung
  // hochgerechnet) — die Lastvorhaltung für EOS zieht sie von der Tagesmenge ab
  // (heater-load-reservation.js). state.optimizer.heaterEnergyToday[id] = {date, wh}.
  let lastHeaterTickMs = 0;
  function trackHeaterEnergy(id, powerW, nowMs, timeZone) {
    if (!state) return;
    state.optimizer = state.optimizer || {};
    const book = state.optimizer.heaterEnergyToday = state.optimizer.heaterEnergyToday || {};
    const today = localDate(nowMs, timeZone);
    if (!book[id] || book[id].date !== today) book[id] = { date: today, wh: 0 };
    // Zeit seit dem letzten Takt, höchstens 2 min (Pausen/Neustart nicht als Laufzeit zählen).
    const dtH = lastHeaterTickMs > 0 ? Math.min(Math.max(0, nowMs - lastHeaterTickMs), 120_000) / 3600_000 : 0;
    book[id].wh += Math.max(0, Number(powerW) || 0) * dtH;
  }
  const lastDevice = new Map();   // deviceId → zuletzt gesteuertes (normalisiertes) Gerät
  // Abgeschlossene Läufe heute je planbarem Gerät (EOS 0.4 will sie als
  // Messwert <eosId>.cycles_completed — fehlt er, bricht EOS JEDEN Lauf ab,
  // „Invalid completed cycle count“, Pi 2026-10-01). Ein Lauf zählt, wenn das
  // Gerät nach mindestens der halben geplanten Dauer wieder ausgeht.
  const onSince = new Map();      // deviceId → ms seit an
  const cycles = { day: null, byDevice: new Map() };
  const localDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: getCfg()?.timeZone || 'Europe/Berlin' }).format(new Date(ms));
  function trackCycle(d, on, eosId) {
    const t = now();
    const day = localDay(t);
    if (cycles.day !== day) { cycles.day = day; cycles.byDevice.clear(); }
    const since = onSince.get(d.id);
    if (on && since == null) onSince.set(d.id, t);
    if (!on && since != null) {
      onSince.delete(d.id);
      const minMs = 0.5 * (Number(d.plan?.durationH) || 1) * 3_600_000;
      if (t - since >= minMs) cycles.byDevice.set(d.id, (cycles.byDevice.get(d.id) || 0) + 1);
    }
    if (state && eosId) {
      state.optimizer = state.optimizer || {};
      const m = state.optimizer.applianceCyclesToday || {};
      m[eosId] = cycles.byDevice.get(d.id) || 0;
      state.optimizer.applianceCyclesToday = m;
    }
  }
  let lastStatus = [];

  async function actuate(device, command) {
    lastDevice.set(device.id, device);
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

  // Codex-P1: ein Gerät, das deaktiviert/gelöscht wurde, darf nicht in seinem
  // letzten Zustand hängen bleiben. Vor dem Vergessen einmal AUS/0 W senden.
  async function stopDropped(activeIds) {
    for (const [id, dev] of [...lastDevice.entries()]) {
      if (activeIds.has(id)) continue;
      const off = dev.kind === 'modulating' ? { powerW: 0 } : { on: false };
      const r = await actuator.apply(dev, off);
      pushLog(r?.ok ? 'device_stopped_on_removal' : 'device_stop_error', { id, endpoint: dev.endpoint?.type, error: r?.ok ? undefined : (r?.error || 'unknown') });
      // Nur vergessen, wenn der Stopp durchkam — sonst nächsten Takt erneut versuchen.
      if (r?.ok) { lastDevice.delete(id); lastCmd.delete(id); lastPower.delete(id); }
    }
  }

  async function tick({ force = false } = {}) {
    if (ticking) return { ok: false, error: 'busy' };
    ticking = true;
    lastTickAt = now();
    if (force) lastCmd.clear();
    try {
      const cfg = getCfg() || {};
      if (isReadOnlyMode()) return { ok: false, skipped: 'read_only' };
      // Not-Halt (state.ctrl.discretionaryWritesPaused) friert wie ueberall im
      // Code ein: Geraete bleiben im letzten Zustand, kein Schalten, auch nicht
      // das Ausschalten entfernter Geraete. Nach dem Aufheben regelt der
      // naechste Takt normal weiter.
      if (state?.ctrl?.discretionaryWritesPaused === true) return { ok: false, skipped: 'paused' };
      const { devices } = loadSchedulableDevices(cfg);
      // my-PV-Heizstäbe regelt der schnelle Regler (devices/mypv-regulator.js) im
      // eigenen 5-s-Takt; hier nicht doppelt.
      const enabled = devices.filter((d) => d.enabled !== false && d.endpoint?.type !== 'mypv');
      // Zuvor gesteuerte, jetzt entfernte/deaktivierte Geräte einmal ausschalten.
      const activeIds = new Set(enabled.map((d) => d.id));
      await stopDropped(activeIds);
      if (!enabled.length) { if (state?.optimizer) state.optimizer.devicePlan = []; return { ok: true, skipped: 'no_devices' }; }

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
          if (r?.ok !== false) trackCycle(d, on, eosId);
          status.push({ id: d.id, kind: 'deferrable', on, ok: r?.ok !== false });
        }
      }

      // --- modulating: PV-Überschuss-Regler ---
      // Wallbox nur fragen, wenn ein Heizstab ihr Vorrang lassen soll.
      let evCharging = null;
      if (typeof isEvCharging === 'function' && modulating.some((d) => d.plan?.pauseWhileEvCharging === true)) {
        try { evCharging = await isEvCharging(); } catch { evCharging = null; }
      }
      for (const d of modulating) {
        const p = d.plan || {};
        if (p.pauseWhileEvCharging === true && evCharging === true) {
          const r = await actuate(d, { powerW: 0 });
          status.push({ id: d.id, kind: 'modulating', powerW: 0, reason: 'ev_charging', ok: r?.ok !== false });
          devicePlan.push({ device: d.id, kind: 'modulating', powerW: 0, reason: 'ev_charging', at: new Date(now()).toISOString() });
          continue;
        }
        const avail = surplusW(state, lastPower.get(d.id) || 0, getCfg());
        const { powerW, reason } = computeHeaterPowerW({
          maxPowerW: p.maxPowerW, minPowerW: p.minPowerW,
          surplusW: avail,
          socPct: null,               // v1: kein thermischer Sensor → reine Überschuss-Folge
          targetPct: p.targetPct ?? null,
          capacityWh: p.capacityWh ?? null,
          deadlineMs: null,           // Deadline-Boost aktiv, sobald socPct verfügbar (Folgearbeit)
          nowMs: now(),
        });
        // Die bis jetzt gestellte Leistung gilt für die Zeit seit dem letzten Takt.
        trackHeaterEnergy(d.id, lastPower.get(d.id) || 0, now(), getCfg()?.optimizer?.timezone || 'Europe/Berlin');
        const r = await actuate(d, { powerW });
        status.push({ id: d.id, kind: 'modulating', powerW, reason, ok: r?.ok !== false });
        devicePlan.push({ device: d.id, kind: 'modulating', powerW, reason, at: new Date(now()).toISOString() });
      }
      lastHeaterTickMs = now();

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
