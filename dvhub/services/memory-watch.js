// services/memory-watch.js — woher kommen DVhubs Speicherspitzen?
//
// Christin 2026-10-01: auf prod lag DVhub meist bei 130–300 MB, zeitweise bei
// 750–800 MB, ohne erkennbaren Auslöser. Für 512-MB-Boards muss das weg —
// erst muss man es sehen. Alle 5 s wird process.memoryUsage() gelesen; steigt
// RSS um mehr als JUMP_MB gegenüber dem vorigen Wert oder über ALERT_MB, gehen
// ins Log: Speicherwerte und was gerade lief (offene HTTP-Anfragen mit Pfad und
// Alter, laufende Intervall-Jobs). Kein Spitzen-Spam: höchstens einmal je
// Minute, außer es wird noch höher.

export const MEMORY_WATCH_INTERVAL_MS = 5000;
const JUMP_MB = 80;
const ALERT_MB = 400;
const MB = 1024 * 1024;

export const activity = {
  requests: new Map(),   // id → { method, path, at }
  jobs: new Map(),       // name → at
};
let reqSeq = 0;

/** HTTP-Anfrage als „läuft“ markieren; Rückgabe beendet sie. */
export function trackRequest(method, path) {
  const id = ++reqSeq;
  activity.requests.set(id, { method, path: String(path).slice(0, 120), at: Date.now() });
  return () => activity.requests.delete(id);
}
/** Job als „läuft“ markieren (safeInterval); Rückgabe beendet ihn. */
export function trackJob(name) {
  activity.jobs.set(name, Date.now());
  return () => activity.jobs.delete(name);
}

export function snapshotActivity(now = Date.now()) {
  return {
    requests: [...activity.requests.values()].map((r) => ({ ...r, ageMs: now - r.at })).slice(0, 10),
    jobs: [...activity.jobs.entries()].map(([name, at]) => ({ name, ageMs: now - at })).slice(0, 10),
  };
}

export function createMemoryWatch({ pushLog, memoryUsage = () => process.memoryUsage(), now = () => Date.now() } = {}) {
  let prevRss = null;
  let lastAlertAt = 0;
  let lastAlertRss = 0;
  let peak = { rssMb: 0, at: null, activity: null };

  function sample() {
    const m = memoryUsage();
    const rssMb = Math.round(m.rss / MB);
    const t = now();
    const jump = prevRss != null ? rssMb - prevRss : 0;
    prevRss = rssMb;
    const act = (jump >= JUMP_MB || rssMb >= ALERT_MB) ? snapshotActivity(t) : null;
    if (rssMb > peak.rssMb) peak = { rssMb, at: new Date(t).toISOString(), activity: act || snapshotActivity(t) };
    if (!act) return null;
    if (t - lastAlertAt < 60_000 && rssMb <= lastAlertRss) return null;
    lastAlertAt = t; lastAlertRss = rssMb;
    const entry = {
      rssMb, jumpMb: jump,
      heapUsedMb: Math.round(m.heapUsed / MB), heapTotalMb: Math.round(m.heapTotal / MB),
      externalMb: Math.round(m.external / MB), arrayBuffersMb: Math.round((m.arrayBuffers || 0) / MB),
      ...act,
    };
    pushLog?.('memory_spike', entry, 'warn');
    return entry;
  }

  let timer = null;
  return {
    start() {
      if (timer) return;
      timer = setInterval(sample, MEMORY_WATCH_INTERVAL_MS);
      timer.unref?.();
    },
    stop() { clearInterval(timer); timer = null; },
    sample,
    peak: () => peak,
  };
}
