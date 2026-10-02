// services/feed-in-limit-arbiter.js — eine Einspeisegrenze, mehrere Quellen.
//
// Die Teilvorgabe des Direktvermarkters (LUOX, dv-interface-luox.js) und die
// Einspeisebegrenzung der Steuerbox (EEBUS LPP, services/eebus) wirken auf
// denselben Begrenzer (controlWrite.dvFeedInLimitW, Victron 2706). Es gilt die
// kleinste aktive Grenze; erst wenn keine Quelle mehr begrenzt, wird der Wert
// zurückgeschrieben, der vor der ersten Begrenzung galt (Sichern/Zurückschreiben
// macht applyLimit über die Steuersequenz).

/**
 * @param {object} deps
 * @param {(limitW: number|null) => Promise<void>} deps.applyLimit  null = alten Wert zurückschreiben
 * @param {(event: string, data?: object) => void} [deps.pushLog]
 */
export function createFeedInLimitArbiter({ applyLimit, pushLog = () => {} }) {
  const sources = new Map();     // name → W
  let applied;                   // undefined = noch nie geschrieben, null = zurückgeschrieben
  let chain = Promise.resolve();

  function effective() {
    let min = null;
    for (const w of sources.values()) {
      if (Number.isFinite(w) && (min === null || w < min)) min = w;
    }
    return min;
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
    const run = chain.catch(() => {}).then(async () => {
      await applyLimit(target);
      pushLog('feed_in_limit', { limitW: target, sources: Object.fromEntries(sources) });
      applied = target;
    });
    chain = run;
    return run;
  }

  return {
    set,
    effective,
    sources: () => Object.fromEntries(sources),
  };
}
