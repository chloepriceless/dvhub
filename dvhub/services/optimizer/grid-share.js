// services/optimizer/grid-share.js — Netzstrom-Zähler im Akku (Christin 01./02.11.2026).
//
// Netzladen (dynamischer Tarif, §14a Modul 3) an einer PV-Anlage in der
// Direktvermarktung: Es darf rechnerisch NIE Netzstrom mit Marktprämie verkauft
// werden. Dazu führt DVhub einen virtuellen Zähler, wie viel Netzstrom im Akku
// steckt, und sperrt die Akku-Einspeisung, solange es mehr als eine kleine
// Schwelle ist.
//
// Zählregel (Energieflüsse aus polling.js, Gleichstromseite des Akkus):
//   Netz→Akku          erhöht den Netzstrom-Anteil G um die geladene Energie.
//   Akku→Haus/Netz     senkt G anteilig: Anteil (G / Akku-Inhalt) × Entladung.
//   Verluste           anteilig: die Wandlungsverluste stecken in den Flüssen
//                      (gemessen am Akku), alles Weitere zeigt der Ladestand —
//                      G kann nie größer sein als der Akku-Inhalt. Weil der
//                      Victron-Ladestand ganzzahlig ist, gilt als Obergrenze
//                      (Ladestand + 1 %) × Kapazität.
// Akku-Inhalt = Ladestand × Kapazität (beide GX-Anlagen zusammen, wie EOS plant).
//
// Sperre: gilt an einer PV-Anlage ohne MiSpeL-Option (nur „Netzladen auch ohne
// Pauschal-/Abgrenzungsoption“). Im reinen Netzspeicher gibt es keine geförderte
// Erzeugung, mit Pauschal- oder Abgrenzungsoption regelt die Option die
// Vermischung. Gesperrt heißt:
//   - Ausführung (schedule-eval): jeder diskretionäre negative Netz-Sollwert
//     wird auf den Live-PV-Überschuss gedeckelt; PV-Einspeisung bleibt, der
//     Standard-Puffer (schedule.defaultGridSetpointW, z. B. −100 W) auch.
//   - Planung: EOS bekommt die Akku-Netzeinspeisung abgeschaltet
//     (feedintariff/direct_marketing_enabled = false, eos-config-sync), der
//     eingebaute Planer allowGridDischarge = false.
//
// Persistenz: <DATA_DIR>/battery_grid_share.json (atomar, je Minute und bei
// jedem Sperrwechsel). Protokoll als Nachweis für die Direktvermarktung:
// <DATA_DIR>/battery_grid_share_log.jsonl — Sperrwechsel und eine Tageszeile je
// Kalendertag (Ortszeit), als CSV über /api/battery/grid-share/protocol.csv.

import fs from 'node:fs';
import path from 'node:path';

import { isGridStorageOnly, isGridChargeLicensed } from './grid-storage.js';

/** Ab mehr als 100 Wh Netzstrom im Akku ist die Akku-Einspeisung gesperrt. */
export const GRID_SHARE_LOCK_THRESHOLD_WH = 100;
/** Sicherheitsabstand zum Live-PV-Überschuss, damit die Regelung nicht aus dem Akku nachschiebt. */
export const GRID_SHARE_EXPORT_MARGIN_W = 100;
/** Längste Lücke zwischen zwei Messungen, die noch gezählt wird. */
export const GRID_SHARE_MAX_STEP_MS = 60_000;
export const GRID_SHARE_STATE_FILE = 'battery_grid_share.json';
export const GRID_SHARE_PROTOCOL_FILE = 'battery_grid_share_log.jsonl';

const PERSIST_INTERVAL_MS = 60_000;
const READ_ONLY_REFRESH_MS = 5_000;
const PROTOCOL_MAX_LINES = 5_000;

/** Gilt die Sperre für diese Anlage? PV-Anlage ohne MiSpeL-Option. */
export function gridShareLockApplies(cfg) {
  if (isGridStorageOnly(cfg)) return false;
  const mode = cfg?.optimizer?.mispel?.mode;
  return mode !== 'pauschal' && mode !== 'abgrenzung';
}

const pos = (v) => {
  const n = Number(v);
  return v != null && Number.isFinite(n) && n > 0 ? n : 0;
};
const finiteOrNull = (v) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * Ein Zählschritt (rein, ohne Zustand).
 * @param {number} gridWh Netzstrom im Akku vor dem Schritt
 * @param {{dtMs:number, gridToBatteryW?:number, batteryToHomeW?:number, batteryToGridW?:number,
 *          socPct?:number|null, capacityWh?:number|null}} p
 * @returns {{gridWh:number, inWh:number, toHomeWh:number, toGridWh:number, lossWh:number, share:number, storedWh:number|null}}
 */
export function stepGridShare(gridWh, { dtMs, gridToBatteryW, batteryToHomeW, batteryToGridW, socPct, capacityWh } = {}) {
  const h = Math.max(0, Number(dtMs) || 0) / 3_600_000;
  const soc = finiteOrNull(socPct);
  const cap = finiteOrNull(capacityWh);
  const known = soc != null && cap != null && cap > 0;
  const storedWh = known ? Math.max(0, Math.min(100, soc)) / 100 * cap : null;
  const upperWh = known ? Math.min(100, Math.max(0, soc) + 1) / 100 * cap : null;
  let g = Math.max(0, Number(gridWh) || 0);
  // Anteil zu Beginn des Schritts. Ohne Ladestand nimmt Entladen nichts weg —
  // der Zähler bleibt dann eher zu hoch als zu niedrig (Sperre im Zweifel an).
  const shareBefore = !known ? 0 : (g <= 0 ? 0 : (storedWh > 0 ? Math.min(1, g / storedWh) : 1));
  const inWh = pos(gridToBatteryW) * h;
  const toHomeWh = Math.min(g, shareBefore * pos(batteryToHomeW) * h);
  const toGridWh = Math.min(g - toHomeWh, shareBefore * pos(batteryToGridW) * h);
  g = g - toHomeWh - toGridWh + inWh;
  let lossWh = 0;
  if (upperWh != null && g > upperWh) {
    lossWh = g - upperWh;
    g = upperWh;
  }
  const share = !known ? null : (g <= 0 ? 0 : (storedWh > 0 ? Math.min(1, g / storedWh) : 1));
  return { gridWh: g, inWh, toHomeWh, toGridWh, lossWh, share, storedWh };
}

/**
 * Höchste erlaubte Einspeisung (W, ≥ 0) während der Sperre: Live-PV-Überschuss
 * minus Sicherheitsabstand, mindestens der Standard-Puffer. Unbekannte PV oder
 * Last → nur der Puffer.
 */
export function gridShareExportCapW({ pvW, loadW, bufferW = 0, marginW = GRID_SHARE_EXPORT_MARGIN_W } = {}) {
  const buffer = Math.max(0, Math.abs(Number(bufferW) || 0));
  const pv = finiteOrNull(pvW);
  const load = finiteOrNull(loadW);
  if (pv == null || load == null) return Math.round(buffer);
  const surplus = Math.max(0, pv) - Math.max(0, load) - Math.max(0, Number(marginW) || 0);
  return Math.round(Math.max(buffer, surplus, 0));
}

function localDate(ms, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

const r3 = (v) => Math.round(Number(v) * 1000) / 1000;
const emptyDay = (date) => ({ date, inWh: 0, toHomeWh: 0, toGridWh: 0, lossWh: 0, lockedMs: 0, maxGridWh: 0 });

/**
 * @param {object} opts
 * @param {() => object} opts.getCfg
 * @param {(event:string, data?:object, level?:string) => void} [opts.pushLog]
 * @param {string} opts.dataDir Verzeichnis für Zustand und Protokoll
 * @param {(locked:boolean, summary:object) => void} [opts.onLockChange]
 * @param {boolean} [opts.readOnly] nur lesen (Web-Prozess neben dem Runtime-Worker)
 * @param {number} [opts.thresholdWh]
 */
export function createGridShareTracker({ getCfg, pushLog, dataDir, onLockChange, readOnly = false, thresholdWh = GRID_SHARE_LOCK_THRESHOLD_WH } = {}) {
  const statePath = dataDir ? path.join(dataDir, GRID_SHARE_STATE_FILE) : null;
  const protocolPath = dataDir ? path.join(dataDir, GRID_SHARE_PROTOCOL_FILE) : null;
  const log = (event, data, level) => { try { pushLog?.(event, data, level); } catch { /* nie werfen */ } };
  const cfgNow = () => { try { return getCfg?.() || {}; } catch { return {}; } };

  let st = null;
  let lastTickMs = null;
  let lastPersistMs = 0;
  let dirty = false;
  let lastReadMs = 0;
  let live = { toHomeW: 0, toGridW: 0 };

  function fresh() {
    return {
      version: 1,
      gridWh: 0,
      locked: false,
      since: new Date().toISOString(),
      updatedAt: null,
      storedWh: null,
      share: null,
      day: emptyDay(null),
      totals: { inWh: 0, toHomeWh: 0, toGridWh: 0, lossWh: 0 },
      lockChangedAt: null,
    };
  }

  function load() {
    if (!statePath) return fresh();
    try {
      const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (!raw || typeof raw !== 'object' || !Number.isFinite(Number(raw.gridWh))) return fresh();
      const base = fresh();
      return {
        ...base,
        ...raw,
        gridWh: Math.max(0, Number(raw.gridWh)),
        day: { ...base.day, ...(raw.day || {}) },
        totals: { ...base.totals, ...(raw.totals || {}) },
      };
    } catch {
      return fresh();
    }
  }

  function persist(nowMs = Date.now()) {
    if (readOnly || !statePath) return true;
    try {
      const tmp = statePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(st) + '\n');
      fs.renameSync(tmp, statePath);
      lastPersistMs = nowMs;
      dirty = false;
      return true;
    } catch (e) {
      log('grid_share_persist_error', { error: e?.message || String(e) }, 'warn');
      return false;
    }
  }

  function appendProtocol(entry) {
    if (readOnly || !protocolPath) return;
    try {
      fs.appendFileSync(protocolPath, JSON.stringify(entry) + '\n');
    } catch (e) {
      log('grid_share_protocol_error', { error: e?.message || String(e) }, 'warn');
    }
  }

  function readProtocol(limit = 500) {
    if (!protocolPath) return [];
    let text;
    try { text = fs.readFileSync(protocolPath, 'utf8'); } catch { return []; }
    const lines = text.split('\n').filter(Boolean);
    const out = [];
    for (const l of lines.slice(-Math.min(PROTOCOL_MAX_LINES, Math.max(1, limit)))) {
      try { out.push(JSON.parse(l)); } catch { /* kaputte Zeile überspringen */ }
    }
    return out;
  }

  function ensureLoaded(nowMs = Date.now()) {
    if (!st) { st = load(); lastReadMs = nowMs; return; }
    if (readOnly && nowMs - lastReadMs > READ_ONLY_REFRESH_MS) { st = load(); lastReadMs = nowMs; }
  }

  function lockFor(cfg) {
    return gridShareLockApplies(cfg) && st.gridWh > thresholdWh;
  }

  function closeDay(nowMs, cfg) {
    const d = st.day;
    if (d?.date) {
      appendProtocol({
        ts: new Date(nowMs).toISOString(),
        event: 'day',
        date: d.date,
        gridToBatteryKwh: r3(d.inWh / 1000),
        batteryToHomeFromGridKwh: r3(d.toHomeWh / 1000),
        batteryToGridFromGridKwh: r3(d.toGridWh / 1000),
        lossFromGridKwh: r3(d.lossWh / 1000),
        maxGridKwh: r3(d.maxGridWh / 1000),
        endGridKwh: r3(st.gridWh / 1000),
        endSharePct: st.share == null ? null : Math.round(st.share * 1000) / 10,
        lockedMinutes: Math.round(d.lockedMs / 60_000),
        lockApplies: gridShareLockApplies(cfg),
      });
    }
  }

  /**
   * Ein Messwert (jede Abfrage). Gibt die Live-Werte für Telemetrie und Status zurück.
   * @param {{nowMs?:number, victron?:object, socPct?:number|null, capacityWh?:number|null}} p
   */
  function tick({ nowMs = Date.now(), victron = {}, socPct = null, capacityWh = null } = {}) {
    ensureLoaded(nowMs);
    if (readOnly) return summaryLive();
    const cfg = cfgNow();
    const tz = cfg?.schedule?.timezone || 'Europe/Berlin';
    const today = localDate(nowMs, tz);
    if (st.day?.date !== today) {
      if (st.day?.date) closeDay(nowMs, cfg);
      st.day = emptyDay(today);
      dirty = true;
    }
    const dtMs = lastTickMs == null ? 0 : Math.min(GRID_SHARE_MAX_STEP_MS, Math.max(0, nowMs - lastTickMs));
    lastTickMs = nowMs;
    const v = victron || {};
    const flows = {
      gridToBatteryW: pos(v.gridToBatteryW) + pos(v.secondGridToBatteryW),
      batteryToHomeW: pos(v.batteryDirectUseW) + pos(v.secondBatteryDirectUseW),
      batteryToGridW: pos(v.batteryToGridW) + pos(v.secondBatteryToGridW),
    };
    const r = stepGridShare(st.gridWh, { dtMs, ...flows, socPct, capacityWh });
    st.gridWh = r.gridWh;
    if (r.storedWh != null) { st.storedWh = r.storedWh; st.share = r.share; }
    else if (st.storedWh > 0) st.share = Math.min(1, st.gridWh / st.storedWh);
    for (const k of ['inWh', 'toHomeWh', 'toGridWh', 'lossWh']) {
      st.day[k] += r[k];
      st.totals[k] += r[k];
    }
    st.day.maxGridWh = Math.max(st.day.maxGridWh || 0, st.gridWh);
    if (st.locked) st.day.lockedMs += dtMs;
    if (r.inWh || r.toHomeWh || r.toGridWh || r.lossWh) dirty = true;
    st.updatedAt = new Date(nowMs).toISOString();

    // Live-Leistung aus Netzstrom (für Telemetrie und Leitstand).
    const shareNow = st.share ?? 0;
    live = { toHomeW: Math.round(shareNow * flows.batteryToHomeW), toGridW: Math.round(shareNow * flows.batteryToGridW) };

    const locked = lockFor(cfg);
    if (locked !== st.locked) {
      st.locked = locked;
      st.lockChangedAt = st.updatedAt;
      const entry = {
        ts: st.updatedAt,
        event: locked ? 'lock_on' : 'lock_off',
        gridKwh: r3(st.gridWh / 1000),
        sharePct: st.share == null ? null : Math.round(st.share * 1000) / 10,
        thresholdKwh: r3(thresholdWh / 1000),
      };
      appendProtocol(entry);
      log('grid_share_lock', { locked, gridKwh: entry.gridKwh, sharePct: entry.sharePct });
      persist(nowMs);
      try { onLockChange?.(locked, summary(nowMs)); } catch (e) { log('grid_share_lock_hook_error', { error: e?.message || String(e) }, 'warn'); }
    } else if (dirty && nowMs - lastPersistMs >= PERSIST_INTERVAL_MS) {
      persist(nowMs);
    }
    return summaryLive();
  }

  function summaryLive() {
    return {
      gridWh: st.gridWh,
      sharePct: st.share == null ? null : Math.round(st.share * 1000) / 10,
      toHomeW: live.toHomeW,
      toGridW: live.toGridW,
      locked: st.locked,
    };
  }

  function isLocked() {
    ensureLoaded();
    // Die Einstellung kann sich ändern, ohne dass ein Messwert kommt.
    return lockFor(cfgNow());
  }

  function summary(nowMs = Date.now()) {
    ensureLoaded(nowMs);
    const cfg = cfgNow();
    const kwh = (wh) => r3((Number(wh) || 0) / 1000);
    return {
      gridWh: st.gridWh,
      gridKwh: kwh(st.gridWh),
      sharePct: st.share == null ? null : Math.round(st.share * 1000) / 10,
      storedKwh: st.storedWh == null ? null : kwh(st.storedWh),
      locked: lockFor(cfg),
      applies: gridShareLockApplies(cfg),
      gridChargeEnabled: isGridChargeLicensed(cfg),
      thresholdKwh: kwh(thresholdWh),
      toHomeW: live.toHomeW,
      toGridW: live.toGridW,
      today: {
        date: st.day?.date ?? null,
        gridToBatteryKwh: kwh(st.day?.inWh),
        batteryToHomeFromGridKwh: kwh(st.day?.toHomeWh), batteryToGridFromGridKwh: kwh(st.day?.toGridWh),
        lossFromGridKwh: kwh(st.day?.lossWh), lockedMinutes: Math.round((st.day?.lockedMs || 0) / 60_000),
      },
      totals: {
        gridToBatteryKwh: kwh(st.totals.inWh), batteryToHomeFromGridKwh: kwh(st.totals.toHomeWh),
        batteryToGridFromGridKwh: kwh(st.totals.toGridWh), lossFromGridKwh: kwh(st.totals.lossWh),
      },
      since: st.since,
      updatedAt: st.updatedAt,
      lockChangedAt: st.lockChangedAt,
    };
  }

  const CSV_COLUMNS = [
    ['ts', 'Zeit'], ['event', 'Ereignis'], ['date', 'Datum'],
    ['gridToBatteryKwh', 'Netz→Akku kWh'], ['batteryToHomeFromGridKwh', 'Akku→Haus aus Netzstrom kWh'],
    ['batteryToGridFromGridKwh', 'Akku→Netz aus Netzstrom kWh'], ['lossFromGridKwh', 'Verlust Netzstrom kWh'],
    ['maxGridKwh', 'Netzstrom max kWh'], ['endGridKwh', 'Netzstrom Tagesende kWh'], ['endSharePct', 'Anteil Tagesende %'],
    ['lockedMinutes', 'Sperre min'], ['gridKwh', 'Netzstrom kWh'], ['sharePct', 'Anteil %'], ['thresholdKwh', 'Schwelle kWh'],
  ];
  function protocolCsv() {
    const cell = (v) => {
      if (v == null) return '';
      if (typeof v === 'number') return String(v).replace('.', ',');
      const s = String(v);
      return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = readProtocol(PROTOCOL_MAX_LINES).map((e) => CSV_COLUMNS.map(([k]) => cell(e[k])).join(';'));
    return [CSV_COLUMNS.map(([, label]) => label).join(';'), ...rows].join('\n') + '\n';
  }

  ensureLoaded();
  return {
    tick,
    isLocked,
    summary,
    persist: () => persist(Date.now()),
    protocol: readProtocol,
    protocolCsv,
  };
}
