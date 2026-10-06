// services/optimizer/grid-storage.js — Betriebsart „Nur Netzspeicher“
// (Graustrom-Arbitrage).
//
// Ein Speicher ohne PV-Anlage und ohne Hausverbrauch hinter einem einzigen
// Zähler: er lädt nur aus dem Netz und speist nur ins Netz ein. EOS plant dann
// reine Arbitrage auf dem Börsenpreis. Dafür ändert sich gegenüber einer
// PV-Anlage dreierlei:
//
//   PV          immer 0 — eine Reihe aus Nullen statt einer Prognose (ohne Reihe
//               rechnet EOS nicht).
//   Verbrauch   nur der Eigenbedarf der Anlage (Wechselrichter, Regler). Er
//               steht im Netzzähler, wenn der Akku ruht — einen eigenen
//               Verbrauchszähler gibt es nicht. Die Umwandlungsverluste beim
//               Laden und Entladen gehören NICHT dazu, die rechnet EOS über die
//               Wirkungsgrade.
//   Netzladen   hängt nur am Schalter „Netzladen erlaubt“. Die MiSpeL-Bedingung
//               (Pauschal-/Abgrenzungsoption) schützt die EEG-Förderung einer
//               PV-Anlage vor der Vermischung mit Netzstrom; ohne PV gibt es
//               nichts zu vermischen.
//
// §14a EnWG bleibt davon unberührt: die Begrenzung des Netzbezugs greift an der
// Ausführung (schedule-eval), nicht an der Planung.

export const STANDBY_FALLBACK_W = 100;
const STANDBY_MAX_W = 2000;       // darüber ist es kein Ruhebedarf mehr
const IDLE_BATTERY_W = 100;       // Akku gilt als ruhend
const MIN_SAMPLES = 20;
const MAX_SAMPLES = 720;          // 12 h bei einem Wert je Minute

export function isGridStorageOnly(cfg) {
  return cfg?.optimizer?.gridStorageOnly === true;
}

/**
 * Darf EOS Netzladen planen und DVhub es ausführen?
 * PV-Anlage: Schalter + MiSpeL-Modus. Nur Netzspeicher: der Schalter allein.
 */
export function isGridChargeLicensed(cfg) {
  if (cfg?.optimizer?.allowGridCharge !== true) return false;
  if (isGridStorageOnly(cfg)) return true;
  const mode = cfg?.optimizer?.mispel?.mode;
  return mode === 'pauschal' || mode === 'abgrenzung';
}

/** Netzbezug in Watt (positiv = Bezug) aus dem Zählerwert und seiner Vorzeichenregel. */
export function gridImportW(meterTotalW, gridPositiveMeans) {
  const v = Number(meterTotalW);
  if (!Number.isFinite(v)) return null;
  return gridPositiveMeans === 'grid_import' ? v : -v;
}

/**
 * Schätzt den Ruhebedarf: Median des Netzbezugs in den Momenten, in denen der
 * Akku weder lädt noch entlädt.
 */
export function createStandbyEstimator() {
  const samples = [];
  return {
    /** @returns {boolean} ob der Wert übernommen wurde */
    sample({ importW, batteryPowerW }) {
      const imp = Number(importW);
      const bat = Number(batteryPowerW);
      if (importW == null || batteryPowerW == null || !Number.isFinite(imp) || !Number.isFinite(bat)) return false;
      if (Math.abs(bat) > IDLE_BATTERY_W) return false;
      if (imp < 0 || imp > STANDBY_MAX_W) return false;
      samples.push(imp);
      if (samples.length > MAX_SAMPLES) samples.shift();
      return true;
    },
    /** @returns {number|null} Watt, null solange zu wenige Werte da sind */
    estimateW() {
      if (samples.length < MIN_SAMPLES) return null;
      const sorted = [...samples].sort((a, b) => a - b);
      const mid = sorted.length >> 1;
      return Math.round(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
    },
    count: () => samples.length
  };
}

/**
 * Ruhebedarf für die Planung: fester Wert aus den Einstellungen, sonst die
 * Schätzung aus dem Netzzähler, sonst 100 W.
 * @returns {{ watts: number, source: 'config'|'measured'|'fallback' }}
 */
export function resolveStandbyW(cfg, estimator) {
  const fixed = Number(cfg?.optimizer?.gridStorageStandbyW);
  if (Number.isFinite(fixed) && fixed > 0) return { watts: Math.min(fixed, STANDBY_MAX_W), source: 'config' };
  const measured = estimator?.estimateW?.();
  if (measured != null) return { watts: measured, source: 'measured' };
  return { watts: STANDBY_FALLBACK_W, source: 'fallback' };
}

/**
 * PV-Reihe (Viertelstunden, 0 W) und Verbrauchs-Reihe (Stunden, Ruhebedarf) über
 * den Zeitraum der Preise — von zwei Stunden vor jetzt bis zum Ende des letzten
 * Preis-Slots.
 * @param {Array<{start?: string, ts?: string|number}>} priceSlots
 */
export function buildGridStorageSeries(priceSlots, standbyW, nowMs = Date.now()) {
  const HOUR = 3_600_000;
  const QUARTER = 900_000;
  let last = null;
  for (const sl of priceSlots || []) {
    const v = sl?.start ?? sl?.ts;
    const t = typeof v === 'number' ? v : Date.parse(v);
    if (Number.isFinite(t) && (last === null || t > last)) last = t;
  }
  if (last === null) return { pvSlots: [], loadSlots: [] };
  const from = Math.floor(nowMs / HOUR) * HOUR - 2 * HOUR;
  const until = Math.floor(last / HOUR) * HOUR + HOUR;
  const pvSlots = [];
  const loadSlots = [];
  for (let t = from; t < until; t += HOUR) {
    loadSlots.push({ start: new Date(t).toISOString(), powerW: standbyW });
    for (let q = 0; q < 4; q++) pvSlots.push({ start: new Date(t + q * QUARTER).toISOString(), powerW: 0 });
  }
  return { pvSlots, loadSlots };
}
