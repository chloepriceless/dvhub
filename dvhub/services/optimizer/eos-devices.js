// services/optimizer/eos-devices.js -- EOS-native Home-Appliances für planbare
// An/Aus-Verbraucher (2026-09-26). REIN (keine I/O), damit voll unit-testbar.
//
// Phase-0-Spike (EOS v0.4.0rc1 @ prod/Pi) bestätigte:
//   - HomeApplianceParameters: device_id, consumption_wh, duration_h, time_windows,
//     earliest_start_datetime, deadline_datetime (native „fertig bis"-Deadline).
//   - GeneticSolution-Dispatch: `home_appliance_running` (Map device_id → An/Aus-
//     Array je Stunde), `appliance_starts` (Map device_id → Start-Stunde),
//     `home_appliance_energy_wh` (Map). `*_per_hour`-Arrays sind STÜNDLICH.
//
// Annahme (im Integrationstest gegen echtes EOS zu bestätigen): der Dispatch-
// Zeitindex 0 == Horizontbeginn der Lösung; `home_appliance_running` ist stündlich.
// Der Parser ist defensiv: er nutzt zuerst das Running-Array, fällt sonst auf
// appliance_starts + duration_h zurück, und toleriert fehlende/leere Felder.

import { zonedToUtcMs } from './ev-departure.js';

/** EOS-sicherer Geräte-Schlüssel aus der DVhub-Geräte-ID (rückführbar über die Map). */
export function eosApplianceId(deviceId) {
  const s = String(deviceId).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  return 'appl_' + (s || 'x');
}

/**
 * Nächste zukünftige Uhrzeit HH:MM als ISO-8601 (UTC). Liegt HH:MM heute schon in
 * der Vergangenheit, wird morgen genommen.
 */
export function nextLocalTimeIso(hhmm, timeZone = 'Europe/Berlin', nowMs = Date.now()) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const hour = Number(m[1]); const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  // Kalenderdatum "heute" in der Zeitzone bestimmen.
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(nowMs));
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  let utc = zonedToUtcMs(get('year'), get('month'), get('day'), hour, minute, timeZone);
  if (utc <= nowMs) utc += 24 * 3600_000; // schon vorbei → morgen
  return new Date(utc).toISOString();
}

/**
 * HomeApplianceParameters[] für alle deferrable planbaren Geräte.
 * @param {object[]} devices  normalisierte planbare Geräte (schedulable.js)
 * @param {{ timeZone?:string, nowMs?:number }} [opts]
 * @returns {{ appliances: object[], idMap: Record<string,string> }}
 *          appliances → an EOS zu sendende Liste; idMap: eosId → DVhub-id
 */
export function buildEosHomeAppliances(devices, { timeZone = 'Europe/Berlin', nowMs = Date.now() } = {}) {
  const appliances = [];
  const idMap = {};
  for (const d of Array.isArray(devices) ? devices : []) {
    if (d?.kind !== 'deferrable' || d.enabled === false) continue;
    const p = d.plan || {};
    const eosId = eosApplianceId(d.id);
    idMap[eosId] = d.id;
    const a = {
      device_id: eosId,
      consumption_wh: Number(p.energyWh),
      // EOS rastert stündlich → mindestens 1 h, aufgerundet, damit die Laufzeit reicht.
      duration_h: Math.max(1, Math.ceil(Number(p.durationH) || 1)),
    };
    const deadline = p.deadline ? nextLocalTimeIso(p.deadline, timeZone, nowMs) : null;
    const earliest = p.earliestStart ? nextLocalTimeIso(p.earliestStart, timeZone, nowMs) : null;
    if (deadline) a.deadline_datetime = deadline;
    if (earliest) a.earliest_start_datetime = earliest;
    appliances.push(a);
  }
  return { appliances, idMap };
}

/** Zusammenhängende An-Blöcke (Wert > 0) in einem Array → [{start,end}] (inklusive Indizes). */
function onBlocks(arr) {
  const blocks = [];
  let cur = null;
  for (let i = 0; i < arr.length; i++) {
    const on = Number(arr[i]) > 0;
    if (on && !cur) cur = { start: i, end: i };
    else if (on && cur) cur.end = i;
    else if (!on && cur) { blocks.push(cur); cur = null; }
  }
  if (cur) blocks.push(cur);
  return blocks;
}

/**
 * Appliance-Dispatch aus einer GeneticSolution in Zeit-Fenster je Gerät übersetzen.
 * @param {object} sol  GeneticSolution (POST /optimize) oder deren `result`/`solution`.
 * @param {{ startMs:number, slotMinutes?:number, durationByEosId?:Record<string,number> }} opts
 * @returns {Record<string, Array<{startMs:number, endMs:number}>>}  eosId → Fenster
 */
export function parseApplianceDispatch(sol, { startMs, slotMinutes = 60, durationByEosId = {} } = {}) {
  const s = sol || {};
  const running = s.home_appliance_running || s.result?.home_appliance_running || s.solution?.home_appliance_running || null;
  const starts = s.appliance_starts || s.result?.appliance_starts || null;
  const slotMs = slotMinutes * 60_000;
  const out = {};

  if (running && typeof running === 'object') {
    for (const [eosId, arr] of Object.entries(running)) {
      if (!Array.isArray(arr)) continue;
      out[eosId] = onBlocks(arr).map((b) => ({ startMs: startMs + b.start * slotMs, endMs: startMs + (b.end + 1) * slotMs }));
    }
  }
  // Fallback / Ergänzung über appliance_starts (Start-Stunde) + Dauer.
  if (starts && typeof starts === 'object') {
    for (const [eosId, startIdxRaw] of Object.entries(starts)) {
      if (out[eosId] && out[eosId].length) continue; // running lieferte schon Fenster
      const idx = Number(startIdxRaw);
      if (!Number.isFinite(idx) || idx < 0) continue;
      const durH = Math.max(1, Math.ceil(Number(durationByEosId[eosId]) || 1));
      out[eosId] = [{ startMs: startMs + idx * slotMs, endMs: startMs + (idx + durH) * slotMs }];
    }
  }
  return out;
}

/**
 * Appliance-Dispatch aus den Adapter-Lösungszeilen (getOptimizationSolution) je
 * Gerät in Zeit-Fenster übersetzen. Jede Zeile hat `ts_utc` + `appliances`
 * (Map colKey→Zahl). Für jede konfigurierte eosId werden Slots als "an" gewertet,
 * wenn eine zugehörige „running/energy"-Spalte > 0 ist (op_mode/op_factor-Spalten
 * werden ignoriert). endMs = Beginn des nächsten Slots (bzw. + mittlere Slotlänge
 * beim letzten). Aligned zum echten Zeitindex — kein Stunden-vs-15-min-Rätsel.
 * @param {Array<{ts_utc:string, appliances:object|null}>} rows
 * @param {Record<string,string>} idMap  eosId → DVhub-id
 * @returns {Record<string, Array<{startMs:number, endMs:number}>>} eosId → Fenster
 */
export function parseApplianceRowsDispatch(rows, idMap = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const eosIds = Object.keys(idMap || {});
  if (!list.length || !eosIds.length) return {};
  const tsMs = list.map((r) => Date.parse(r?.ts_utc));
  // mittlere Slotlänge für das Ende des letzten Slots
  let slotMs = 15 * 60_000;
  if (tsMs.length >= 2 && Number.isFinite(tsMs[1] - tsMs[0]) && tsMs[1] - tsMs[0] > 0) slotMs = tsMs[1] - tsMs[0];

  const isOnCol = (key) => /(_running$|_energy_wh$|_on$|_active$)/.test(key) || false;
  const out = {};
  for (const eosId of eosIds) {
    const onFlags = list.map((r) => {
      const ap = r?.appliances;
      if (!ap || typeof ap !== 'object') return false;
      // bevorzugt „running/energy"-Spalten dieses Geräts; sonst die bare eosId-Spalte
      let any = false;
      for (const [k, v] of Object.entries(ap)) {
        if (!k.startsWith(eosId)) continue;
        if (isOnCol(k) || k === eosId) { if (Number(v) > 0) { any = true; break; } }
      }
      return any;
    });
    const windows = [];
    let cur = null;
    for (let i = 0; i < onFlags.length; i++) {
      if (onFlags[i] && !cur) cur = { s: i, e: i };
      else if (onFlags[i] && cur) cur.e = i;
      else if (!onFlags[i] && cur) { windows.push(cur); cur = null; }
    }
    if (cur) windows.push(cur);
    if (windows.length) {
      out[eosId] = windows.map((w) => ({
        startMs: tsMs[w.s],
        endMs: (tsMs[w.e] + slotMs),
      })).filter((x) => Number.isFinite(x.startMs) && Number.isFinite(x.endMs));
    }
  }
  return out;
}

/**
 * Dispatch-Fenster → Plan-Slots für plan.devices (optimizer-plan.js).
 * @param {Record<string,Array<{startMs,endMs}>>} dispatch
 * @param {Record<string,string>} idMap  eosId → DVhub-id
 * @returns {Array<{device:string, start:string, end:string, action:'on'}>}
 */
export function applianceDispatchToPlanSlots(dispatch, idMap = {}) {
  const slots = [];
  for (const [eosId, windows] of Object.entries(dispatch || {})) {
    const device = idMap[eosId] || eosId;
    for (const w of windows) {
      if (!Number.isFinite(w.startMs) || !Number.isFinite(w.endMs)) continue;
      slots.push({ device, start: new Date(w.startMs).toISOString(), end: new Date(w.endMs).toISOString(), action: 'on' });
    }
  }
  return slots.sort((a, b) => a.start.localeCompare(b.start));
}
