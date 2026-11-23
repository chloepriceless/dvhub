// services/peak-shaving/builtin.js — eingebaute Peak-Shaving-Funktion des Wechselrichters (Christin 24.11.2026, P5).
//
// Manche Hybrid-Wechselrichter können den Netzbezug selbst kappen (Deye „Grid peak shaving“, GoodWe Peak Shaving,
// Growatt Import-Limit, Solis/Sofar/SolaX Betriebsart „Peak Shaving“). Die Register stehen im Herstellerprofil im
// Block `peakShavingBuiltin` — mit Quelle und Kennzeichnung „ungetestet“: am Gerät hat das niemand geprüft (Christin:
// Feldtest nicht für jeden möglich, aber in jedem Profil drin). Auch reine Lese-Profile tragen NUR diese Punkte.
//
// Regeln:
//   - Nur mit aktivem Peak Shaving UND Schalter „Eingebaute Peak-Shaving-Funktion nutzen“ (peakShaving.builtin.enabled,
//     ab Werk aus) und nur, wenn das Profil keinen eigenen Akku-Hebel hat (resolvePeakShaving lever 'builtin').
//   - Jeder Write geht über das Schreibtor (services/gate, eigenes Gerät `ps-builtin`, Legacy-Lauf): Not-Halt, Lese-
//     Modus, ungültige Config und Geräte-Erkennung (identify) sperren wie überall. Im Not-Halt schreibt dieser Pfad
//     NICHTS — auch keine Rücknahme (die gibt es erst danach, wenn Peak Shaving dann aus ist).
//   - Vor dem ersten Write wird der Ist-Wert von Grenze/Betriebsart gelesen und auf der Platte gesichert; ohne
//     erfolgreiche Lesung kein Write (sonst gäbe es keine Rücknahme). Ist Peak Shaving bzw. der Schalter wieder aus,
//     schreibt DVhub genau diesen gesicherten Wert einmal zurück.
//   - Reserve-SoC (GoodWe 47544, Growatt 3310) nur, wenn ein Wert eingetragen ist, und NIE zurück (H-8).
//   - Die Register liegen meist im Flash/EEPROM: geschrieben wird nur bei Abweichung, höchstens alle 15 min je Punkt,
//     eine geänderte Grenze erst ab 500 W Unterschied.
//   - Nie andere Register: geschrieben werden ausschließlich die Adressen aus `peakShavingBuiltin`.

import fs from 'node:fs';
import { modbusLegacySink, inverterReleaseState, unwrapLegacyWrite } from '../gate/legacy.js';
import { atomicWriteControlState } from '../../control-state-io.js';
import { monoNow as defaultMonoNow } from '../mono-clock.js';
import { resolvePeakShaving, builtinSpecValid } from './index.js';

export const BUILTIN_GATE_DEVICE = 'ps-builtin';
export const BUILTIN_MIN_WRITE_INTERVAL_MS = 15 * 60_000;
export const BUILTIN_LIMIT_STEP_W = 500;

const RESOURCE = 'peakShavingBuiltin';

/** Tor-Richtlinien der drei möglichen Punkte. Grenze/Betriebsart einmal zurück, Reserve-SoC nie (H-8). */
export function builtinGatePolicies() {
  const base = { class: 'battery_grid', resource: RESOURCE, sink: BUILTIN_GATE_DEVICE, targetKind: 'modbus' };
  return {
    psLimit: { ...base, unit: 'W', neutral: { kind: 'restoreBefore' } },
    psMode: { ...base, neutral: { kind: 'restoreBefore' } },
    psReserveSoc: { ...base, unit: '%', neutral: { kind: 'never' } }
  };
}

const int = (v) => (Number.isInteger(Number(v)) ? Number(v) : null);

/** Rohwörter für eine Grenze in W nach Profilpunkt (uint16 bzw. uint32 mit Wortreihenfolge). */
export function encodeLimit(spec, watts) {
  const scale = Number(spec.scale) > 0 ? Number(spec.scale) : 1;
  const max = spec.writeType === 'uint32' ? 0xffffffff : 0xffff;
  const raw = Math.max(0, Math.min(Number(spec.max ?? max), max, Math.round(Number(watts) / scale)));
  if (spec.writeType === 'uint32') {
    const hi = Math.floor(raw / 0x10000) & 0xffff;
    const lo = raw & 0xffff;
    return { raw, words: spec.wordOrder === 'le' ? [lo, hi] : [hi, lo] };
  }
  return { raw, words: [raw] };
}

export function decodeWords(spec, words) {
  if (!Array.isArray(words) || !words.length) return null;
  const w = words.map((x) => Number(x) & 0xffff);
  if (spec.writeType === 'uint32') {
    if (w.length < 2) return null;
    const [a, b] = spec.wordOrder === 'le' ? [w[1], w[0]] : [w[0], w[1]];
    return a * 0x10000 + b;
  }
  return w[0];
}

function quantity(spec) { return spec.writeType === 'uint32' ? 2 : 1; }

/** Betriebsart: fester Wert (`value`) oder Bits setzen (`setBits`, Lesen-Ändern-Schreiben). */
export function desiredMode(spec, currentRaw) {
  if (Number.isInteger(Number(spec.value))) return Number(spec.value) & 0xffff;
  if (Number.isInteger(Number(spec.setBits)) && Number.isInteger(Number(currentRaw))) return (Number(currentRaw) | Number(spec.setBits)) & 0xffff;
  return null;
}

/**
 * @param {object} deps
 * @param {object} deps.state
 * @param {() => object} deps.getCfg
 * @param {object} deps.transport     Modbus-Transport (mbRequest, mbWriteSingle, mbWriteMultiple)
 * @param {object} deps.gate          Schreibtor (createGate/createLegacyGate)
 * @param {(cfg:object) => string|null} [deps.deviceWriteGate]  Bestandsprüfung (C2, identify); null = frei
 * @param {(cfg:object) => number|null} [deps.targetW]  wirksames Regelziel (an die Spitze angepasst), sonst Einstellung
 * @param {string|null} [deps.statePath]  Sicherung der Ist-Werte
 */
export function createBuiltinPeakShaving({
  state, getCfg, transport, gate, pushLog = () => {}, deviceWriteGate = () => null, targetW = null,
  statePath = null, monoNow = defaultMonoNow
}) {
  let saved = null;      // { limitRaw, modeRaw, at } — Ist-Werte vor DVhub
  let last = { limit: null, mode: null, reserve: null };   // zuletzt geschriebene Rohwerte
  let lastAt = { limit: -Infinity, mode: -Infinity, reserve: -Infinity };
  let logKey = null;
  let runSeq = 0;
  let busy = false;

  if (statePath) {
    try {
      const s = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (s && typeof s === 'object') saved = { limitRaw: int(s.limitRaw), modeRaw: int(s.modeRaw), at: Number(s.at) || null };
    } catch { /* keine Sicherung */ }
  }
  function persist() {
    if (!statePath) return;
    try {
      if (saved) atomicWriteControlState(statePath, saved);
      else fs.rmSync(statePath, { force: true });
    } catch (e) { pushLog('peak_shaving_builtin_persist_error', { error: e?.message || String(e) }, 'warn'); }
  }
  function log(key, event, data, level = 'info') {
    if (key === logKey) return;
    logKey = key;
    pushLog(event, data, level);
  }
  function publish(info) {
    if (info == null && !state.ctrl?._peakShaving?.builtin) return;   // aus: Zustand unberührt lassen
    if (!state.ctrl) state.ctrl = {};
    (state.ctrl._peakShaving ??= {}).builtin = info;
  }

  let sinkAttached = false;
  function conn(cfg) {
    const v = cfg?.victron || {};
    return { host: v.host, port: v.port, unitId: v.unitId, timeoutMs: v.timeoutMs };
  }
  async function read(cfg, spec) {
    const address = Number.isInteger(Number(spec.readAddress)) ? Number(spec.readAddress) : Number(spec.address);
    const regs = await transport.mbRequest({ fc: Number(spec.readFc) === 4 ? 4 : 3, ...conn(cfg), address, quantity: quantity(spec) });
    const v = decodeWords(spec, regs);
    if (v == null || !Number.isFinite(v)) throw new Error(`Register ${spec.address}: keine gültige Antwort`);
    return v;
  }
  async function write(cfg, point, spec, raw, { restore = false } = {}) {
    if (!sinkAttached) {
      gate.attachSink(BUILTIN_GATE_DEVICE, modbusLegacySink(transport));
      gate.setDevicePolicies(BUILTIN_GATE_DEVICE, builtinGatePolicies());
      sinkAttached = true;
    }
    gate.setRelease(BUILTIN_GATE_DEVICE, inverterReleaseState(cfg));
    runSeq += 1;
    const token = gate.admitLegacyRun(BUILTIN_GATE_DEVICE, { inHalt: null });
    const words = point === 'psLimit' ? encodeLimit(spec, raw * (Number(spec.scale) > 0 ? Number(spec.scale) : 1)).words : [Number(raw) & 0xffff];
    const multi = words.length > 1 || Number(spec.fc) === 16;
    const args = multi
      ? { ...conn(cfg), address: Number(spec.address), values: words, timeoutMs: conn(cfg).timeoutMs }
      : { ...conn(cfg), address: Number(spec.address), value: words[0], timeoutMs: conn(cfg).timeoutMs };
    const op = {
      device: BUILTIN_GATE_DEVICE, point, value: Number(raw), source: restore ? 'peak_shaving_builtin_restore' : 'peak_shaving_builtin',
      kind: restore ? 'restore' : 'write', action: restore ? 'autoRestore' : 'command',
      lease: null, constraints: { set: {}, caps: {}, enforcedBy: [] }, validUntilMs: null,
      tick: { loop: 'eval', seq: runSeq }, step: 0,
      legacy: { sink: BUILTIN_GATE_DEVICE, fn: multi ? 'mbWriteMultiple' : 'mbWriteSingle', args: [args] }
    };
    return unwrapLegacyWrite(await gate.submit(op, { run: token }), op);
  }

  async function restoreSaved(cfg, spec) {
    // Nur zurück, was DVhub selbst gesetzt hat; Reserve-SoC nie (H-8).
    // Eine Sicherung gibt es nur, wenn DVhub danach schreiben wollte — auch nach einem Neustart zurück.
    if (spec?.limit && saved.limitRaw != null) await write(cfg, 'psLimit', spec.limit, saved.limitRaw, { restore: true });
    if (spec?.mode && saved.modeRaw != null) await write(cfg, 'psMode', spec.mode, saved.modeRaw, { restore: true });
    pushLog('peak_shaving_builtin_restored', { limitRaw: saved.limitRaw, modeRaw: saved.modeRaw, text: 'Peak Shaving: eingebaute Funktion des Wechselrichters zurückgenommen (Wert vor DVhub).' });
    saved = null;
    last = { limit: null, mode: null, reserve: null };
    persist();
  }

  async function tickInner() {
    const cfg = getCfg() || {};
    const spec = cfg.peakShavingBuiltin;
    const r = resolvePeakShaving(cfg);
    const want = r.active && r.lever === 'builtin' && builtinSpecValid(spec);
    if (!want && !saved) { publish(null); logKey = null; return; }
    if (state.ctrl?.discretionaryWritesPaused === true) {
      publish({ active: false, reason: 'emergency_stop', status: 'ungetestet' });
      return log('halt', 'peak_shaving_builtin_paused', { text: 'Not-Halt: die eingebaute Peak-Shaving-Funktion wird nicht angefasst.' }, 'warn');
    }
    const blocked = deviceWriteGate(cfg);
    if (blocked) {
      publish({ active: false, reason: blocked, status: 'ungetestet' });
      return log(`blocked|${blocked}`, 'peak_shaving_builtin_blocked', { reason: blocked }, 'warn');
    }
    if (!want) {
      if (saved) await restoreSaved(cfg, spec);
      publish(null);
      logKey = null;
      return;
    }
    const t = monoNow();
    // Ist-Werte sichern (einmal), sonst kein Write.
    if (!saved) {
      const s = { limitRaw: null, modeRaw: null, at: Date.now() };
      if (spec.limit) s.limitRaw = await read(cfg, spec.limit);
      if (spec.mode) s.modeRaw = await read(cfg, spec.mode);
      saved = s;
      persist();
      pushLog('peak_shaving_builtin_saved', { ...s, text: 'Peak Shaving: Ist-Werte der eingebauten Funktion gesichert (für die Rücknahme).' });
    }
    const target = Number(typeof targetW === 'function' ? targetW(cfg) : r.targetW);
    const info = { active: true, status: 'ungetestet', targetW: target, wrote: [] };
    if (spec.limit && Number.isFinite(target)) {
      const scale = Number(spec.limit.scale) > 0 ? Number(spec.limit.scale) : 1;
      const desired = encodeLimit(spec.limit, target).raw;
      const changedW = last.limit == null ? Infinity : Math.abs(desired - last.limit) * scale;
      if (desired !== last.limit && changedW >= BUILTIN_LIMIT_STEP_W && t - lastAt.limit >= BUILTIN_MIN_WRITE_INTERVAL_MS) {
        await write(cfg, 'psLimit', spec.limit, desired);
        last.limit = desired; lastAt.limit = t; info.wrote.push('limit');
        pushLog('peak_shaving_builtin_limit', { address: spec.limit.address, raw: desired, targetW: target, text: `Peak Shaving: eingebaute Bezugsgrenze des Wechselrichters auf ${(target / 1000).toFixed(1).replace('.', ',')} kW gesetzt (ungetestet).` });
      }
    }
    if (spec.mode) {
      const desired = desiredMode(spec.mode, saved.modeRaw);
      if (desired != null && desired !== last.mode && t - lastAt.mode >= BUILTIN_MIN_WRITE_INTERVAL_MS) {
        await write(cfg, 'psMode', spec.mode, desired);
        last.mode = desired; lastAt.mode = t; info.wrote.push('mode');
        pushLog('peak_shaving_builtin_mode', { address: spec.mode.address, raw: desired, text: 'Peak Shaving: Betriebsart des Wechselrichters auf „Peak Shaving“ gestellt (ungetestet).' });
      }
    }
    const reservePct = Number(cfg.peakShaving?.builtin?.reserveSocPct);
    if (spec.reserveSoc && cfg.peakShaving?.builtin?.reserveSocPct != null && cfg.peakShaving.builtin.reserveSocPct !== ''
        && Number.isFinite(reservePct) && reservePct >= 0 && reservePct <= 100) {
      const desired = Math.round(reservePct / (Number(spec.reserveSoc.scale) > 0 ? Number(spec.reserveSoc.scale) : 1));
      if (desired !== last.reserve && t - lastAt.reserve >= BUILTIN_MIN_WRITE_INTERVAL_MS) {
        await write(cfg, 'psReserveSoc', spec.reserveSoc, desired);
        last.reserve = desired; lastAt.reserve = t; info.wrote.push('reserveSoc');
      }
    }
    publish(info);
    logKey = null;
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      await tickInner();
    } catch (e) {
      publish({ active: false, reason: 'error', error: e?.message || String(e), status: 'ungetestet' });
      log(`err|${e?.message}`, 'peak_shaving_builtin_error', { error: e?.message || String(e) }, 'warn');
    } finally {
      busy = false;
    }
  }

  return { tick, _saved: () => saved, _last: () => last };
}
