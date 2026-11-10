// services/feed-in-limit-arbiter.js — eine Einspeisegrenze, mehrere Quellen.
//
// Die Teilvorgabe des Direktvermarkters (LUOX, dv-interface-luox.js) und die
// Einspeisebegrenzung der Steuerbox (EEBUS LPP, services/eebus) wirken auf
// denselben Begrenzer (controlWrite.dvFeedInLimitW, Victron 2706). Es gilt die
// kleinste aktive Grenze; erst wenn keine Quelle mehr begrenzt, wird der Wert
// zurückgeschrieben, der vor der ersten Begrenzung galt (Sichern/Zurückschreiben
// macht applyLimit über die Steuersequenz).

import { smallestLimit } from './import-limit/core.js';
import { notHaltAllowsFeedInSource } from './emergency-stop/policy.js';

/**
 * @param {object} deps
 * @param {(limitW: number|null) => Promise<void>} deps.applyLimit  null = alten Wert zurückschreiben
 * @param {(event: string, data?: object) => void} [deps.pushLog]
 */
// Not-Halt („als ob aus“, services/emergency-stop/policy.js): der Begrenzer
// trägt nur rechtliche Grenzen (Direktvermarkter, Steuerbox, feste Grenze) —
// eine eigene, diskretionäre Vorgabe gibt es hier nicht, also auch nichts
// zurückzunehmen. Der Wert steht im GX gespeichert und gilt weiter, als wäre
// DVhub aus. Geschrieben wird im Not-Halt nur noch eine Änderung einer Quelle,
// deren Klasse weiterläuft (policy.js); die feste Grenze und das Nachprüfen
// (reapply) schweigen. Nach dem Aufheben schreibt der nächste set() den
// wirksamen Wert, falls er sich inzwischen geändert hat.
export function createFeedInLimitArbiter({ applyLimit, pushLog = () => {}, isPaused = () => false }) {
  const sources = new Map();     // name → W
  let applied;                   // undefined = noch nie geschrieben, null = zurückgeschrieben
  let chain = Promise.resolve();
  const blockedLogged = new Set();

  function blockedInNotHalt(source) {
    if (isPaused() !== true) { blockedLogged.clear(); return false; }
    if (source != null && notHaltAllowsFeedInSource(source)) return false;
    const key = source ?? 'reapply';
    if (!blockedLogged.has(key)) {
      blockedLogged.add(key);
      pushLog('feed_in_limit_blocked_nothalt', { source: key, limitW: effective(), sources: Object.fromEntries(sources) }, 'warn');
    }
    return true;
  }

  // Kleinste gilt — derselbe Kern wie bei den Bezugsgrenzen (Netzanschluss,
  // Peak Shaving, §14a-Aufteilung; services/import-limit/core.js).
  function effective() {
    return smallestLimit(sources.values());
  }

  /**
   * Grenze einer Quelle setzen (W) oder aufheben (null). Das Ergebnis-Promise
   * wird abgelehnt, wenn der Begrenzer nicht geschrieben werden konnte — der
   * Aufrufer entscheidet dann über die Rückfallebene.
   */
  function set(source, limitW) {
    if (limitW == null) sources.delete(source);
    else sources.set(source, Math.max(0, Math.round(Number(limitW))));
    const target = effective();
    if (target === applied || (target === null && applied === undefined)) return chain;
    if (blockedInNotHalt(source)) return chain;
    const run = chain.catch(() => {}).then(async () => {
      await applyLimit(target);
      pushLog('feed_in_limit', { limitW: target, sources: Object.fromEntries(sources) });
      applied = target;
    });
    chain = run;
    return run;
  }

  /**
   * Wirksame Grenze erneut schreiben, auch ohne Änderung — wenn das Gerät
   * etwas anderes zeigt (am GX verstellt, GX getauscht). Ohne Grenze nichts.
   */
  function reapply() {
    const target = effective();
    if (target === null) return chain;
    if (blockedInNotHalt(null)) return chain;
    const run = chain.catch(() => {}).then(async () => {
      await applyLimit(target);
      pushLog('feed_in_limit', { limitW: target, sources: Object.fromEntries(sources), reapply: true });
      applied = target;
    });
    chain = run;
    return run;
  }

  /**
   * Not-Halt-Eintritt (control-commands.js): die Grenzen, die DVhub im Auftrag
   * von Direktvermarkter und Steuerbox gesetzt hat, EINMAL zurücknehmen
   * (Christin 10.11.2026: auch DV/§ 9 schreiben im Not-Halt nicht weiter). Es
   * bleibt, was ohne sie gilt: die feste Grenze des Betreibers bzw. der Wert vor
   * DVhub (null → zurückschreiben). Kein Wiederholen, wenn es scheitert.
   */
  function emergencyStop() {
    const kept = smallestLimit([...sources.entries()]
      .filter(([name]) => name === 'fixed' || notHaltAllowsFeedInSource(name))
      .map(([, w]) => w));
    if (kept === applied || (kept === null && applied === undefined)) return Promise.resolve({ ok: true, skipped: 'unchanged' });
    const run = chain.catch(() => {}).then(async () => {
      await applyLimit(kept);
      pushLog('feed_in_limit', { limitW: kept, sources: Object.fromEntries(sources), reason: 'emergency_stop' });
      applied = kept;
    });
    chain = run;
    return run.then(() => ({ ok: true, limitW: kept }), (e) => ({ ok: false, error: e?.message || String(e) }));
  }

  return {
    set,
    reapply,
    emergencyStop,
    effective,
    sources: () => Object.fromEntries(sources),
  };
}
