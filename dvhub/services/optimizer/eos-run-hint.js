// services/optimizer/eos-run-hint.js — Hinweis bei langen EOS-Läufen
// (DVhub 1.0.10, Christin 05.11.2026).
//
// „Ein Hinweis darf vorschlagen: Läufe dauern im Mittel über X min → 100 und
// ‚automatisch‘ empfohlen. Nichts automatisch umstellen.“ Die mittlere Dauer
// führt eos-run-trigger.js (state.optimizer.eosRun.avgDurationS über die
// letzten erfolgreichen Läufe); der Leitstand zeigt den Hinweis am
// EOS-Fahrplan (/api/eos/plan → runHint).
//
// Warum 10 min: Auf einem A55-Kern dauert ein Lauf mit ganzem Preiszeitraum
// und 200 Generationen im Mittel gut 3 min (eos-bench HORIZONT-MESSUNG.md);
// ein eHive mit Auto brauchte 15–40 min. Ab 10 min hinkt der Plan dem
// 15-Minuten-Takt deutlich hinterher — dort lohnt sich der Vorschlag.

import { pickGeneticSizing } from './eos-config-sync.js';
import { eosRemoteActive } from './eos-remote.js';

export const EOS_SLOW_RUN_HINT_S = 600;
/** Erst ab so vielen Läufen — ein einzelner langer (Neustart, Warmlauf) zählt nicht. */
export const EOS_SLOW_RUN_MIN_RUNS = 4;
export const EOS_SUGGESTED_GENERATIONS = 100;

/**
 * @param {{avgDurationS?:number, recentRuns?:number}|null} run  state.optimizer.eosRun
 * @param {object} cfg
 * @returns {null | {text:string, avgDurationS:number, recentRuns:number,
 *   suggest:{generations?:number, controlHorizon?:'auto'}}}
 */
export function eosSlowRunHint(run, cfg) {
  const avg = Number(run?.avgDurationS);
  const n = Number(run?.recentRuns);
  if (!(avg >= EOS_SLOW_RUN_HINT_S) || !(n >= EOS_SLOW_RUN_MIN_RUNS)) return null;
  // Fernbetrieb: die Dauer hängt am Rechendienst (und seiner Warteschlange).
  if (eosRemoteActive(cfg)) return null;
  const suggest = {};
  if (pickGeneticSizing(0, cfg?.optimizer?.eosGeneticGenerations).generations > EOS_SUGGESTED_GENERATIONS) {
    suggest.generations = EOS_SUGGESTED_GENERATIONS;
  }
  if (String(cfg?.optimizer?.eosControlHorizonMaxHours ?? '').trim().toLowerCase() !== 'auto') suggest.controlHorizon = 'auto';
  if (!Object.keys(suggest).length) return null;
  const parts = [];
  if (suggest.generations) parts.push(`${suggest.generations} Generationen`);
  if (suggest.controlHorizon) parts.push('Steuerzeitraum „automatisch“');
  const min = Math.round(avg / 60);
  // Messung (eos-bench): beides zusammen ≈ ¼ der Rechenzeit, auf 305 Tagen
  // gleichauf; 100 Generationen allein ≈ ½; „automatisch“ allein ≈ ⅔.
  let why = '— zusammen über ein Jahr gerechnet gleich gut bei etwa einem Viertel der Rechenzeit.';
  if (!suggest.controlHorizon) why = '— etwa die halbe Rechenzeit, ohne messbaren Verlust.';
  else if (!suggest.generations) why = '— spürbar kürzere Läufe, über ein Jahr gerechnet gleich gut.';
  const text = `EOS-Läufe dauern im Mittel ${min} min. Für diese Hardware empfohlen: ${parts.join(' und ')} `
    + `(Einstellungen → EOS-Optimierung) ${why} DVhub stellt nichts von selbst um.`;
  return { text, avgDurationS: Math.round(avg), recentRuns: n, suggest };
}
