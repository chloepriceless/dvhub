// services/grid-voltage.js — Netzspannung L1–L3 und Netzfrequenz des
// Netzzählers, an EINER Stelle gelesen (Christin 05.11.2026: „nicht neu suchen
// und anbinden, sondern die Daten, die wir im Leitstand haben, anbinden“).
//
// Der Poller (polling.js) ruft onPoll() in jedem Durchlauf; das Ergebnis steht
// in state.victron.gridVoltage und damit in /api/status (victron.gridVoltage):
//   { l1, l2, l3 (V oder null), frequencyHz (oder null), updatedAt (ms der
//     Messung), source, unitId (nur Victron Modbus), error }
// oder null, wenn die Anlage keine Spannungen liefert. Abnehmer (Ortsnetz,
// Datenspende) prüfen die Frische mit freshGridVoltage().
//
// Quellen:
//   Victron Modbus  com.victronenergy.grid, Register 2616/2618/2620 (×0,1 V)
//                   und 2644 (×0,01 Hz), nur lesend (FC3), alle 30 s.
//                   Die Unit-ID folgt der DeviceInstance des Zählers; Instance 0
//                   legt der GX auf Unit 100, weil Modbus-Unit 0 Broadcast ist.
//                   Ein VE.Can-Zähler mit Instance 0 (Christins VM-3P75CT,
//                   N/<portal>/grid/0/…) antwortet deshalb auf Unit 100 neben dem
//                   Sammelfach 820ff. — am GX .19 nur lesend geprüft 05.11.2026.
//                   Ablauf: zuerst die konfigurierte bzw. System-Unit
//                   (victron.unitId, Standard 100) — antwortet sie, wird nie
//                   gesucht. Antwortet sie mit einer Modbus-Ausnahme (GH #33:
//                   Ausnahme 10, Zähler per Ethernet an Unit 40 bzw. EM540 per
//                   Modbus an Unit 31) oder meldet sie keine Spannung, wird die
//                   Unit des grid-Dienstes einmal gesucht wie in
//                   services/victron-gx/devices.js (erst 30–49, dann 1–247),
//                   gemerkt und im Log genannt. Zeitüberschreitung (GX weg) ist
//                   kein Grund zu suchen.
//   Victron MQTT    N/<portal>/grid/<instanz>/Ac/L1..L3/Voltage, /Ac/Frequency
//                   (transport-mqtt.js readGridVoltage), in jedem Durchlauf.
//   SPiNE EnergyLink EM.GetStatus (a/b/c_voltage, freq), das der Poller ohnehin
//                   für die Netzleistung holt.
// Andere Profile (Fronius, Deye, DVhub-MQTT) definieren keine Spannungsfelder —
// dort bleibt der Wert null.

import { scanGxServices, GX_SCAN_UNITS } from './victron-gx/devices.js';

export const VICTRON_GRID_REGS = Object.freeze({ l1: 2616, l2: 2618, l3: 2620, frequency: 2644 });
export const GRID_VOLTAGE_POLL_MS = 30_000;
export const GRID_VOLTAGE_MAX_AGE_MS = 2 * 60_000;
export const GRID_UNIT_RESCAN_MS = 30 * 60_000;
// Erste Modbus-Lesung kurz nach dem Start, wenn die Verbindung steht.
export const GRID_VOLTAGE_FIRST_DELAY_MS = 10_000;
const GRID_PROBES = Object.freeze([{ kind: 'grid', address: VICTRON_GRID_REGS.l1 }]);
// Suchreihenfolge: typische Zähler-Units (30–49) zuerst, dann alle übrigen.
const TYPICAL_GRID_UNITS = Array.from({ length: 20 }, (_, i) => 30 + i);
export const GRID_SCAN_ORDER = Object.freeze([...TYPICAL_GRID_UNITS, ...GX_SCAN_UNITS.filter((u) => !TYPICAL_GRID_UNITS.includes(u))]);
const TIMEOUT_MS = 1500;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
const unitIdOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 247 ? n : null;
};

class NoGridVoltageError extends Error {
  constructor() { super('grid_meter_no_voltage'); }
}
// Diese Unit ist nicht der Netzzähler: Modbus-Ausnahme (10 = unbekannte Unit,
// 2 = Register fehlt) oder alle Spannungen „nicht verfügbar“.
const wrongUnit = (e) => e instanceof NoGridVoltageError || /modbus exception/.test(String(e?.message));

/** Victron-Netzzähler lesen. Rohwerte uint16 → V / Hz; 0xFFFF = nicht verfügbar. */
export async function readVictronGridVoltage(mbRequest, { host, port, unitId, timeoutMs }) {
  const base = { fc: 3, host, port: port || 502, unitId, timeoutMs: timeoutMs || TIMEOUT_MS };
  const v = await mbRequest({ ...base, address: VICTRON_GRID_REGS.l1, quantity: 5 }); // 2616..2620
  const f = await mbRequest({ ...base, address: VICTRON_GRID_REGS.frequency, quantity: 1 });
  const regs = Array.isArray(v) ? v : v?.values;
  const fr = Array.isArray(f) ? f : f?.values;
  if (!Array.isArray(regs) || regs.length < 5) throw new Error('grid_meter_unreadable');
  const volt = (r) => (r == null || r === 0xffff ? null : r / 10);
  return {
    l1: volt(regs[0]), l2: volt(regs[2]), l3: volt(regs[4]),
    frequencyHz: Array.isArray(fr) && fr[0] != null && fr[0] !== 0xffff ? fr[0] / 100 : null,
  };
}

/**
 * Frische Netzwerte für Abnehmer.
 * @returns {{ok:true,l1,l2,l3,frequencyHz,updatedAt,source} | {ok:false,reason:string,error?:string}}
 */
export function freshGridVoltage(gv, nowMs = Date.now(), maxAgeMs = GRID_VOLTAGE_MAX_AGE_MS) {
  if (!gv || typeof gv !== 'object' || ![gv.l1, gv.l2, gv.l3].some(isNum)) {
    const out = { ok: false, reason: 'voltage_unavailable' };
    if (gv?.error) out.error = String(gv.error);
    return out;
  }
  const at = Number(gv.updatedAt);
  if (!Number.isFinite(at) || nowMs - at > maxAgeMs) return { ok: false, reason: 'voltage_stale' };
  return { ok: true, l1: gv.l1, l2: gv.l2, l3: gv.l3, frequencyHz: gv.frequencyHz ?? null, updatedAt: at, source: gv.source };
}

/** SPiNE/Shelly EM.GetStatus → Spannungen; 0 V = Phase nicht angeschlossen. */
function fromSpine(em) {
  const volt = (v) => (isNum(Number(v)) && Number(v) > 0 ? round(Number(v), 1) : null);
  const freqRaw = [em?.freq, em?.a_freq, em?.b_freq, em?.c_freq].map(Number).find((v) => isNum(v) && v > 0);
  return { l1: volt(em?.a_voltage), l2: volt(em?.b_voltage), l3: volt(em?.c_voltage), frequencyHz: freqRaw == null ? null : round(freqRaw, 2) };
}

/**
 * Der zentrale Leser. deps: { state, pushLog, getTransport, now, firstDelayMs }.
 * onPoll(cfg, { spine, spineAt }) gibt ein Promise zurück; polling.js wartet
 * NICHT darauf, damit eine Unit-Suche den Steuer-Takt nie aufhält (die
 * Modbus-Warteschlange schiebt die Steuer-Lesungen zwischen die Suchanfragen).
 */
export function createGridVoltagePoller({ state, pushLog = () => {}, getTransport = () => null, now = () => Date.now(), firstDelayMs = GRID_VOLTAGE_FIRST_DELAY_MS } = {}) {
  let nextModbusAt = now() + firstDelayMs;
  let nextScanAt = 0;
  let foundUnit = null;
  let running = null;

  const victronState = () => (state.victron ??= {});
  function set(gv) { victronState().gridVoltage = gv; }
  function setError(message) {
    const prev = victronState().gridVoltage;
    set({
      l1: prev?.l1 ?? null, l2: prev?.l2 ?? null, l3: prev?.l3 ?? null, frequencyHz: prev?.frequencyHz ?? null,
      updatedAt: prev?.updatedAt ?? null, source: 'victron_modbus', unitId: prev?.unitId ?? null,
      error: String(message || 'unbekannt').slice(0, 160),
    });
  }

  function sourceOf(cfg, transport) {
    if (String(cfg?.meter?.readType || '').toLowerCase() === 'spine-http') return 'spine';
    if (transport?.type === 'mqtt') return 'mqtt';
    if (cfg?.manufacturer && cfg.manufacturer !== 'victron') return null;
    if (transport?.type === 'modbus' && typeof transport.mbRequest === 'function' && cfg?.victron?.host) return 'modbus';
    return null;
  }

  async function readModbus(cfg, mbRequest) {
    const v = cfg.victron || {};
    const base = { host: v.host, port: v.port || 502, timeoutMs: v.timeoutMs };
    const configured = unitIdOrNull(v.unitId) ?? 100;
    const readAt = async (unitId) => {
      const m = await readVictronGridVoltage(mbRequest, { ...base, unitId });
      if (![m.l1, m.l2, m.l3].some(isNum)) throw new NoGridVoltageError();
      return m;
    };
    const unit = foundUnit ?? configured;
    try {
      const m = await readAt(unit);
      set({ ...m, updatedAt: now(), source: 'victron_modbus', unitId: unit, error: null });
      return;
    } catch (e) {
      if (!wrongUnit(e)) { setError(e?.message); return; }
      if (foundUnit != null) {
        // Gemerkte Unit antwortet nicht mehr als Netzzähler (Zähler getauscht,
        // GX neu nummeriert): vergessen und gleich neu suchen.
        pushLog('victron_grid_meter_lost', { unitId: foundUnit, error: String(e?.message || e).slice(0, 80) });
        foundUnit = null;
        nextScanAt = 0;
      }
    }
    if (now() < nextScanAt) { setError('grid_meter_not_found'); return; }
    nextScanAt = now() + GRID_UNIT_RESCAN_MS;
    let hit;
    try {
      const found = await scanGxServices(mbRequest, { ...base, units: GRID_SCAN_ORDER.filter((u) => u !== unit), probes: GRID_PROBES, firstOnly: true });
      hit = found[0]?.unitId ?? null;
    } catch (e) {
      setError(e?.message);
      return;
    }
    if (hit == null) {
      pushLog('victron_grid_meter_not_found', { configuredUnitId: configured });
      setError('grid_meter_not_found');
      return;
    }
    try {
      const m = await readAt(hit);
      foundUnit = hit;
      pushLog('victron_grid_meter_found', { unitId: hit, configuredUnitId: configured });
      set({ ...m, updatedAt: now(), source: 'victron_modbus', unitId: hit, error: null });
    } catch (e) {
      setError(e instanceof NoGridVoltageError ? 'grid_meter_not_found' : e?.message);
    }
  }

  async function onPoll(cfg, { spine, spineAt } = {}) {
    try {
      const transport = getTransport();
      const src = sourceOf(cfg, transport);
      if (src === 'spine') {
        if (spine && typeof spine === 'object') {
          set({ ...fromSpine(spine), updatedAt: Number(spineAt) || now(), source: 'spine_http', unitId: null, error: null });
        }
        return;
      }
      if (src === 'mqtt') {
        const g = typeof transport.readGridVoltage === 'function' ? transport.readGridVoltage() : null;
        set(g && [g.l1, g.l2, g.l3].some(isNum)
          ? { l1: g.l1 ?? null, l2: g.l2 ?? null, l3: g.l3 ?? null, frequencyHz: g.frequencyHz ?? null, updatedAt: Number(g.ts) || now(), source: 'victron_mqtt', unitId: null, error: null }
          : null);
        return;
      }
      if (src !== 'modbus') {
        if (victronState().gridVoltage !== null) set(null);
        return;
      }
      if (running) return running;
      const t = now();
      if (t < nextModbusAt) return;
      nextModbusAt = t + GRID_VOLTAGE_POLL_MS;
      // Wie bei den Geräte-Alarmen: stockt die Steuer-Abfrage, nicht noch mehr
      // Last auf den GX legen.
      if (Number(state.meter?.consecutiveErrors) > 0) return;
      running = readModbus(cfg, transport.mbRequest)
        .catch((e) => { try { pushLog('grid_voltage_error', { error: String(e?.message || e).slice(0, 160) }); } catch { /* nie werfen */ } })
        .finally(() => { running = null; });
      return running;
    } catch (e) {
      try { pushLog('grid_voltage_error', { error: String(e?.message || e).slice(0, 160) }); } catch { /* nie werfen */ }
    }
  }

  return { onPoll, get foundUnit() { return foundUnit; } };
}
