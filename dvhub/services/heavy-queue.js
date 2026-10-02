// services/heavy-queue.js — schwere History-Anfragen in Reihe statt alle auf einmal.
//
// Christin 2026-10-02 (Container-Test mit Prod-Daten): Wer in der History schnell
// durch die Monate klickt, startet für JEDEN Monat eine Berechnung (~63.000
// Zeilen) — auch für die, die längst weggeklickt sind. 4–5 davon gleichzeitig
// trieben DVhub über sein 192-MB-Container-Limit; der Kernel beendete den
// Prozess, die Oberfläche zeigte „Load failed“.
//
//   • höchstens `max` Berechnungen gleichzeitig, der Rest wartet
//   • ist der Browser beim Start schon weg (Verbindung zu), wird übersprungen
//   • gleiche Anfrage (Pfad + Query) gleichzeitig → nur einmal rechnen

export const SKIPPED = Symbol('heavy-queue-skipped');

export function createHeavyQueue({ max = 2 } = {}) {
  let running = 0;
  const waiting = [];
  const inflight = new Map();   // key → Promise

  const gone = (req, res) => !!(req?.destroyed || res?.destroyed || res?.writableEnded || req?.socket?.destroyed);

  function next() {
    while (running < max && waiting.length) {
      const job = waiting.shift();
      if (gone(job.req, job.res)) { job.resolve(SKIPPED); continue; }
      running++;
      Promise.resolve().then(job.fn).then(job.resolve, job.reject).finally(() => { running--; next(); });
    }
  }

  function run({ key, req, res }, fn) {
    if (key && inflight.has(key)) return inflight.get(key);
    const p = new Promise((resolve, reject) => {
      waiting.push({ req, res, fn, resolve, reject });
      next();
    });
    if (key) {
      inflight.set(key, p);
      p.finally(() => inflight.delete(key)).catch(() => {});
    }
    return p;
  }

  return { run, stats: () => ({ running, waiting: waiting.length, inflight: inflight.size }) };
}
