// services/tariff-provider/price-store.js — Bezugspreise vom Stromanbieter je Slot.
//
// Christin 2026-10-21: Tibber- und LichtBlick-Kunden zahlen je Viertelstunde den
// Preis, den ihr Anbieter vorgibt. Der Dienst (index.js) holt ihn mit den
// Zugangsdaten des Kunden, legt ihn in der Datenbank ab und hier in den
// Speicher. Der Bezugspreis-Rechner (config-model.js) liest ihn synchron je Slot
// — für Live-Kosten, EOS, Preisvergleich und Historie gleichermaßen.
//
// Ein Prozess (monolith) hält alles: Abruf, Historie und Steuerung sehen
// denselben Stand. Ohne Abruf bleibt der Speicher leer und der Rechner schätzt.

const slots = new Map(); // Slotbeginn (ms) → { ctKwh, durationMs, provider }
const QUARTER_MS = 15 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
let estimate = null; // { slope, intercept, n, provider } — Anbieterpreis ≈ slope × Börsenpreis + intercept

function toMs(ts) {
  const ms = typeof ts === 'number' ? ts : new Date(ts).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** Slots eines Anbieters übernehmen (gleicher Beginn wird überschrieben). */
export function putProviderSlots(provider, list = []) {
  let added = 0;
  for (const slot of list) {
    const start = toMs(slot?.ts);
    const ct = Number(slot?.ctKwh);
    const durationMs = Number(slot?.durationMs) > 0 ? Number(slot.durationMs) : QUARTER_MS;
    if (start == null || !Number.isFinite(ct)) continue;
    if (!slots.has(start)) added += 1;
    slots.set(start, { ctKwh: ct, durationMs, provider: String(provider || '') });
  }
  return added;
}

/** Anbieterpreis des Slots, in dem ts liegt (15-min- oder Stunden-Slots), sonst null. */
export function providerSlotAt(ts) {
  const ms = toMs(ts);
  if (ms == null) return null;
  const quarter = slots.get(ms - (ms % QUARTER_MS));
  if (quarter && ms < ms - (ms % QUARTER_MS) + quarter.durationMs) return quarter;
  const hourStart = ms - (ms % HOUR_MS);
  const hour = slots.get(hourStart);
  if (hour && ms < hourStart + hour.durationMs) return hour;
  return null;
}

/** Alle Slots im Bereich [startMs, endMs), sortiert. */
export function providerSlotsBetween(startMs, endMs) {
  const out = [];
  for (const [ts, slot] of slots) {
    if (ts >= startMs && ts < endMs) out.push({ ts, ...slot });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

export function providerSlotCount() {
  return slots.size;
}

export function setProviderEstimate(model) {
  estimate = model && Number.isFinite(model.slope) && Number.isFinite(model.intercept) ? { ...model } : null;
}

export function getProviderEstimate() {
  return estimate;
}

// Laden aus der Datenbank nach dem Start: Die Historie wartet darauf (höchstens
// LOAD_WAIT_MS), damit sie nicht mit Schätzwerten rechnet und diese ablegt.
const LOAD_WAIT_MS = 15_000;
let loading = null;

export function markProviderPricesLoading(promise) {
  const tracked = Promise.resolve(promise).catch(() => {}).finally(() => {
    if (loading === tracked) loading = null;
  });
  loading = tracked;
}

export async function whenProviderPricesLoaded(timeoutMs = LOAD_WAIT_MS) {
  if (!loading) return;
  let timer;
  await Promise.race([loading, new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); timer.unref?.(); })]);
  clearTimeout(timer);
}

/** Slots ab fromMs verwerfen (Anbieter- oder Vertragswechsel); Vergangenes bleibt — es wurde so bezahlt. */
export function dropProviderSlotsFrom(fromMs) {
  let n = 0;
  for (const ts of [...slots.keys()]) {
    if (ts >= fromMs) { slots.delete(ts); n += 1; }
  }
  estimate = null;
  return n;
}

/** Nur für Tests und beim Wechsel ohne Altbestand. */
export function clearProviderPrices() {
  slots.clear();
  estimate = null;
}

// Schätzung für Slots ohne Anbieterpreis (z. B. morgen zwischen Day-Ahead um
// ~13 Uhr und LichtBlicks IDA1-Preisen um ~15 Uhr): lineare Ausgleichsgerade
// Anbieterpreis über Börsenpreis aus Paaren der letzten Tage. Die Steigung
// trägt die MwSt (≈ 1,19), der Achsenabschnitt Aufschlag, Netzentgelt und
// Umlagen. Unplausible Steigungen fallen auf 1 mit Median-Abstand zurück.
export const ESTIMATE_MIN_PAIRS = 16;

export function fitProviderEstimate(pairs = []) {
  const clean = pairs.filter((p) => Number.isFinite(p?.market) && Number.isFinite(p?.provider));
  const n = clean.length;
  if (n < ESTIMATE_MIN_PAIRS) return null;
  const mx = clean.reduce((s, p) => s + p.market, 0) / n;
  const my = clean.reduce((s, p) => s + p.provider, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (const p of clean) {
    sxx += (p.market - mx) ** 2;
    sxy += (p.market - mx) * (p.provider - my);
  }
  let slope = sxx > 1e-6 ? sxy / sxx : NaN;
  let intercept;
  if (!Number.isFinite(slope) || slope < 0.8 || slope > 1.6) {
    slope = 1;
    const diffs = clean.map((p) => p.provider - p.market).sort((a, b) => a - b);
    intercept = n % 2 ? diffs[(n - 1) / 2] : (diffs[n / 2 - 1] + diffs[n / 2]) / 2;
  } else {
    intercept = my - slope * mx;
  }
  return {
    slope: Math.round(slope * 10000) / 10000,
    intercept: Math.round(intercept * 10000) / 10000,
    n
  };
}
