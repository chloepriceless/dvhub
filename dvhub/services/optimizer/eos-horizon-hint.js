// services/optimizer/eos-horizon-hint.js — Hinweis „mit der Preisprognose bis
// zu ~5 Tage vorausplanen“ (DVhub 1.0.11, Christin 12.11.2026).
//
// Die Standards bleiben (Prognosehorizont automatisch 72 h, Steuerzeitraum =
// bekannter Preiszeitraum), gerade für schwache Geräte. Der Hinweis sagt nur,
// was mit der Preisprognose ginge und was ein Lauf dann auf GENAU DIESEM Gerät
// etwa dauert. Umgestellt wird nichts.
//
// Laufzeit: eos-run-trigger.js misst jeden Lauf, den DVhub anstößt (Dauer und
// Steuerzeitraum, state.optimizer.eosRun.secPerControlHour über die letzten
// Läufe). Die Rechenzeit wächst etwa linear mit dem Steuerzeitraum (Rust-Kern,
// eos-bench/preisschwanz 12.11.2026: 30 h 0,40 s, 72 h 0,89 s, 120 h 1,54 s,
// d. h. 13,3 / 12,4 / 12,8 ms je Stunde); der Schwanz kostet fast nichts.
// Deshalb: Sekunden je Stunde Steuerzeitraum × Ziel-Stunden.
//
// Gezeigt nur, wenn EOS eingeschaltet ist, die Preisprognose an und die Preiszone DE-LU
// (outlookDisabledReason), DVhub die Läufe anstößt (sonst gibt es weder
// Schwanz noch Messung) und der Steuerzeitraum nicht schon „bis in die
// Preisprognose“ steht.

import { outlookDisabledReason } from './price-outlook.js';
import { dvhubTriggersEosRuns } from './eos-run-trigger.js';
import { eosRemoteActive } from './eos-remote.js';
import { EOS_SLOW_RUN_HINT_S } from './eos-run-hint.js';
import { resolveControlHorizonMaxHours, CONTROL_HORIZON_FORECAST } from './eos-forecast-bridge.js';

/** So weit plant EOS „bis in die Preisprognose“ höchstens (eos-forecast-bridge CONTROL_HORIZON_FORECAST_MAX_H). */
export const HORIZON_HINT_MAX_H = 120;
/** Erst ab so vielen gemessenen Läufen eine Schätzung (ein einzelner Warmlauf zählt nicht). */
export const HORIZON_HINT_MIN_RUNS = 3;
/** Bringt die Vorausschau weniger als so viele Stunden mehr, gibt es keinen Hinweis. */
export const HORIZON_HINT_MIN_GAIN_H = 12;

const HOUR_MS = 3_600_000;

function fmtSeconds(s) {
  if (!Number.isFinite(s)) return '—';
  if (s < 10) return `${String(Math.round(s * 10) / 10).replace('.', ',')} s`;
  if (s < 120) return `${Math.round(s)} s`;
  return `${Math.round(s / 60)} min`;
}

/**
 * @param {object} p
 * @param {object} p.cfg
 * @param {object|null} p.run           state.optimizer.eosRun
 * @param {number|null} p.outlookEndMs  Ende der lückenlosen Preisprognose hinter den festen Preisen (null = keine)
 * @param {number|null} [p.pvUntilMs]   Ende der PV-Prognose beim letzten Push (null = unbekannt)
 * @param {string} [p.controlMode]      'full' | 'cap' | 'auto' | 'forecast'
 * @param {number|null} [p.controlHours] zuletzt an EOS gesendeter Steuerzeitraum (h)
 * @param {number} [p.nowMs]
 * @returns {null|{text:string, targetHours:number, currentHours:number|null,
 *   estimateS:number|null, currentS:number|null, measuredRuns:number, slow:boolean, limitedByPv:boolean}}
 */
export function eosHorizonHint({ cfg, run = null, outlookEndMs = null, pvUntilMs = null, controlMode = 'full', controlHours = null, nowMs = Date.now() } = {}) {
  // Ohne eingeschaltetes EOS gibt es nichts vorauszuplanen.
  if (!cfg?.optimizer?.eosProxy?.enabled) return null;
  if (outlookDisabledReason(cfg) !== null) return null;
  if (eosRemoteActive(cfg) || !dvhubTriggersEosRuns(cfg)) return null;
  if (controlMode === 'forecast') return null;
  if (!Number.isFinite(outlookEndMs) || outlookEndMs <= nowMs) return null;
  // So weit käme EOS Slot für Slot: Preisprognose und PV-Prognose (die Last
  // verlängert DVhub mit), höchstens 120 h.
  const pvEnd = Number.isFinite(pvUntilMs) && pvUntilMs > nowMs ? pvUntilMs : null;
  const endMs = pvEnd !== null ? Math.min(outlookEndMs, pvEnd) : outlookEndMs;
  // Grenze aus den Einstellungen, als stünde der Steuerzeitraum schon auf „bis
  // in die Preisprognose“: ein fest eingestellter Prognosehorizont (z. B.
  // 48 h) begrenzt ihn weiter auf Prognosehorizont − 12 h (Codex b1afb66c).
  const prospective = { ...cfg, optimizer: { ...(cfg?.optimizer || {}), eosControlHorizonMaxHours: CONTROL_HORIZON_FORECAST } };
  const cfgMaxH = Math.min(HORIZON_HINT_MAX_H, resolveControlHorizonMaxHours(prospective));
  const targetHours = Math.min(cfgMaxH, Math.floor((endMs - nowMs) / HOUR_MS));
  const n = Number(run?.recentRuns);
  const secPerH = Number(run?.secPerControlHour);
  const curH = Number(run?.avgControlHours);
  const measured = n >= HORIZON_HINT_MIN_RUNS && secPerH > 0 && curH > 0;
  const sentH = Number(controlHours);
  const currentHours = curH > 0 ? Math.round(curH) : (sentH > 0 ? Math.round(sentH) : null);
  // Bringt es nichts (PV-Prognose kurz, Steuerzeitraum schon so lang), schweigen.
  // Unbekannter Steuerzeitraum: der übliche ganze Preiszeitraum (~34 h).
  if (targetHours < (currentHours ?? 34) + HORIZON_HINT_MIN_GAIN_H) return null;
  const limitedByPv = pvEnd !== null && pvEnd < outlookEndMs && targetHours < cfgMaxH;
  const limitedByPrediction = !limitedByPv && cfgMaxH < HORIZON_HINT_MAX_H && targetHours === cfgMaxH;
  const days = Math.round(targetHours / 24 * 2) / 2;
  const daysText = String(days).replace('.', ',');
  let text = `Mit der Preisprognose kann EOS bis zu ${daysText} Tage (${targetHours} h) vorausplanen`
    + (limitedByPv ? ' — so weit reicht hier die PV-Prognose' : '')
    + (limitedByPrediction ? ' — mehr lässt der eingestellte Prognosehorizont nicht zu (12 h bleiben Schwanz)' : '')
    + ': Steuerzeitraum „Bis in die Preisprognose“ (Einstellungen → EOS-Optimierung).';
  let estimateS = null;
  let currentS = null;
  let slow = false;
  if (measured) {
    estimateS = secPerH * targetHours;
    // „statt …“: die gemessene mittlere Dauer (alle Läufe), sonst aus der Rate.
    const avg = Number(run?.avgDurationS);
    currentS = avg > 0 ? avg : secPerH * curH;
    slow = estimateS >= EOS_SLOW_RUN_HINT_S;
    text += ` Ein Lauf dauert dann auf diesem Gerät geschätzt ${fmtSeconds(estimateS)} statt ${fmtSeconds(currentS)}`
      + ` (gemessen über ${n} Läufe bei im Mittel ${Math.round(curH)} h Steuerzeitraum, linear hochgerechnet).`;
    if (slow) text += ' Das ist für dieses Gerät zu lang — besser beim Standard bleiben.';
  } else {
    text += ' Die Rechenzeit wächst etwa im selben Verhältnis wie der Steuerzeitraum (120 h ≈ 4× 30 h);'
      + ' sobald einige Läufe gemessen sind, schätzt DVhub sie hier für dieses Gerät.';
  }
  text += ' Ein längerer Prognosehorizont allein (96–144 h) kostet kaum Rechenzeit, plant die Tage aber nicht Slot für Slot.'
    + ' Umgesetzt wird nur, was auf festen Börsenpreisen liegt. DVhub stellt nichts von selbst um.';
  return { text, targetHours, currentHours, estimateS: estimateS === null ? null : Math.round(estimateS * 10) / 10, currentS: currentS === null ? null : Math.round(currentS * 10) / 10, measuredRuns: Number.isFinite(n) ? n : 0, slow, limitedByPv };
}
