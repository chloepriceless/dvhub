// services/optimizer/price-estimate.js — Börsenpreise über die bekannten
// Day-Ahead-Preise hinaus schätzen, damit EOS seinen Prognose-Schwanz (tail)
// nicht auf eine halbe Stunde kürzt.
//
// Christin 01.11.2026: DVhub schickt EOS Bezugs- und Einspeisepreise über die
// Import-Provider. Vormittags enden die bekannten Preise um Mitternacht; EOS
// kürzt dann den Schwanz („Tail forecast shortened: requested 48 h, effective
// 0.5 h“) und bewertet die Restladung fast nur zum mittleren Einspeisewert —
// es speist mittags PV ein, statt sie für Nacht und Morgen zu speichern. Die
// EOS-eigenen Preisquellen (elecpriceenergycharts.py, elecpriceakkudoktor.py)
// schreiben fehlende Stunden aus ihrer Historie fort, die Import-Provider nicht.
//
// Methode wie Vanilla-EOS (priceabc.py `_predict`): additive exponentielle
// Glättung (Holt-Winters, Niveau + Saison, ohne Trend) auf der Day-Ahead-
// Historie — mit Wochen-Saison ab zwei Wochen Historie, sonst mit Tages-Saison
// ab zwei Tagen. Weniger Historie: KEINE Schätzung (EOS nähme dann den Median;
// DVhub lässt die Reihe lieber wie bisher enden). Ausreißer werden vor dem
// Anpassen auf Mittelwert ± sigma·Standardabweichung gekappt (EOS: sigma 2).
// Die Glättungsparameter sucht ein kleines Gitter nach der kleinsten Summe der
// Ein-Schritt-Fehler (statsmodels optimiert sie stetig — gleiche Idee).
//
// Echte Preise haben immer Vorrang: geschätzt wird nur hinter dem letzten
// bekannten Slot, der nächste Push mit echten Preisen ersetzt die Schätzung.

export const SLOT_MS = 15 * 60 * 1000;
const DAY_SLOTS = 96;
const WEEK_SLOTS = 7 * DAY_SLOTS;
/** Höchstens so viel Historie (Tage) geht in die Anpassung. */
export const HISTORY_DAYS = 28;
/** Unter zwei Tagen Historie wird nicht geschätzt. */
export const MIN_HISTORY_SLOTS = 2 * DAY_SLOTS;
export const OUTLIER_SIGMA = 2;

const ALPHAS = [0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.3, 0.5];
const GAMMAS = [0, 0.02, 0.05, 0.1, 0.2, 0.3];

/** Werte auf Mittelwert ± sigma·Standardabweichung kappen (EOS `_cap_outliers`). */
export function capOutliers(values, sigma = OUTLIER_SIGMA) {
  const n = values.length;
  if (!n || !(sigma > 0)) return values.slice();
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const std = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / n);
  const lo = mean - sigma * std;
  const hi = mean + sigma * std;
  return values.map((v) => Math.min(hi, Math.max(lo, v)));
}

// Startwerte: Niveau = Mittel der ersten Saison, Saison = mittlere Abweichung
// je Saisonplatz über alle vollen Saisons (jeweils um ihr eigenes Mittel
// bereinigt) — die „Wochen-/Tagesmuster“.
function initialState(y, m) {
  const cycles = Math.floor(y.length / m);
  const season = new Array(m).fill(0);
  for (let c = 0; c < cycles; c += 1) {
    let mean = 0;
    for (let i = 0; i < m; i += 1) mean += y[c * m + i];
    mean /= m;
    for (let i = 0; i < m; i += 1) season[i] += (y[c * m + i] - mean) / cycles;
  }
  let level = 0;
  for (let i = 0; i < m; i += 1) level += y[i];
  return { level: level / m, season };
}

function runEts(y, m, alpha, gamma, init) {
  const season = init.season.slice();
  let level = init.level;
  let sse = 0;
  for (let t = m; t < y.length; t += 1) {
    const k = t % m;
    const err = y[t] - (level + season[k]);
    sse += err * err;
    const next = alpha * (y[t] - season[k]) + (1 - alpha) * level;
    season[k] = gamma * (y[t] - level) + (1 - gamma) * season[k];
    level = next;
  }
  return { sse, level, season };
}

/**
 * Additive Holt-Winters ohne Trend anpassen und `steps` Werte fortschreiben.
 * @param {number[]} y  gleichmäßige Reihe, älteste zuerst
 * @param {number} m    Saisonlänge in Werten
 * @param {number} steps
 */
export function etsForecast(y, m, steps) {
  if (y.length < 2 * m) throw new Error(`ETS braucht ${2 * m} Werte, hat ${y.length}`);
  const init = initialState(y, m);
  let best = null;
  for (const alpha of ALPHAS) {
    for (const gamma of GAMMAS) {
      if (gamma > 1 - alpha) continue;
      const fit = runEts(y, m, alpha, gamma, init);
      if (!best || fit.sse < best.sse) best = { ...fit, alpha, gamma };
    }
  }
  const n = y.length;
  const out = new Array(steps);
  for (let h = 1; h <= steps; h += 1) out[h - 1] = best.level + best.season[(n - 1 + h) % m];
  return { values: out, alpha: best.alpha, gamma: best.gamma };
}

/**
 * Historie [{ms, ct}] auf ein lückenloses 15-min-Raster bis zum Slot `lastMs`
 * legen (höchstens HISTORY_DAYS). Lücken werden linear überbrückt (EOS:
 * fill_method="linear"); vor dem ersten Wert wird abgeschnitten.
 * @returns {number[]}
 */
export function regularHistory(points, lastMs, { days = HISTORY_DAYS } = {}) {
  const byMs = new Map();
  for (const p of Array.isArray(points) ? points : []) {
    const ms = Number(p?.ms);
    const ct = Number(p?.ct);
    if (!Number.isFinite(ms) || !Number.isFinite(ct) || ms > lastMs) continue;
    byMs.set(ms - (ms % SLOT_MS), ct);
  }
  const firstAllowed = lastMs - (days * DAY_SLOTS - 1) * SLOT_MS;
  const grid = [];
  for (let ms = firstAllowed; ms <= lastMs; ms += SLOT_MS) grid.push(byMs.has(ms) ? byMs.get(ms) : null);
  const first = grid.findIndex((v) => v !== null);
  if (first < 0 || grid[grid.length - 1] === null) return [];
  const y = grid.slice(first);
  for (let i = 1; i < y.length; i += 1) {
    if (y[i] !== null) continue;
    let j = i;
    while (y[j] === null) j += 1;
    const a = y[i - 1];
    const b = y[j];
    for (let k = i; k < j; k += 1) y[k] = a + ((b - a) * (k - i + 1)) / (j - i + 1);
    i = j;
  }
  return y;
}

/**
 * Börsenpreise (ct/kWh) für `steps` Slots nach `lastMs` schätzen.
 * @returns {{values:number[], method:string, historySlots:number}|null}  null bei zu wenig Historie
 */
export function forecastSpotPrices(points, lastMs, steps, { sigma = OUTLIER_SIGMA } = {}) {
  if (!(steps > 0)) return null;
  const y = regularHistory(points, lastMs);
  if (y.length < MIN_HISTORY_SLOTS) return null;
  const clean = capOutliers(y, sigma);
  const m = y.length >= 2 * WEEK_SLOTS ? WEEK_SLOTS : DAY_SLOTS;
  const fc = etsForecast(clean, m, steps);
  return {
    values: fc.values,
    method: m === WEEK_SLOTS ? 'ets-weekly' : 'ets-daily',
    historySlots: y.length,
    alpha: fc.alpha,
    gamma: fc.gamma,
  };
}

function round2(v) {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

/**
 * Preis-Slots (forecast.price.slots: {start, end, ctKwh}) hinter dem letzten
 * bekannten Slot bis `untilMs` mit geschätzten Börsenpreisen verlängern.
 * Echte Slots bleiben unverändert; neue tragen `estimated: true`.
 *
 * @param {Array<{start:string, ctKwh:number}>} priceSlots echte Slots
 * @param {object} opts
 * @param {Array<{ms:number, ct:number}>} opts.history  gespeicherte Day-Ahead-Historie
 * @param {number} opts.untilMs  bis wohin (exklusiv) die Reihe reichen soll
 * @returns {{slots:Array, estimate:null|{estimatedSlots:number, from:string, until:string, method:string, historySlots:number}}}
 */
export function fillPriceSlots(priceSlots, { history = [], untilMs } = {}) {
  const real = (Array.isArray(priceSlots) ? priceSlots : [])
    .filter((s) => s && s.start && Number.isFinite(Number(s.ctKwh)) && Number.isFinite(Date.parse(s.start)));
  const unchanged = { slots: Array.isArray(priceSlots) ? priceSlots : [], estimate: null };
  if (!real.length || !Number.isFinite(untilMs)) return unchanged;
  let lastMs = -Infinity;
  for (const s of real) lastMs = Math.max(lastMs, Date.parse(s.start));
  lastMs -= lastMs % SLOT_MS;
  const fromMs = lastMs + SLOT_MS;
  const steps = Math.ceil((untilMs - fromMs) / SLOT_MS);
  if (steps <= 0) return unchanged;

  // Die echten Slots gehören zur Historie (heute/morgen stehen evtl. noch
  // nicht in der Datenbank) und gehen der gespeicherten Reihe vor.
  const points = [
    ...(Array.isArray(history) ? history : []),
    ...real.map((s) => ({ ms: Date.parse(s.start), ct: Number(s.ctKwh) })),
  ];
  const fc = forecastSpotPrices(points, lastMs, steps);
  if (!fc) return unchanged;

  const added = fc.values.map((ct, i) => {
    const start = fromMs + i * SLOT_MS;
    return {
      start: new Date(start).toISOString(),
      end: new Date(start + SLOT_MS).toISOString(),
      ctKwh: round2(ct),
      confidence: 0.5,
      estimated: true,
    };
  });
  return {
    slots: [...unchanged.slots, ...added],
    estimate: {
      estimatedSlots: added.length,
      from: added[0].start,
      until: new Date(fromMs + added.length * SLOT_MS).toISOString(),
      method: fc.method,
      historySlots: fc.historySlots,
    },
  };
}
