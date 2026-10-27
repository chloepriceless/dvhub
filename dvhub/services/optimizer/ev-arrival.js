/**
 * E-Auto: erwarteter Ladestand bei Ankunft (Anstecken).
 *
 * Damit EOS das Laden schon vor dem Anstecken einplanen kann, braucht es einen
 * Start-Ladestand fuer den Moment der Ankunft. Woher er kommt, in dieser
 * Reihenfolge:
 *
 *   1. angesteckt — der echte Ladestand (ev-soc.js resolveEvSocPct) gewinnt
 *      immer;
 *   2. live vom Fahrzeug — eine Fahrzeug-Quelle (ev-soc.js
 *      VEHICLE_SOC_SOURCES: TeslaMate, evcc-Fahrzeugtreiber, MQTT, HTTP-
 *      Endpunkt, Home Assistant) hat NACH der letzten Abfahrt einen Wert
 *      geliefert, hoechstens EV_LIVE_MAX_AGE_MS alt: davon geht noch einmal
 *      der Heimweg ab;
 *   3. geschaetzt — sonst der letzte bekannte Wert (auch der beim Abstecken
 *      gemerkte Wallbox-Wert, createEvSocMemory) minus Heimweg. Stammt er von
 *      VOR der Abfahrt, faehrt das Auto Hin- UND Rueckweg (2 × Heimweg); von
 *      danach nur noch den Rueckweg.
 *
 * Wie weit das Auto unterwegs schon gefahren ist, weiss DVhub nicht (keine
 * Position) — abgezogen wird deshalb immer der ganze Heimweg. Das schaetzt
 * eher zu niedrig: EOS plant dann eher etwas mehr Ladung ein, nie zu wenig.
 */
import { resolveEvDeparture } from './ev-departure.js';
// Alle Ladestand-Quellen laufen ueber EINEN Aufloeser (ev-soc.js) — markenneutral.
import { resolveEvSocPct, resolveEvSocReading, createEvSocMemory, VEHICLE_SOC_SOURCES } from './ev-soc.js';

// Fuer bestehende Aufrufer: Gedaechtnis und Lesung leben in ev-soc.js.
export { createEvSocMemory };
export const readEvSocReading = resolveEvSocReading;

export const EV_LIVE_MAX_AGE_MS = 12 * 3600_000;
export const EV_LAST_KNOWN_MAX_AGE_MS = 7 * 24 * 3600_000;

const num = (v) => (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const validPct = (v) => { const n = num(v); return n !== null && n >= 0 && n <= 100 ? n : null; };
const toMs = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const ms = v instanceof Date ? v.getTime() : (typeof v === 'number' ? v : Date.parse(v));
  return Number.isFinite(ms) ? ms : null;
};

/** Heimweg in Prozent Ladestand. 0, wenn nicht berechenbar. */
export function commutePct({ km, consumptionKwhPer100km, capacityWh }) {
  const k = Number(km); const c = Number(consumptionKwhPer100km); const cap = Number(capacityWh);
  if (!(k > 0) || !(c > 0) || !(cap > 0)) return 0;
  return (k * c / 100) * 1000 / cap * 100;
}

/**
 * Reine Rechnung: erwarteter Ladestand bei Ankunft.
 * @returns {{ pct: number|null, source: 'plugged'|'live'|'estimate'|null,
 *   basePct: number|null, baseSource: string|null, baseAt: string|null,
 *   legs: number, deductKm: number }}
 */
export function estimateArrivalSoc({
  plugged, pluggedSoc = null, reading = null, tripStartMs = null,
  commuteKm = 0, consumptionKwhPer100km, capacityWh, nowMs = Date.now()
}) {
  const none = { pct: null, source: null, basePct: null, baseSource: null, baseAt: null, legs: 0, deductKm: 0 };
  if (plugged === true && validPct(pluggedSoc?.pct) !== null) {
    const pct = validPct(pluggedSoc.pct);
    return { ...none, pct: Math.round(pct), source: 'plugged', basePct: pct, baseSource: pluggedSoc.source || null, baseAt: new Date(nowMs).toISOString() };
  }
  const base = validPct(reading?.pct);
  if (base === null) return none;
  const atMs = toMs(reading.atMs);
  if (atMs !== null && nowMs - atMs > EV_LAST_KNOWN_MAX_AGE_MS) return none;
  const carApi = VEHICLE_SOC_SOURCES.has(reading.source);
  // Nach der letzten Abfahrt gemessen → das Auto ist schon unterwegs, es fehlt
  // nur noch der Rueckweg. Ohne bekannte Abfahrt zaehlt ein Wert der
  // Fahrzeug-Schnittstelle als unterwegs gemessen.
  const afterTripStart = atMs !== null && (tripStartMs === null ? carApi : atMs >= tripStartMs);
  const legs = afterTripStart ? 1 : 2;
  const km = Math.max(0, Number(commuteKm) || 0);
  const pct = Math.max(0, Math.min(100, Math.round(base - legs * commutePct({ km, consumptionKwhPer100km, capacityWh }))));
  const live = carApi && afterTripStart && nowMs - atMs <= EV_LIVE_MAX_AGE_MS;
  return {
    pct, source: live ? 'live' : 'estimate',
    basePct: base, baseSource: reading.source || null, baseAt: atMs !== null ? new Date(atMs).toISOString() : null,
    legs, deductKm: legs * km
  };
}

/**
 * Erwarteter Ladestand fuer das naechste Fenster aus Config und Fahrzeug.
 * `plugged` vom Aufrufer (entprellt bzw. resolveEvPlugged).
 */
export function resolveEvArrival(ctx, cfg, { plugged = null, nowMs = Date.now(), departure = null } = {}) {
  const opt = cfg?.optimizer || {};
  const dep = departure || resolveEvDeparture(cfg, nowMs);
  const tripStartMs = toMs(dep.tripStartAt);
  const r = estimateArrivalSoc({
    plugged,
    pluggedSoc: plugged === true ? resolveEvSocPct(ctx) : null,
    reading: resolveEvSocReading(ctx, nowMs),
    tripStartMs,
    commuteKm: dep.commuteKm,
    consumptionKwhPer100km: Number(opt.evConsumptionKwhPer100km) || 18,
    capacityWh: Number(opt.evCapacityWh) || 50000,
    nowMs
  });
  return { ...r, arrivalAt: dep.arrivalAt || null, commuteKm: dep.commuteKm || 0 };
}
