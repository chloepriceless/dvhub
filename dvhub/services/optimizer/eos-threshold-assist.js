// services/optimizer/eos-threshold-assist.js — Schwellen-Peak-Shaving aus dem
// EOS-Plan (Gegenseite zu EOS-PR D, DVhub 1.0.10).
//
// EOS (unser Zweig, nicht Vanilla v0.4.0rc3) setzt an jede Akku-Instruktion
// `peak_shaving_threshold_w` = seine Netzbezugs-Grenze. Bedeutung: In Slots, in
// denen der Plan den Akku HÄLT (Entladen nicht freigegeben: IDLE, NON_EXPORT,
// GRID_SUPPORT_IMPORT), entlädt der Akku trotzdem max(0, Bezug − Schwelle);
// Netzladen wird bis zur Schwelle zurückgenommen. Freigegebene Slots bleiben,
// wie sie sind (der Akku deckt dort ohnehin die ganze Last).
//
// Wie DVhub den Akku hält: über einen POSITIVEN Netz-Sollwert (schedule-eval
// „Akku halten“, closedLoopHold: Netzbezug = Live-Last − PV − Puffer; Netzladen:
// geplanter Bezug). Nicht über 2704 = 0 und nicht über den ESS-Min-SoC. Darum
// wirkt die Schwelle als Decke dieses Sollwerts: ctx.batteryAssist.request({
// source: 'eos-threshold', maxImportW: Schwelle }) — die ESS-Regelung (Victron
// und jedes Profil mit schreibbarem Netz-Sollwert) hält den Bezug am Zähler auf
// der Decke und nimmt den Rest aus dem Akku. Victron-Register 2714/2715
// (AcInputLimit, AlwaysPeakShave) bleiben unberührt: 2714 ist zugleich die
// Grenzquelle des Netzanschluss-Wächters, und AlwaysPeakShave greift nur über
// dem ESS-Min-SoC — beides braucht dieser Weg nicht.
//
// Regeln:
//   - Nur EOS-Regeln, die den Akku halten oder aus dem Netz laden, und nur mit
//     Schwelle (eosThresholdForRule). Ohne Feld (Vanilla) → nichts.
//   - Nur Profile mit schreibbarem Netz-Sollwert (resolveBatteryLever) — ohne
//     ihn kann DVhub den Akku nicht halten, er macht dann Eigenverbrauch.
//   - Not-Halt: keine Hilfe, eine stehende Anforderung wird zurückgenommen
//     (nur im Speicher, kein Write).
//   - Netzanschluss-Wächter mit gleicher oder strengerer Grenze: keine eigene
//     Anforderung — der Wächter deckt den Bezug über seinem Ziel in JEDEM Slot
//     schon (keine Doppelarbeit). Die Plan-Schwelle ist sonst genau dieses Ziel
//     (eos-config-sync → eosGridImportLimitW).
//   - Die Anforderung gilt bis zum Slot-Ende (untilMs) und wird jeden Takt
//     erneuert; ohne Halte-Regel wird sie freigegeben.

import { resolveBatteryLever } from '../grid-connection/index.js';

export const EOS_THRESHOLD_SOURCE = 'eos-threshold';

/**
 * Schwelle (W) einer Zeitplan-Regel, wenn sie eine EOS-Regel ist, die den Akku
 * hält (closedLoopHold) oder aus dem Netz lädt (positiver Sollwert ohne
 * Verkauf) — sonst null.
 */
export function eosThresholdForRule(rule) {
  if (!rule || typeof rule !== 'object') return null;
  if (rule.source !== 'forecast_optimizer' || rule.optimizer !== 'eos') return null;
  if (rule.target != null && rule.target !== 'gridSetpointW') return null;
  if (rule.closedLoopExport === true) return null;
  const holds = rule.closedLoopHold === true || Number(rule.value) > 0;
  if (!holds) return null;
  const raw = rule.peakShavingThresholdW;
  if (raw === null || raw === undefined || raw === '' || typeof raw === 'boolean') return null;
  const w = Number(raw);
  return Number.isFinite(w) && w >= 0 ? Math.round(w) : null;
}

/**
 * @param {object} deps
 * @param {object} deps.state       DVhub-Zustand (state.ctrl.eosThreshold für Leitstand/Status)
 * @param {() => object} deps.getCfg
 * @param {() => object|null} deps.getAssist  ctx.batteryAssist (request/release/status)
 * @param {(event:string, data?:object, level?:string) => void} [deps.pushLog]
 * @param {() => number} [deps.now]
 */
export function createEosThresholdAssist({ state, getCfg, getAssist, pushLog = () => {}, now = Date.now }) {
  let held = false;      // eigene Anforderung steht (beim Wächter angemeldet)
  let logKey = null;

  function publish(info) {
    if (!state.ctrl) state.ctrl = {};
    state.ctrl.eosThreshold = info;
    const key = info ? `${info.thresholdW}|${info.requested}|${info.reason ?? ''}|${info.coveredBy ?? ''}` : null;
    if (key === logKey) return;
    logKey = key;
    if (!info) pushLog('eos_threshold_released', {});
    else pushLog('eos_threshold', {
      thresholdW: info.thresholdW, requested: info.requested, reason: info.reason ?? null, coveredBy: info.coveredBy ?? null,
      text: info.requested || info.coveredBy
        ? `EOS: Akku deckt über ${(info.thresholdW / 1000).toFixed(1).replace('.', ',')} kW${info.coveredBy ? ' (über den Netzanschluss-Wächter)' : ''}`
        : `EOS-Schwelle ${(info.thresholdW / 1000).toFixed(1).replace('.', ',')} kW nicht wirksam (${info.reason})`
    });
  }

  function drop(assist) {
    if (held && typeof assist?.release === 'function') assist.release(EOS_THRESHOLD_SOURCE);
    held = false;
  }

  /**
   * Je Steuertakt mit der gerade wirksamen gridSetpointW-Regel (oder null).
   * Muss VOR dem Schreiben des Sollwerts laufen, damit die Decke schon gilt.
   */
  function tick(rule) {
    const assist = getAssist?.() || null;
    const thresholdW = eosThresholdForRule(rule);
    if (thresholdW == null || typeof assist?.request !== 'function') {
      drop(assist);
      if (state.ctrl?.eosThreshold != null || logKey !== null) publish(null);
      return null;
    }
    const base = { thresholdW, ruleId: rule.id ?? null, at: now() };
    if (state.ctrl?.discretionaryWritesPaused === true) {
      drop(assist);
      publish({ ...base, requested: false, reason: 'emergency_stop' });
      return state.ctrl.eosThreshold;
    }
    const lever = resolveBatteryLever(getCfg?.() || {});
    if (lever.setpoint !== true) {
      drop(assist);
      publish({ ...base, requested: false, reason: 'battery_not_steerable' });
      return state.ctrl.eosThreshold;
    }
    // Wächter mit gleicher oder strengerer Grenze: er deckt den Bezug darüber
    // schon — keine zweite Anforderung derselben Grenze.
    const st = typeof assist.status === 'function' ? assist.status(EOS_THRESHOLD_SOURCE) : null;
    const gridTargetW = Number.isFinite(st?.gridTargetW) ? st.gridTargetW : null;
    if (gridTargetW != null && gridTargetW <= thresholdW) {
      drop(assist);
      publish({ ...base, requested: false, reason: null, coveredBy: 'grid-connection', gridTargetW });
      return state.ctrl.eosThreshold;
    }
    const end = Number(rule.slotEndTs);
    const untilMs = Number.isFinite(end) && end > now() ? end : undefined;
    const res = assist.request({ source: EOS_THRESHOLD_SOURCE, maxImportW: thresholdW, ...(untilMs ? { untilMs } : {}) }) || {};
    held = res.ok === true;
    publish({ ...base, requested: held, reason: held ? null : (res.reason || 'rejected'), untilMs: untilMs ?? null });
    return state.ctrl.eosThreshold;
  }

  return { tick };
}
