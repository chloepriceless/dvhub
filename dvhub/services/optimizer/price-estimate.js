// services/optimizer/price-estimate.js — Börsenpreise über die bekannten
// Day-Ahead-Preise hinaus per Holt-Winters fortschreiben.
//
// Stand 1.0.11: Für den EOS-Prognose-Schwanz NICHT mehr genutzt — der kommt
// aus der Residuallast-Prognose von dvhub.online (price-outlook.js, Christin
// 12.11.2026). Einziger verbliebener Nutzer ist die Wertgrundlage des E-Autos
// (ev-targets.js buildEvValueInputs, bis 9,5 Tage voraus, weiter als die
// Prognose reicht); ob sie umgestellt wird, entscheidet Christin.
//
// Ursprung (bis 1.0.10 auch der Schwanz):
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

import { zoneOffsetMs } from '../../tz-fast.js';
// Seit 1.0.11 kommt der EOS-Preisschwanz aus der Residuallast-Prognose
// (price-outlook.js). Holt-Winters dient nur noch der Wertgrundlage des
// E-Autos (ev-targets.js, bis 9,5 Tage voraus) — siehe eos-forecast-bridge.js.
import { SLOT_MS, MIN_REAL_AHEAD_MS, realPriceCoverage } from './price-outlook.js';

export { SLOT_MS, MIN_REAL_AHEAD_MS, realPriceCoverage };
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
 * Geschätzt wird nur hinter echten Preisen, die mindestens bis jetzt + 1 h
 * 15 min reichen (MIN_REAL_AHEAD_MS) — sonst lägen Schätzwerte im
 * Steuerzeitraum, und fehlen schon die Preise für jetzt (Abruf gestört),
 * bliebe EOS ganz auf Schätzwerten stehen. Dann bleibt alles wie bisher.
 *
 * @param {Array<{start:string, ctKwh:number}>} priceSlots echte Slots
 * @param {object} opts
 * @param {Array<{ms:number, ct:number}>} opts.history  gespeicherte Day-Ahead-Historie
 * @param {number} opts.untilMs  bis wohin (exklusiv) die Reihe reichen soll
 * @param {number} [opts.nowMs]  jetzt (Standard: Date.now())
 * @param {string} [opts.timeZone]  Ortszeit des Marktes (Standard Europe/Berlin):
 *   Saison und Schätzung laufen auf der Ortszeit, nicht auf UTC — Börsenpreise
 *   folgen dem Tagesablauf, nach einer Zeitumstellung lag die Schätzung sonst
 *   eine Stunde daneben (Gesamtprüfung Release 1.0.9).
 * @returns {{slots:Array, estimate:null|{estimatedSlots:number, from:string, until:string, method:string, historySlots:number}}}
 */
export function fillPriceSlots(priceSlots, { history = [], untilMs, nowMs = Date.now(), timeZone = 'Europe/Berlin' } = {}) {
  const real = (Array.isArray(priceSlots) ? priceSlots : [])
    .filter((s) => s && s.start && Number.isFinite(Number(s.ctKwh)) && Number.isFinite(Date.parse(s.start)));
  const unchanged = { slots: Array.isArray(priceSlots) ? priceSlots : [], estimate: null };
  const { end: fromMs, stepMs } = realPriceCoverage(real);
  if (!real.length || !Number.isFinite(untilMs) || fromMs < nowMs + MIN_REAL_AHEAD_MS) return unchanged;
  // Geschätzt wird in der Slot-Länge der echten Preise: eine Reihe mit
  // gemischter Kadenz (Stundenpreise + 15-min-Schätzung) liest EOS
  // (bounded_forecast_array) mit Lücken und bricht ab (Gegenprüfung 8c050aae).
  const perSlot = Math.max(1, Math.round(stepMs / SLOT_MS));
  const slotCount = Math.ceil((untilMs - fromMs) / stepMs);
  if (slotCount <= 0) return unchanged;

  // Die echten Slots gehören zur Historie (heute/morgen stehen evtl. noch
  // nicht in der Datenbank) und gehen der gespeicherten Reihe vor; Stunden-
  // preise gelten für jede ihrer Viertelstunden.
  const points = Array.isArray(history) ? history.slice() : [];
  for (const s of real) {
    const ms = Date.parse(s.start);
    for (let k = 0; k < perSlot; k += 1) points.push({ ms: ms + k * SLOT_MS, ct: Number(s.ctKwh) });
  }
  // Auf die Ortszeit legen: lokal = UTC + Abstand. In der Rückstellungsstunde
  // gibt es eine Ortszeit zweimal (der spätere Wert gilt), in der
  // Vorstellungsstunde fehlt eine (regularHistory überbrückt sie linear).
  let tz = timeZone || 'Europe/Berlin';
  try { zoneOffsetMs(fromMs, tz); } catch { tz = 'Europe/Berlin'; }
  const local = (ms) => ms + zoneOffsetMs(ms, tz);
  const localPoints = points
    .filter((p) => Number.isFinite(Number(p?.ms)))
    .map((p) => ({ ms: local(Number(p.ms)), ct: p.ct }));
  const lastLocal = local(fromMs - SLOT_MS);
  const quarterIndex = (ms) => Math.max(0, Math.round((local(ms) - lastLocal) / SLOT_MS) - 1);
  // Höchster Index über alle Viertelstunden (nach der Rückstellung kann ein
  // früherer Slot den späteren Ortszeit-Index haben).
  let steps = 0;
  for (let ms = fromMs; ms < fromMs + slotCount * stepMs; ms += SLOT_MS) steps = Math.max(steps, quarterIndex(ms) + 1);
  const fc = forecastSpotPrices(localPoints, lastLocal, steps);
  if (!fc) return unchanged;

  const added = [];
  for (let i = 0; i < slotCount; i += 1) {
    const start = fromMs + i * stepMs;
    const quarters = [];
    for (let k = 0; k < perSlot; k += 1) quarters.push(fc.values[quarterIndex(start + k * SLOT_MS)]);
    added.push({
      start: new Date(start).toISOString(),
      end: new Date(start + stepMs).toISOString(),
      ctKwh: round2(quarters.reduce((a, v) => a + v, 0) / quarters.length),
      confidence: 0.5,
      estimated: true,
    });
  }
  return {
    slots: [...unchanged.slots, ...added],
    estimate: {
      estimatedSlots: added.length,
      from: added[0].start,
      until: new Date(fromMs + added.length * stepMs).toISOString(),
      method: fc.method,
      historySlots: fc.historySlots,
    },
  };
}
