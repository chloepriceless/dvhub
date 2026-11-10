/**
 * E-Auto: Mindest-Ladestand bis zur Abfahrt + Max-Ladestand „wenn günstig“.
 *
 * EOS kennt je Auto EIN Ziel mit EINER Frist und lädt nie freiwillig darüber:
 * Energie über `min_soc_percentage` kostet im Fitnesswert Geld und bringt
 * nichts. DVhub sagt EOS deshalb zusätzlich, was Energie über dem Ziel wert ist
 * (Wertstufen, eos-capabilities.js EOS_EV_SOC_VALUE_FIELD), und rechnet das
 * Ziel vorausschauend über die nächsten Fahrten. Reine Rechnung, ohne Zustand.
 *
 * Portiert aus der Simulation (eos-bench/ev-minmax/evsim.py: propagate_min,
 * future_cost_curve, value_steps und die Ableitung je Lauf), dort gegen 115
 * Läufe und fünf Gegenprüfungen gerechnet; test/ev-minmax.test.js hält beide
 * mit Golden-Werten gleich. Alles in Prozent Ladestand (SoC), nie in km.
 *
 *   1. Vorausschauendes Mindestziel (propagateMin): rückwärts über die Fahrten
 *      der nächsten 8 Tage req_k = max(min_k, req_{k+1} + Fahrt_k −
 *      nachladbar(Ankunft_k → Abfahrt_{k+1})). So bleibt auch ein späteres Ziel
 *      erreichbar, wenn zwischen zwei Fahrten kaum Zeit zum Laden ist.
 *   2. Max-Ladestand: max(evMaxSocPct, Mindestziel) — ein höheres Einmal-Ziel
 *      gewinnt.
 *   3. Wert der Energie über dem Ziel (valueSteps): die künftigen Ladekosten,
 *      die eine zusätzliche kWh zum Bewertungszeitpunkt E (Abfahrt im
 *      Steuerzeitraum, sonst dessen Ende) für die 7 Tage danach erspart.
 *      Rückwärts-DP über die Viertelstunden (futureCostCurve): zu Hause darf
 *      das Auto je Viertelstunde 0 bis volle Leistung laden, erst PV-Überschuss
 *      zum Einspeisepreis (entgangene Vergütung), dann Netz zum Bezugspreis; bei
 *      jeder Abfahrt muss das Mindestziel stehen (sonst MISS_EUR_PER_PCT je
 *      Prozentpunkt), dann geht die Fahrt ab; unterwegs wird nicht geladen.
 *      Je 5-%-Band die Ersparnis je gespeicherter kWh, minus Sicherheitsabschlag,
 *      gedeckelt beim höchsten Bezugspreis, nicht steigend.
 *
 * Fahrten: { depMs, retMs, tripPct, minPct } — Abfahrt, Rückkehr (Anstecken),
 * Verbrauch der Fahrt in % und Mindest-Ladestand bei dieser Abfahrt in %.
 */
import { zonedToUtcMs } from './ev-departure.js';

export const SLOT_MS = 15 * 60_000;
/** Vorausschau der Wertbestimmung ab E (Tage). */
export const EV_PLAN_LOOKAHEAD_DAYS = 7;
/** Vorausschau des Mindestziels ab der nächsten Abfahrt (Tage). */
export const PROPAGATE_HORIZON_DAYS = 8;
/** SoC-Raster der DP: 1/16 einer Viertelstunde mit voller Leistung. */
export const DP_STEPS_PER_SLOT = 16;
/** Strafe der DP für ein verfehltes Mindestziel (€ je Prozentpunkt, weit über jedem Preis). */
export const MISS_EUR_PER_PCT = 1.0;
/** Breite der Wertstufen (Prozentpunkte). */
export const VALUE_BIN_PCT = 5;
/** Ladewirkungsgrad des Autos, wie DVhub ihn EOS meldet (eos-config-sync.js). */
export const EV_CHARGE_EFFICIENCY = 0.88;
/** Standard-Max-Ladestand „wenn günstig“ (%). */
export const EV_MAX_SOC_DEFAULT = 80;
/** Standard-Sicherheitsabschlag auf den Wert (ct je kWh AC). */
export const EV_VALUE_MARGIN_CT_DEFAULT = 1.0;

const DAY_MS = 24 * 3600_000;

// Ortszeit-Bestandteile (Intl ist teuer: Formatierer je Zone merken).
const PARTS = new Map();
function localParts(ms, timeZone) {
  let f = PARTS.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    });
    PARTS.set(timeZone, f);
  }
  const p = {};
  for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
  return { year: Number(p.year), month: Number(p.month), day: Number(p.day), hour: Number(p.hour), minute: Number(p.minute) };
}

/**
 * Gleiche Wanduhrzeit `days` Tage später (wie Python `datetime + timedelta(days)`
 * mit Zeitzone): über eine Zeitumstellung sind das 167 oder 169 Stunden.
 */
export function addLocalDays(ms, days, timeZone = 'Europe/Berlin') {
  const p = localParts(ms, timeZone);
  const t = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  const sec = Math.floor(ms / 1000) % 60;
  return zonedToUtcMs(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate(), p.hour, p.minute, timeZone) + sec * 1000;
}

/** Viertelstunde des Tages in Ortszeit (0..95). */
export function todKey(ms, timeZone = 'Europe/Berlin') {
  const p = localParts(ms, timeZone);
  return p.hour * 4 + Math.floor(p.minute / 15);
}

/** Gespeicherte % je Viertelstunde mit voller Leistung. */
export function slotStoredPct({ chargeW, eta = EV_CHARGE_EFFICIENCY, capacityWh, slotMs = SLOT_MS }) {
  return chargeW * (slotMs / 1000) / 3600 * eta / capacityWh * 100;
}

// numpy.round(x, 6): rint(x · 10⁶) / 10⁶ (halbe Werte zur geraden Zahl).
function rint(y) {
  const r = Math.round(y);
  return (Math.abs(y - Math.trunc(y)) === 0.5 && r % 2 !== 0) ? r - 1 : r;
}
const round6 = (x) => rint(x * 1e6) / 1e6;
// Python round(x, n) für die Ausgabe.
const pyRound = (x, n) => Number(x.toFixed(n));

/**
 * numpy.interp(x, xp, fp) für AUFSTEIGENDE x (Zeiger statt Suche).
 * Ergebnis in out (Float64Array), gleiche Formel wie numpy.
 */
function interpSorted(x, xp, fp, out) {
  const n = xp.length;
  const last = n - 1;
  let j = 0;
  for (let s = 0; s < x.length; s += 1) {
    const v = x[s];
    if (v >= xp[last]) { out[s] = v > xp[last] ? fp[last] : fp[last]; continue; }
    if (v < xp[0]) { out[s] = fp[0]; continue; }
    if (j > 0 && xp[j] > v) j = 0;
    while (j < last && xp[j + 1] <= v) j += 1;
    if (xp[j] === v) { out[s] = fp[j]; continue; }
    const slope = (fp[j + 1] - fp[j]) / (xp[j + 1] - xp[j]);
    out[s] = slope * (v - xp[j]) + fp[j];
  }
  return out;
}
function interpOne(v, xp, fp) {
  const n = xp.length;
  const last = n - 1;
  if (v >= xp[last]) return fp[last];
  if (v < xp[0]) return fp[0];
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xp[mid] <= v) lo = mid; else hi = mid;
  }
  if (xp[lo] === v) return fp[lo];
  const slope = (fp[lo + 1] - fp[lo]) / (xp[lo + 1] - xp[lo]);
  return slope * (v - xp[lo]) + fp[lo];
}

/**
 * Mindest-Ladestand bei der ERSTEN Abfahrt, damit jedes spätere Mindestziel der
 * nächsten 8 Tage erreichbar bleibt (evsim.py propagate_min).
 * @param {Array<{depMs:number, retMs:number, tripPct:number, minPct:number}>} future  nach Abfahrt sortiert
 */
export function propagateMin(future, { chargeW, eta = EV_CHARGE_EFFICIENCY, capacityWh, timeZone = 'Europe/Berlin', horizonDays = PROPAGATE_HORIZON_DAYS } = {}) {
  if (!Array.isArray(future) || !future.length) return 0;
  const lim = addLocalDays(future[0].depMs, horizonDays, timeZone);
  const chain = future.filter((x) => x.depMs <= lim);
  let req = Number(chain[chain.length - 1].minPct) || 0;
  for (let k = chain.length - 2; k >= 0; k -= 1) {
    const hours = Math.max(0, ((chain[k + 1].depMs - chain[k].retMs) / 1000) / 3600);
    const chargeable = hours * chargeW * eta / capacityWh * 100;
    req = Math.max(Number(chain[k].minPct) || 0, req + (Number(chain[k].tripPct) || 0) - chargeable);
  }
  return Math.min(100, req);
}

/**
 * Median des PV-Überschusses (Wh je Viertelstunde) je Viertelstunde in Ortszeit
 * — Ersatz hinter dem Ende der PV-Prognose.
 * @param {Array<{ms:number, wh:number}>} entries
 * @returns {Map<number, number>}
 */
export function medianSurplusProfile(entries, timeZone = 'Europe/Berlin') {
  const by = new Map();
  for (const e of Array.isArray(entries) ? entries : []) {
    const wh = Number(e?.wh);
    if (!Number.isFinite(Number(e?.ms)) || !Number.isFinite(wh)) continue;
    const key = todKey(Number(e.ms), timeZone);
    if (!by.has(key)) by.set(key, []);
    by.get(key).push(wh);
  }
  const out = new Map();
  for (const [key, list] of by) {
    const v = list.slice().sort((a, b) => a - b);
    const m = v.length >> 1;
    out.set(key, v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2);
  }
  return out;
}

/**
 * Erwartete Ladekosten C(SoC bei E) für die 7 Tage ab E (evsim.py
 * future_cost_curve). Reihen je Viertelstunde ab baseMs (auf eine Viertelstunde
 * gelegt): importCt / feedInCt (ct je kWh), surplusWh (PV-Überschuss je
 * Viertelstunde). Energie, die am Ende übrig ist, zählt nichts (vorsichtig).
 *
 * @returns {{grid: Float64Array, cost: Float64Array, info: object}}
 */
export function futureCostCurve({
  baseMs, slotMs = SLOT_MS, importCt, feedInCt, surplusWh, eMs, topPct, trips = [],
  capacityWh, eta = EV_CHARGE_EFFICIENCY, chargeW, timeZone = 'Europe/Berlin', windowDays = EV_PLAN_LOOKAHEAD_DAYS,
  windowEndMs = null
}) {
  const idx = (ms) => Math.floor((ms - baseMs) / slotMs);
  // windowEndMs: kürzeres Fenster, wenn die Preise nicht 7 Tage weit reichen.
  const wEnd = Number.isFinite(windowEndMs) ? windowEndMs : addLocalDays(eMs, windowDays, timeZone);
  const all = (Array.isArray(trips) ? trips : []).slice().sort((a, b) => a.depMs - b.depMs);
  const inWin = all.filter((x) => eMs <= x.depMs && x.depMs < wEnd);
  const info = { eMs, nTrips: inWin.length };
  const top = Number(topPct);
  let cap = top;
  for (const x of inWin) cap = Math.max(cap, Math.min(100, Number(x.minPct) || 0));
  const g = slotStoredPct({ chargeW, eta, capacityWh, slotMs }) / DP_STEPS_PER_SLOT;
  const pts = new Set();
  const nAr = Math.ceil(cap / g);
  for (let i = 0; i < nAr; i += 1) pts.add(round6(i * g));
  pts.add(0);
  pts.add(round6(cap));
  for (const x of inWin) {
    const mn = Number(x.minPct) || 0;
    const tr = Number(x.tripPct) || 0;
    for (const q of [mn, tr, mn + tr]) if (q >= 0 && q <= cap) pts.add(round6(q));
  }
  const grid = Float64Array.from([...pts].sort((a, b) => a - b));
  const n = grid.length;
  const iE = idx(eMs);
  const iW = idx(wEnd);
  const whPerPctAc = capacityWh / 100 / eta;
  const depAt = new Map();
  for (const x of inWin) depAt.set(idx(x.depMs), x);
  const away = new Uint8Array(Math.max(0, iW - iE));
  for (const x of all) {
    const a0 = Math.max(idx(x.depMs), iE);
    const a1 = Math.min(idx(x.retMs), iW);
    for (let i = a0; i < a1; i += 1) away[i - iE] = 1;
  }
  const depSlots = [...depAt.keys()].sort((a, b) => a - b);
  const addsCache = new Map();
  const addsFor = (limit) => {
    let a = addsCache.get(limit);
    if (a) return a;
    a = [];
    for (let k = 1; k <= DP_STEPS_PER_SLOT; k += 1) {
      const add = new Float64Array(n);
      const xs = new Float64Array(n);
      for (let s = 0; s < n; s += 1) {
        add[s] = Math.max(Math.min(grid[s] + k * g, limit) - grid[s], 0);
        xs[s] = grid[s] + add[s];
      }
      a.push({ add, xs });
    }
    addsCache.set(limit, a);
    return a;
  };
  let vNext = new Float64Array(n);
  const tmp = new Float64Array(n);
  const after = new Float64Array(n);
  let di = depSlots.length - 1;
  for (let i = iW - 1; i >= iE; i -= 1) {
    let vCur;
    if (!away[i - iE]) {
      const surplus = Number(surplusWh[i]) || 0;
      while (di >= 0 && depSlots[di] > i) di -= 1;
      // nächste Abfahrt NACH Slot i
      const nxt = di + 1 < depSlots.length ? depSlots[di + 1] : null;
      const limit = nxt !== null ? Math.max(top, Math.min(100, Number(depAt.get(nxt).minPct) || 0)) : top;
      const fit = Number(feedInCt[i]);
      const imp = Number(importCt[i]);
      const best = Float64Array.from(vNext);
      for (const { add, xs } of addsFor(limit)) {
        interpSorted(xs, grid, vNext, tmp);
        for (let s = 0; s < n; s += 1) {
          const eAc = add[s] * whPerPctAc;
          const pvPart = Math.min(eAc, surplus);
          const cost = (pvPart * fit + (eAc - pvPart) * imp) / 1e5;
          const v = cost + tmp[s];
          if (v < best[s]) best[s] = v;
        }
      }
      vCur = best;
    } else {
      vCur = vNext;
    }
    const x = depAt.get(i);
    if (x) {
      const tr = Number(x.tripPct) || 0;
      const mn = Number(x.minPct) || 0;
      for (let s = 0; s < n; s += 1) after[s] = Math.max(grid[s] - tr, 0);
      interpSorted(after, grid, vCur, tmp);
      const out = new Float64Array(n);
      for (let s = 0; s < n; s += 1) {
        const a = grid[s] - tr;
        const short = Math.max(mn - grid[s], 0) + Math.max(-a, 0);
        out[s] = tmp[s] + MISS_EUR_PER_PCT * short;
      }
      vCur = out;
    }
    vNext = vCur;
  }
  let impMax = -Infinity;
  for (let i = iE; i < iW; i += 1) impMax = Math.max(impMax, Number(importCt[i]));
  info.impMaxCt = impMax;
  info.dpCap = cap;
  return { grid, cost: vNext, info };
}

/**
 * Wertstufen für EOS: € je gespeicherter kWh über sEPct, in 5-%-Bändern bis
 * maxPct (evsim.py value_steps). Leer, wenn es nichts zu werten gibt.
 * @returns {{steps: Array<[number, number]>, info: object}}
 */
export function valueSteps(args) {
  const { sEPct, maxPct, marginCt = EV_VALUE_MARGIN_CT_DEFAULT, capacityWh, eta = EV_CHARGE_EFFICIENCY, binPct = VALUE_BIN_PCT } = args;
  const top = Math.min(Number(maxPct), 100);
  const sE = Number(sEPct);
  if (!(top > sE + 1e-6)) return { steps: [], info: { reason: 'max <= min' } };
  const { grid, cost, info } = futureCostCurve({ ...args, topPct: top });
  info.sE = pyRound(sE, 2);
  if (info.nTrips === 0) return { steps: [], info: { ...info, reason: 'no trip in window' } };
  const capEur = info.impMaxCt / eta / 100;
  const c = (soc) => interpOne(soc, grid, cost);
  const out = [];
  let a = sE;
  while (a < top - 1e-6) {
    const b = Math.min(top, a + binPct);
    const kwh = (b - a) / 100 * capacityWh / 1000;
    let v = (c(a) - c(b)) / kwh - marginCt / eta / 100;
    v = Math.min(Math.max(v, 0), capEur);
    if (out.length) v = Math.min(v, out[out.length - 1][1]);
    out.push([pyRound(b, 3), pyRound(v, 5)]);
    a = b;
  }
  while (out.length && out[out.length - 1][1] <= 0) out.pop();
  info.cSe = pyRound(c(sE), 3);
  info.steps = out;
  return { steps: out, info };
}

/**
 * EOS-Parameter des Autos je Lauf (evsim.py, Ableitung in main()).
 *
 * @param {object} a
 * @param {number} a.nowMs
 * @param {number} a.refMs   jetzt (angesteckt) bzw. Ankunft (Vorplanung)
 * @param {Array} a.trips    bekannte Fahrten (auch die laufende)
 * @param {number|null} a.maxSocPct  Max-Ladestand „wenn günstig“; null/0 = aus
 * @param {number|null} a.socPct     Ladestand jetzt bzw. erwartet bei Ankunft
 * @param {number|null} a.ctrlEndMs  Ende des EOS-Steuerzeitraums
 * @param {boolean} [a.propagate=true]  vorausschauendes Mindestziel
 * @returns {null|{minSocPct:number, minWeekPct:number, propagatedPct:number, maxSocPct:number,
 *   maxActive:boolean, valueActive:boolean, initialSocPct:number|null, deadlineMs:number, eMs:number,
 *   future:Array}}
 */
export function deriveEvMinMax({ nowMs, refMs, trips, maxSocPct, socPct, ctrlEndMs, propagate = true, chargeW, eta = EV_CHARGE_EFFICIENCY, capacityWh, timeZone = 'Europe/Berlin' }) {
  const ref = Number.isFinite(refMs) ? refMs : nowMs;
  // Die laufende Fahrt (src 'current') ist kein Ziel — im Vorlauf einer
  // Abfahrt liegt sie noch in der Zukunft (Codex 52c5ee20); für „unterwegs“
  // zählt sie weiter (futureCostCurve).
  const future = (Array.isArray(trips) ? trips : []).filter((x) => x.src !== 'current' && x.depMs >= ref && x.depMs > nowMs).sort((a, b) => a.depMs - b.depMs);
  if (!future.length) return null;
  const nxt = future[0];
  const propagated = propagate ? propagateMin(future, { chargeW, eta, capacityWh, timeZone }) : Number(nxt.minPct) || 0;
  const mn = Math.min(100, Math.max(0, Math.ceil(propagated - 1e-9)));
  const maxActive = Number.isFinite(Number(maxSocPct)) && Number(maxSocPct) > 0;
  const mx = maxActive ? Math.max(Math.min(100, Math.round(Number(maxSocPct))), mn) : 100;
  const soc = Number(socPct);
  const initial = socPct === null || socPct === undefined || !Number.isFinite(soc) ? null : Math.max(0, Math.min(100, Math.floor(soc + 1e-9)));
  const end = Number(ctrlEndMs);
  const eMs = Number.isFinite(end) && end > nowMs && !(nxt.depMs < end) ? end : nxt.depMs;
  return {
    minSocPct: mn, minWeekPct: Number(nxt.minPct) || 0, propagatedPct: propagated, maxSocPct: mx,
    maxActive, valueActive: maxActive && mx > mn, initialSocPct: initial, deadlineMs: nxt.depMs, eMs, future
  };
}

/**
 * PV-Überschuss je Viertelstunde ab baseMs für n Slots: aus der Prognose, wo sie
 * reicht (knownWh: Map slotMs → Wh), dahinter der Median je Viertelstunde.
 */
export function buildSurplusSeries({ baseMs, slotMs = SLOT_MS, n, knownWh, profile, timeZone = 'Europe/Berlin' }) {
  const out = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const ms = baseMs + i * slotMs;
    const k = knownWh?.get?.(ms);
    out[i] = Number.isFinite(k) ? Math.max(0, k) : (profile?.get?.(todKey(ms, timeZone)) ?? 0);
  }
  return out;
}

export const _test = { interpOne, interpSorted, round6, rint, DAY_MS };
