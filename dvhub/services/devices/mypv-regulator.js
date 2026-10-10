// services/devices/mypv-regulator.js — schneller Überschuss-Regler für my-PV-Heizstäbe.
//
// Übernommen aus dem Ohmpilot-Übersetzer (controller.py), der so an einer
// Fronius-Anlage mit AC THOR und Wattpilot läuft. Gerechnet wird am
// Netzanschlusspunkt, ohne Einzelmessungen:
//
//     Ziel = aktuelle Heizleistung + Einspeisung − Reserve − Akku-Entladung
//
// Alles, was Haus, Auto und Akku ziehen, fehlt bereits in der Einspeisung.
// Der Netzzähler zeigt eine Änderung der Heizleistung erst Sekunden später;
// wer in dieser Zeit kräftig nachregelt, schaukelt sich auf. Deshalb: nach
// oben langsam und mit begrenzter Steigung, nach unten zügig, bei Netzbezug
// sofort. Verheizt wird nie aus dem Akku und nie aus dem Netz.
//
// Auto-Vorrang (plan.pauseWhileEvCharging): wartet ein angestecktes Auto auf
// den Ladestart, bleibt der Stab aus (optional mit Zeitlimit); lädt es, bekommt
// der Stab nach einer Wartezeit den Rest; ist es fertig, regelt er normal.
//
// Läuft nur für planbare Geräte mit Endpunkt „mypv“; die 30-s-Brücke
// (eos-device-bridge.js) lässt diese Geräte aus.

import { createMypvClient } from './mypv.js';
import { loadSchedulableDevices } from './schedulable.js';
import { localDate } from '../../tz-fast.js';

export const MYPV_DEFAULTS = Object.freeze({
  exportReserveW: 1000,
  startThresholdW: 200,
  rampUpWps: 300,
  minSocPct: 0,
  carSettleS: 60,
  carWaitTimeoutMin: 0,
  intervalS: 5
});
export const RAMP_UP_GAIN = 0.3;
export const RAMP_DOWN_GAIN = 0.6;
export const RAMP_DOWN_W_PER_S = 1000;
export const STOP_THRESHOLD_W = 50;
// Messwerte der Anlage älter als das → Heizstab aus.
export const MAX_DATA_AGE_MS = 15_000;

/**
 * Reine Regelentscheidung (ohne I/O).
 *
 * @param {object} plan     Geräteplan (maxPowerW, minPowerW, Reglerfelder)
 * @param {object} live
 * @param {number} live.heaterPowerW  gemessene (sonst zuletzt gestellte) Heizleistung
 * @param {number} live.exportW       Einspeisung ≥ 0
 * @param {number} live.importW       Netzbezug ≥ 0
 * @param {number} live.dischargeW    Akku-Entladung ≥ 0
 * @param {number|null} live.socPct
 * @param {number|null} live.dataAgeMs  Alter der Anlagen-Messwerte
 * @param {boolean} [live.deviceOff]    am Gerät ausgeschaltet
 * @param {object|null} live.car        { state:'idle'|'waiting'|'charging'|'complete'|null, sinceMs }
 * @param {number} prevSetpointW
 * @param {number} nowMs
 * @returns {{ powerW:number, reason:string, surplusW:number, blockedByCar:boolean }}
 */
export function decideMypvSetpoint(plan, live, prevSetpointW, nowMs) {
  const p = { ...MYPV_DEFAULTS, ...Object.fromEntries(Object.entries(plan || {}).filter(([, v]) => v != null)) };
  const maxPowerW = Math.max(0, Number(p.maxPowerW) || 0);
  const off = (reason, extra = {}) => ({ powerW: 0, reason, surplusW: 0, blockedByCar: false, ...extra });
  if (maxPowerW <= 0) return off('Keine Höchstleistung eingestellt');
  if (live.deviceOff === true) return off('Am Gerät ausgeschaltet');
  if (live.dataAgeMs == null || live.dataAgeMs > MAX_DATA_AGE_MS) return off('Keine aktuellen Messwerte der Anlage');

  const car = live.car || null;
  if (p.pauseWhileEvCharging === true && car) {
    if (car.state === 'waiting') {
      const timeoutMs = Number(p.carWaitTimeoutMin) * 60_000;
      const waited = nowMs - (Number(car.sinceMs) || nowMs);
      if (!timeoutMs || waited < timeoutMs) return off('Auto angesteckt — wartet auf den Ladestart', { blockedByCar: true });
    } else if (car.state === 'charging') {
      const charging = nowMs - (Number(car.sinceMs) || nowMs);
      if (charging < Number(p.carSettleS) * 1000) return off('Auto lädt an — Heizstab wartet', { blockedByCar: true });
    }
  }

  if (live.socPct != null && Number(p.minSocPct) > 0 && Number(live.socPct) < Number(p.minSocPct)) {
    return off(`Akku unter ${p.minSocPct} %`);
  }

  const heater = Math.max(0, Number(live.heaterPowerW) || 0);
  const exportW = Math.max(0, Number(live.exportW) || 0);
  const importW = Math.max(0, Number(live.importW) || 0);
  const discharge = Math.max(0, Number(live.dischargeW) || 0);
  const surplusW = heater + exportW - importW - Number(p.exportReserveW) - discharge;
  const target = Math.max(0, Math.min(surplusW, maxPowerW));
  const prev = Math.max(0, Number(prevSetpointW) || 0);
  if (prev === 0 && target < Number(p.startThresholdW)) return off('Kein Überschuss', { surplusW });

  const dtS = Number(p.intervalS);
  let setpoint;
  if (target > prev) setpoint = prev + Math.min(RAMP_UP_GAIN * (target - prev), Number(p.rampUpWps) * dtS);
  else if (importW > 0) setpoint = target;
  else setpoint = prev - Math.min(RAMP_DOWN_GAIN * (prev - target), RAMP_DOWN_W_PER_S * dtS);

  if (setpoint < STOP_THRESHOLD_W) return off('Kein Überschuss', { surplusW });
  const minPowerW = Math.max(0, Number(p.minPowerW) || 0);
  if (minPowerW > 0 && setpoint < minPowerW) return off(`Überschuss unter der Mindestleistung (${minPowerW} W)`, { surplusW });
  return { powerW: Math.round(setpoint), reason: 'Überschuss wird verheizt', surplusW, blockedByCar: false };
}

/**
 * Zustand des Autos aus der Wallbox (direkte Box oder evcc).
 * @returns {{state:string|null}|null}
 */
export function carStateFromCharger(st) {
  if (!st) return null;
  if (st.charging === true) return { state: 'charging' };
  if (st.carState === 'waiting') return { state: 'waiting' };
  if (st.carState === 'complete') return { state: 'complete' };
  if (st.connected === true) return { state: st.carState || 'complete' };
  return { state: 'idle' };
}

/**
 * @param {object} deps
 * @param {()=>object} deps.getCfg
 * @param {object} deps.state
 * @param {(e:string,d?:object,l?:string)=>void} [deps.pushLog]
 * @param {()=>object|null} [deps.getCharger]   letzter Wallbox-Zustand ({connected, charging, carState})
 * @param {(endpoint:object)=>object} [deps.createClient]
 * @param {()=>number} [deps.now]
 */
export function createMypvRegulator({ getCfg, state, pushLog = () => {}, getCharger = () => null, createClient = createMypvClient, now = () => Date.now() }) {
  const clients = new Map();     // deviceId → { key, client }
  const devices = new Map();     // deviceId → Laufzeit { setpoint, measured, reason, car, lastTickMs, error }
  let timer = null;
  let running = false;

  function clientFor(dev) {
    const key = `${dev.endpoint.host}:${dev.endpoint.port}:${dev.endpoint.unit}`;
    const have = clients.get(dev.id);
    if (have && have.key === key) return have.client;
    have?.client.close?.();
    const client = createClient(dev.endpoint);
    clients.set(dev.id, { key, client });
    return client;
  }

  function runtime(id) {
    if (!devices.has(id)) devices.set(id, { setpoint: 0, measured: null, reason: 'Start', car: null, carSince: null, lastTickMs: 0, error: null, surplusW: 0 });
    return devices.get(id);
  }

  function trackEnergy(id, powerW, nowMs, dtMs) {
    if (!state) return;
    state.optimizer = state.optimizer || {};
    const book = state.optimizer.heaterEnergyToday = state.optimizer.heaterEnergyToday || {};
    const today = localDate(nowMs, getCfg()?.optimizer?.timezone || 'Europe/Berlin');
    if (!book[id] || book[id].date !== today) book[id] = { date: today, wh: 0 };
    book[id].wh += Math.max(0, Number(powerW) || 0) * Math.min(Math.max(0, dtMs), 120_000) / 3600_000;
  }

  function liveFromState() {
    const v = state?.victron || {};
    const stamps = v.fieldUpdatedAt || {};
    const meterAt = Number(state?.meter?.updatedAt) || Number(stamps.gridTotalW) || 0;
    const t = now();
    return {
      exportW: Number(v.gridExportW) || 0,
      importW: Number(v.gridImportW) || 0,
      dischargeW: Number(v.batteryDischargeW) || (Number(v.batteryPowerW) < 0 ? -Number(v.batteryPowerW) : 0),
      socPct: Number.isFinite(Number(v.soc)) ? Number(v.soc) : null,
      dataAgeMs: state?.meter?.ok === false ? null : (meterAt > 0 ? t - meterAt : null)
    };
  }

  async function tickDevice(dev, base) {
    const rt = runtime(dev.id);
    const t = now();
    const client = clientFor(dev);
    let measured = null;
    try {
      measured = await client.read();
      rt.measured = { ...measured, at: t };
      rt.error = null;
    } catch (e) {
      rt.error = `Lesen: ${String(e?.message || e).slice(0, 120)}`;
    }
    // Auto-Zustand mit Zeitstempel des Wechsels (Wartezeit/Zeitlimit).
    const car = carStateFromCharger(getCharger());
    if (car && car.state !== rt.car) { rt.car = car.state; rt.carSince = t; }
    if (!car) { rt.car = null; rt.carSince = null; }
    const decision = decideMypvSetpoint(dev.plan, {
      ...base,
      heaterPowerW: measured ? measured.powerW : rt.setpoint,
      deviceOff: measured ? measured.deviceOn === false : false,
      car: rt.car ? { state: rt.car, sinceMs: rt.carSince } : null
    }, rt.setpoint, t);
    if (decision.reason !== rt.reason) pushLog('mypv_regulator', { id: dev.id, powerW: decision.powerW, reason: decision.reason });
    trackEnergy(dev.id, measured ? measured.powerW : rt.setpoint, t, rt.lastTickMs ? t - rt.lastTickMs : 0);
    try {
      // In jedem Takt schreiben: der „Power Timeout“ des Geräts schaltet sonst ab.
      await client.writePower(decision.powerW);
      if (rt.error?.startsWith('Schreiben')) rt.error = null;
    } catch (e) {
      const msg = `Schreiben: ${String(e?.message || e).slice(0, 120)}`;
      if (rt.error !== msg) pushLog('mypv_write_error', { id: dev.id, error: msg }, 'warn');
      rt.error = msg;
    }
    rt.setpoint = decision.powerW;
    rt.reason = decision.reason;
    rt.surplusW = Math.round(decision.surplusW || 0);
    rt.blockedByCar = decision.blockedByCar;
    rt.lastTickMs = t;
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      const { devices: all } = loadSchedulableDevices(getCfg());
      const mine = all.filter((d) => d.enabled !== false && d.kind === 'modulating' && d.endpoint?.type === 'mypv');
      // Entfernte/umgestellte Geräte einmal ausschalten und vergessen.
      const ids = new Set(mine.map((d) => d.id));
      for (const [id, c] of [...clients.entries()]) {
        if (ids.has(id)) continue;
        try { await c.client.writePower(0); } catch { /* best effort */ }
        c.client.close?.();
        clients.delete(id);
        devices.delete(id);
      }
      // Not-Halt: Geräte bleiben, wie sie sind (wie überall in DVhub).
      if (state?.ctrl?.discretionaryWritesPaused === true) return;
      const base = liveFromState();
      for (const dev of mine) {
        const rt = runtime(dev.id);
        const intervalMs = Number(dev.plan?.intervalS || MYPV_DEFAULTS.intervalS) * 1000;
        if (rt.lastTickMs && now() - rt.lastTickMs < intervalMs - 200) continue;
        await tickDevice(dev, base);
      }
    } catch (e) {
      pushLog('mypv_regulator_error', { error: String(e?.message || e).slice(0, 160) }, 'warn');
    } finally {
      running = false;
    }
  }

  return {
    tick,
    start() {
      if (timer) return;
      timer = setInterval(() => { tick().catch(() => {}); }, 1000);
      timer.unref?.();
    },
    async stop() {
      if (timer) { clearInterval(timer); timer = null; }
      // Beim Beenden aus — zusätzlich greift der Power Timeout am Gerät.
      for (const c of clients.values()) {
        try { await c.client.writePower(0); } catch { /* best effort */ }
        c.client.close?.();
      }
      clients.clear();
    },
    /** Für Oberfläche/API: je Gerät Sollwert, Messwerte, Grund, Fehler. */
    getStatus() {
      const out = {};
      for (const [id, rt] of devices) {
        out[id] = {
          setpointW: rt.setpoint, reason: rt.reason, surplusW: rt.surplusW, blockedByCar: rt.blockedByCar === true,
          powerW: rt.measured?.powerW ?? null, tempC: rt.measured?.tempC ?? null, statusText: rt.measured?.statusText ?? null,
          ctrlMode: rt.measured?.ctrlMode ?? null, deviceOn: rt.measured?.deviceOn ?? null,
          car: rt.car, error: rt.error, at: rt.lastTickMs ? new Date(rt.lastTickMs).toISOString() : null
        };
      }
      return out;
    },
    handles: (dev) => dev?.kind === 'modulating' && dev?.endpoint?.type === 'mypv'
  };
}
