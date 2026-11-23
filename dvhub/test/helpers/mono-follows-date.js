// test/helpers/mono-follows-date.js — A26 (Christin 24.11.2026): DVhub misst Abstände (Keepalive, Backoff, Fristen,
// Frische) monoton mit performance.now. Rigs, die Zeitablauf über eine gestellte Uhr simulieren (node:test
// mock.timers stellt nur Date/setTimeout, oder Date.now = …), lassen damit die monotone Uhr mit der gestellten Uhr
// mitlaufen: „5 s vergehen“ heißt dann für beide Uhren dasselbe. Nie rückwärts (wie die echte monotone Uhr).
// Gibt die Rücknahme zurück.
import { performance } from 'node:perf_hooks';

export function monoFollowsDate() {
  const realPerfNow = performance.now;
  // Ganzzahlige Basis: gestellte Abstände (5000 ms) bleiben exakt, ohne Gleitkomma-Rest.
  const basePerf = Math.ceil(realPerfNow.call(performance));
  const baseWall = Date.now();
  let last = basePerf;
  performance.now = () => {
    last = Math.max(last, basePerf + (Date.now() - baseWall));
    return last;
  };
  return () => { performance.now = realPerfNow; };
}
