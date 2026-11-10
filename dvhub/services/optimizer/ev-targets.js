/**
 * E-Auto: was DVhub EOS je Lauf als Ziel schickt — Mindest-Ladestand
 * (vorausschauend), Max-Ladestand „wenn günstig“ und den Wert der Energie
 * dazwischen (Wertstufen). Rechnung in ev-minmax.js, Fahrten aus dem Wochenplan
 * (ev-departure.js buildEvTrips), Preise und PV aus dem letzten Prognose-Push
 * (state.optimizer.evValueInputs, eos-forecast-bridge.js).
 *
 * Rückfall (Kunden auf Vanilla-EOS v0.4.0rc3): Kennt EOS das Feld für die
 * Wertstufen nicht (eos-capabilities.js EOS_EV_SOC_VALUE_FIELD), gibt es weder
 * Wertstufen noch Max-Ladestand — max bleibt 100 % wie bis 1.0.9, EOS lädt nur
 * bis zum Mindestziel. Das Mindestziel selbst rechnet DVhub immer
 * vorausschauend: es kann nur steigen, braucht kein neues EOS-Feld und hilft
 * bei zwei Fahrten kurz hintereinander auch ohne Max-Ladestand.
 */
import { resolveEvDeparture, buildEvTrips } from './ev-departure.js';
import {
  deriveEvMinMax, valueSteps, medianSurplusProfile, buildSurplusSeries, addLocalDays,
  EV_CHARGE_EFFICIENCY, EV_PLAN_LOOKAHEAD_DAYS, EV_VALUE_MARGIN_CT_DEFAULT, SLOT_MS
} from './ev-minmax.js';

/** Wertgrundlage (Preise/PV) gilt höchstens so lange nach dem Prognose-Push. */
export const EV_VALUE_INPUTS_MAX_AGE_MS = 3 * 3600_000;
/** So weit voraus braucht die Wertbestimmung Preise: E ≤ jetzt + 48 h, dazu 7 Tage. */
export const EV_VALUE_INPUTS_DAYS = 9.5;
/** So weit voraus zählt DVhub Fahrten: nächste Abfahrt (≤ 7 Tage) + 8 Tage Vorausschau + 1 Tag Rand. */
export const TRIP_LOOKAHEAD_DAYS = 16;
/** Kürzeste Vorausschau der Wertbestimmung über E hinaus. */
export const MIN_VALUE_WINDOW_MS = 24 * 3600_000;

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

/** Max-Ladestand aus der Config: Zahl 10..100 oder null (aus). */
export function configuredMaxSocPct(opt = {}) {
  const v = opt.evMaxSocPct;
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 10 && n <= 100 ? Math.round(n) : null;
}

// Letzte Wertrechnung (die DP kostet je nach Wallbox 10–60 ms; die
// Minuten-Wache fragt jede Minute).
let memo = { key: null, value: null };

/**
 * @param {object} ctx  state, getCfg
 * @param {object} cfg
 * @param {{ decision?: object, valueSupported?: boolean, nowMs?: number }} [opts]
 *   decision: ev-registration.js computeEvRegistration (Modus, Ladestand, Ankunft)
 * @returns {{
 *   minSocPct: number, maxSocPct: number, steps: Array|null, valueSupported: boolean,
 *   maxActive: boolean, propagatedPct: number|null, minWeekPct: number|null,
 *   deadlineAt: string|null, valueAt: string|null, initialSocPct: number|null,
 *   reason: string|null, source: 'plan'|'fallback'
 * }}
 */
export function resolveEvTargets(ctx, cfg, { decision = null, valueSupported = false, nowMs = Date.now() } = {}) {
  const opt = cfg?.optimizer || {};
  const departure = resolveEvDeparture(cfg, nowMs);
  const fallbackMinSoc = Number.isFinite(Number(opt.evMinSocPct)) ? Number(opt.evMinSocPct) : 70;
  const maxCfg = configuredMaxSocPct(opt);
  const base = {
    minSocPct: departure.enabled && departure.targetSocPct !== null ? departure.targetSocPct : fallbackMinSoc,
    maxSocPct: 100, steps: null, valueSupported: valueSupported === true, maxActive: false,
    propagatedPct: null, minWeekPct: null, deadlineAt: departure.enabled ? departure.departureAt : null,
    valueAt: null, valueWindowDays: null, initialSocPct: null, reason: null, source: 'fallback',
  };
  if (!departure.enabled) return { ...base, reason: 'Wochenplan aus' };
  const timeZone = cfg?.schedule?.timezone || 'Europe/Berlin';
  const capacityWh = num(opt.evCapacityWh, 50000);
  const chargeW = num(opt.evMaxChargeW, 5000);
  // Bis 8 Tage nach der NÄCHSTEN Abfahrt (propagateMin), die bis zu 7 Tage
  // entfernt sein kann, plus Wertfenster (E + 7 Tage) — Codex 52c5ee20.
  const { trips } = buildEvTrips(cfg, nowMs, { days: TRIP_LOOKAHEAD_DAYS });
  const arrivalMs = Date.parse(decision?.arrivalAt || departure.arrivalAt || '');
  const preplan = decision?.mode === 'preplan' && Number.isFinite(arrivalMs);
  const horizonH = Number(ctx?.state?.optimizer?.eosControlHorizonH);
  const runStartMs = Math.ceil(nowMs / SLOT_MS) * SLOT_MS;
  const ctrlEndMs = Number.isFinite(horizonH) && horizonH > 0 ? runStartMs + horizonH * 3600_000 : null;
  const d = deriveEvMinMax({
    nowMs, refMs: preplan ? arrivalMs : nowMs, trips, maxSocPct: valueSupported ? maxCfg : null,
    socPct: decision?.socPct ?? null, ctrlEndMs, propagate: true,
    chargeW, eta: EV_CHARGE_EFFICIENCY, capacityWh, timeZone,
  });
  if (!d) return { ...base, reason: 'keine Abfahrt in der Vorausschau' };
  const out = {
    ...base, source: 'plan',
    minSocPct: d.minSocPct, maxSocPct: d.maxSocPct, maxActive: d.maxActive,
    propagatedPct: Math.round(d.propagatedPct * 100) / 100, minWeekPct: d.minWeekPct,
    deadlineAt: new Date(d.deadlineMs).toISOString(), valueAt: new Date(d.eMs).toISOString(),
    initialSocPct: d.initialSocPct,
  };
  if (!valueSupported) return { ...out, reason: maxCfg === null ? 'Max-Ladestand aus' : 'EOS kennt keine Wertstufen — nur Mindestziel' };
  if (!d.maxActive) return { ...out, reason: 'Max-Ladestand aus' };
  if (!d.valueActive) return { ...out, steps: [], reason: 'Mindestziel erreicht den Max-Ladestand' };
  const inputs = ctx?.state?.optimizer?.evValueInputs;
  const wEnd = addLocalDays(d.eMs, EV_PLAN_LOOKAHEAD_DAYS, timeZone);
  if (!inputs || !Array.isArray(inputs.importCt) || nowMs - Number(inputs.builtAt) > EV_VALUE_INPUTS_MAX_AGE_MS) {
    return { ...out, steps: [], reason: 'noch keine Preise/PV für die Wertbestimmung' };
  }
  const slotMs = Number(inputs.slotMs) || SLOT_MS;
  // Reichen die Preise nicht 7 Tage über E (keine Historie für die Schätzung,
  // z. B. frisch eingerichtet), rechnet DVhub so weit sie reichen — mindestens
  // einen Tag. Kürzer heißt vorsichtiger: weniger künftige Fahrten, kleinerer Wert.
  const coverEnd = inputs.baseMs + inputs.importCt.length * slotMs;
  const windowEndMs = Math.min(wEnd, Math.floor(coverEnd / slotMs) * slotMs);
  if (inputs.baseMs > Math.floor(d.eMs / slotMs) * slotMs || windowEndMs - d.eMs < MIN_VALUE_WINDOW_MS) {
    return { ...out, steps: [], reason: 'Preise reichen nicht einen Tag über die Abfahrt hinaus' };
  }
  out.valueWindowDays = Math.round((windowEndMs - d.eMs) / 864_000) / 100;
  const marginCt = Number.isFinite(Number(opt.evValueMarginCt)) && Number(opt.evValueMarginCt) >= 0 ? Number(opt.evValueMarginCt) : EV_VALUE_MARGIN_CT_DEFAULT;
  const key = JSON.stringify([inputs.builtAt, inputs.baseMs, d.eMs, windowEndMs, d.minSocPct, d.maxSocPct, capacityWh, chargeW, marginCt, trips]);
  if (memo.key !== key) {
    const r = valueSteps({
      baseMs: inputs.baseMs, slotMs, importCt: inputs.importCt, feedInCt: inputs.feedInCt, surplusWh: inputs.surplusWh,
      eMs: d.eMs, sEPct: d.minSocPct, maxPct: d.maxSocPct, trips, marginCt, capacityWh, eta: EV_CHARGE_EFFICIENCY, chargeW, timeZone,
      windowEndMs: windowEndMs < wEnd ? windowEndMs : null,
    });
    memo = { key, value: { steps: r.steps, reason: r.info.reason || null } };
  }
  return { ...out, steps: memo.value.steps, reason: memo.value.steps.length ? null : (memo.value.reason || 'zusätzliche Ladung lohnt sich nicht') };
}

/**
 * Preise und PV-Überschuss je Viertelstunde für die Wertbestimmung, aus dem
 * Prognose-Push (eos-forecast-bridge.js). Reihen ab der laufenden Viertelstunde:
 *   importCt  Bezugspreis (ct/kWh) wie an EOS (Tarif je Slot), dahinter geschätzt;
 *   feedInCt  Einspeisewert wie an EOS;
 *   surplusWh max(0, PV − Last) aus der Prognose, dahinter der Median je
 *             Viertelstunde der Prognosetage (Annahme: die nächsten Tage ähneln
 *             den vorhergesagten; die Simulation nahm die letzten 7 Tage Messung).
 *
 * @param {object} a
 * @param {Array<{start:string, ctKwh:number}>} a.priceSlots  Börsenpreise (auch geschätzt), lückenlos
 * @param {(slot:object)=>number|null} a.importCtOf
 * @param {(slot:object)=>number|null} a.feedInCtOf
 * @param {Array<{start:string, powerW:number}>} a.pvSlots   15 min
 * @param {Array<{start:string, powerW:number}>} a.loadSlots  1 h
 * @returns {object|null}
 */
export function buildEvValueInputs({ priceSlots, importCtOf, feedInCtOf, pvSlots = [], loadSlots = [], nowMs = Date.now(), timeZone = 'Europe/Berlin' }) {
  const baseMs = Math.floor(nowMs / SLOT_MS) * SLOT_MS;
  const byMs = new Map();
  for (const s of Array.isArray(priceSlots) ? priceSlots : []) {
    const ms = Date.parse(s?.start);
    if (!Number.isFinite(ms)) continue;
    const step = Date.parse(s?.end) - ms;
    const n = Number.isFinite(step) && step > SLOT_MS ? Math.round(step / SLOT_MS) : 1;
    for (let k = 0; k < n; k += 1) byMs.set(ms + k * SLOT_MS, s);
  }
  const importCt = [];
  const feedInCt = [];
  for (let ms = baseMs; ; ms += SLOT_MS) {
    const s = byMs.get(ms);
    if (!s) break;
    const imp = Number(importCtOf(s));
    const fit = Number(feedInCtOf(s));
    if (!Number.isFinite(imp) || !Number.isFinite(fit)) break;
    importCt.push(imp);
    feedInCt.push(fit);
  }
  if (!importCt.length) return null;
  const loadAt = new Map();
  for (const s of Array.isArray(loadSlots) ? loadSlots : []) {
    const ms = Date.parse(s?.start);
    if (Number.isFinite(ms) && Number.isFinite(Number(s?.powerW))) for (let k = 0; k < 4; k += 1) loadAt.set(ms + k * SLOT_MS, Number(s.powerW));
  }
  const known = new Map();
  const entries = [];
  for (const s of Array.isArray(pvSlots) ? pvSlots : []) {
    const ms = Date.parse(s?.start);
    const pv = Number(s?.powerW);
    if (!Number.isFinite(ms) || !Number.isFinite(pv) || !loadAt.has(ms) || ms < baseMs) continue;
    const wh = Math.max(0, pv - loadAt.get(ms)) * (SLOT_MS / 3600_000);
    known.set(ms, wh);
    entries.push({ ms, wh });
  }
  const profile = medianSurplusProfile(entries, timeZone);
  const surplusWh = buildSurplusSeries({ baseMs, n: importCt.length, knownWh: known, profile, timeZone });
  return { baseMs, slotMs: SLOT_MS, importCt, feedInCt, surplusWh, builtAt: nowMs, untilMs: baseMs + importCt.length * SLOT_MS, knownPvUntilMs: entries.length ? Math.max(...entries.map((e) => e.ms)) + SLOT_MS : null };
}

/**
 * Max-Ladestand, bei dem DVhub das Laden an der Wallbox beendet — nur wenn er
 * gilt (EOS kennt Wertstufen, Max-Ladestand an). Sonst null (Verhalten wie bisher).
 */
export function evMaxStopSocPct(state) {
  const t = state?.optimizer?.evTargets;
  return t && t.maxActive === true && Number.isFinite(Number(t.maxSocPct)) && Number(t.maxSocPct) < 100 + 1e-9
    ? Number(t.maxSocPct) : null;
}

export const _test = { resetMemo: () => { memo = { key: null, value: null }; } };
