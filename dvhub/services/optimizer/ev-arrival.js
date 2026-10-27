/**
 * E-Auto: erwarteter Ladestand bei Ankunft (Anstecken).
 *
 * Damit EOS das Laden schon vor dem Anstecken einplanen kann, braucht es einen
 * Start-Ladestand fuer den Moment der Ankunft. Woher er kommt, in dieser
 * Reihenfolge:
 *
 *   1. angesteckt — der echte Ladestand (ev-soc.js resolveEvSocPct) gewinnt
 *      immer;
 *   2. live vom Auto — eine Fahrzeug-Schnittstelle (TeslaMate, evcc-
 *      Fahrzeugtreiber, MQTT) hat NACH der letzten Abfahrt einen Wert
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
import fs from 'node:fs';
import { resolveEvDeparture } from './ev-departure.js';
import { resolveEvSocPct, EV_SOC_SOURCES } from './ev-soc.js';

export const EV_LIVE_MAX_AGE_MS = 12 * 3600_000;
export const EV_LAST_KNOWN_MAX_AGE_MS = 7 * 24 * 3600_000;
// Quellen, die den Ladestand auch liefern, wenn das Auto nicht steckt.
const CAR_API_SOURCES = new Set(['teslamate', 'evccvehicle', 'mqtt']);
const CHECKPOINT_MS = 3600_000;

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
  const carApi = CAR_API_SOURCES.has(reading.source);
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
 * Juengster bekannter Ladestand mit Zeitpunkt: { pct, source, atMs } oder null.
 * optimizer.evSocSource wie in ev-soc.js: 'auto' nimmt den juengsten Wert
 * aller Quellen, sonst nur die gewaehlte. Dazu der gemerkte Wert
 * (ctx.evSocMemory), damit ein evcc-Wert das Abstecken uebersteht.
 */
export function readEvSocReading(ctx, nowMs = Date.now()) {
  const opt = ctx?.getCfg?.()?.optimizer || {};
  const wanted = EV_SOC_SOURCES.includes(opt.evSocSource) ? opt.evSocSource : 'auto';
  const use = (source) => wanted === 'auto' || wanted === source;
  const out = [];

  if (use('teslamate') && ctx?.teslamateService?.getState) {
    const pct = validPct(ctx.teslamateService.getState()?.batteryLevel);
    if (pct !== null) {
      const stamps = ctx.teslamateService.getFieldUpdatedAt?.() || {};
      const atMs = toMs(stamps.batteryLevel) ?? toMs(ctx.teslamateService.lastUpdateAt);
      out.push({ pct, source: 'teslamate', atMs });
    }
  }
  // Wallbox / evcc-Ladepunkt: nur angesteckt — dann ist der Wert von jetzt.
  const wallbox = ctx?.mainWallbox?.state?.();
  if (wallbox && wallbox.type !== 'evcc') {
    if (use('evcc') || use(wallbox.type)) {
      const pct = wallbox.connected === true ? validPct(wallbox.vehicleSocPct) : null;
      if (pct !== null) out.push({ pct, source: wallbox.type, atMs: nowMs });
    }
  } else if (use('evcc')) {
    const lpId = Number(opt.evEvccLoadpoint) || 1;
    const lp = (ctx?.evccIntegration?.getLoadpoints?.() || []).find((l) => l.id === lpId);
    const pct = lp?.connected === true ? validPct(lp.vehicleSocPct) : null;
    // Zeitpunkt der letzten erfolgreichen Abfrage: faellt evcc aus, bleibt die
    // Liste stehen — „jetzt“ machte einen alten Wert immer wieder frisch.
    const polled = toMs(ctx?.evccIntegration?.getStatus?.()?.lastPolledAt);
    if (pct !== null) out.push({ pct, source: 'evcc', atMs: polled && polled > 0 ? polled : nowMs });
  }
  if (use('evccvehicle')) {
    const v = ctx?.vehicleEvcc?.getState?.();
    const pct = validPct(v?.socPct);
    if (pct !== null) out.push({ pct, source: 'evccvehicle', atMs: toMs(v.at) });
  }
  if (use('mqtt')) {
    const m = ctx?.vehicleMqtt?.getState?.();
    const pct = validPct(m?.socPct);
    if (pct !== null) out.push({ pct, source: 'mqtt', atMs: toMs(m.socAt) });
  }
  const mem = ctx?.evSocMemory?.get?.();
  // Gewaehlt „evcc“ heisst „die Wallbox“ — auch eine direkt angebundene
  // (Quelle dann openevse, goe …).
  const memMatches = (src) => wanted === 'auto' || src === wanted || (wanted === 'evcc' && !CAR_API_SOURCES.has(src));
  if (mem && validPct(mem.pct) !== null && memMatches(mem.source)) out.push(mem);

  if (!out.length) return null;
  // Juengster zuerst; ohne Zeitpunkt ganz hinten.
  out.sort((a, b) => (b.atMs ?? -Infinity) - (a.atMs ?? -Infinity));
  const best = out[0];
  return { pct: best.pct, source: best.source, atMs: best.atMs ?? null };
}

/**
 * Merkt sich den juengsten Ladestand (die Minuten-Wache ruft observe()), damit
 * der letzte Wallbox-Wert nach dem Abstecken als Schaetzbasis bleibt. Mit
 * filePath ueberlebt er einen Neustart; geschrieben wird nur bei geaendertem
 * Wert oder Quelle (keine Schreiblast im Minutentakt).
 */
export function createEvSocMemory({ filePath = null } = {}) {
  let last = null;
  let writtenAtMs = null;
  if (filePath) {
    try {
      const j = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (validPct(j?.pct) !== null && typeof j.source === 'string') last = { pct: Number(j.pct), source: j.source, atMs: toMs(j.atMs) };
      writtenAtMs = last?.atMs ?? null;
    } catch { /* noch keine Datei */ }
  }
  return {
    observe(reading) {
      if (!reading || validPct(reading.pct) === null) return;
      const atMs = toMs(reading.atMs);
      if (last && last.atMs !== null && (atMs === null || atMs < last.atMs)) return;
      const changed = !last || last.pct !== reading.pct || last.source !== reading.source;
      last = { pct: Number(reading.pct), source: String(reading.source || ''), atMs };
      // Gleicher Wert: den Zeitpunkt hoechstens stuendlich sichern — sonst
      // kaeme nach einem Neustart ein zu alter Zeitpunkt zurueck.
      const checkpoint = atMs !== null && (writtenAtMs === null || atMs - writtenAtMs >= CHECKPOINT_MS);
      if ((changed || checkpoint) && filePath) {
        try { fs.writeFileSync(filePath, JSON.stringify(last)); writtenAtMs = atMs; } catch { /* Anzeige-Hilfe, kein Fehlerfall */ }
      }
    },
    get() { return last ? { ...last } : null; }
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
    reading: readEvSocReading(ctx, nowMs),
    tripStartMs,
    commuteKm: dep.commuteKm,
    consumptionKwhPer100km: Number(opt.evConsumptionKwhPer100km) || 18,
    capacityWh: Number(opt.evCapacityWh) || 50000,
    nowMs
  });
  return { ...r, arrivalAt: dep.arrivalAt || null, commuteKm: dep.commuteKm || 0 };
}
