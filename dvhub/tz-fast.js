// tz-fast.js — schnelle Umrechnung Zeitstempel → lokale Zeit einer Zeitzone.
//
// Warum: Intl.DateTimeFormat#formatToParts kostet je Aufruf Mikrosekunden bis
// Millisekunden, ein neu gebauter Formatter ein Vielfaches davon. DVhub ruft
// solche Umrechnungen pro 15-min-Slot und pro Messwert auf — auf dem eHive
// (Cortex-A55, gedrosselt 600 MHz) waren das im Leerlauf ~80 % eines Kerns,
// eine Monatsansicht der Historie dauerte über eine Minute.
//
// Der Abstand einer Zeitzone zu UTC wechselt nur bei Zeitumstellungen, und die
// liegen (für Europe/Berlin und praktisch alle Zonen) auf vollen UTC-Stunden.
// Darum wird der Abstand je UTC-Stunde EINMAL über Intl bestimmt und gemerkt;
// Datum, Uhrzeit und Minuten des Tages ergeben sich dann arithmetisch.

const HOUR_MS = 3_600_000;
const MAX_CACHED_HOURS = 200_000; // ~23 Jahre je Zone, danach Cache leeren

const dtfByZone = new Map();
const offsetsByZone = new Map(); // zone → Map(hourBucket → offsetMs)

function formatterFor(timeZone) {
  let dtf = dtfByZone.get(timeZone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    dtfByZone.set(timeZone, dtf);
  }
  return dtf;
}

function computeOffsetMs(tsMs, timeZone) {
  const parts = formatterFor(timeZone).formatToParts(new Date(tsMs));
  const v = {};
  for (const p of parts) if (p.type !== 'literal') v[p.type] = Number(p.value);
  const asUtc = Date.UTC(v.year, v.month - 1, v.day, v.hour, v.minute, v.second);
  return asUtc - (tsMs - (tsMs % 1000 + 1000) % 1000);
}

/**
 * Abstand der Zone zu UTC (ms) für einen Zeitpunkt; lokal = UTC + Abstand.
 * @param {number} tsMs
 * @param {string} [timeZone]
 */
export function zoneOffsetMs(tsMs, timeZone = 'Europe/Berlin') {
  let cache = offsetsByZone.get(timeZone);
  if (!cache) {
    cache = new Map();
    offsetsByZone.set(timeZone, cache);
  }
  const bucket = Math.floor(tsMs / HOUR_MS);
  let off = cache.get(bucket);
  if (off === undefined) {
    if (cache.size >= MAX_CACHED_HOURS) cache.clear();
    off = computeOffsetMs(bucket * HOUR_MS, timeZone);
    cache.set(bucket, off);
  }
  return off;
}

function toMs(value) {
  if (typeof value === 'number') return value;
  if (value instanceof Date) return value.getTime();
  return new Date(value).getTime();
}

/** Lokale Uhrzeit als Date, dessen UTC-Felder die lokalen Werte tragen. */
function shifted(tsMs, timeZone) {
  return new Date(tsMs + zoneOffsetMs(tsMs, timeZone));
}

/**
 * Lokales Datum 'YYYY-MM-DD'.
 * @param {number|Date|string} value
 * @returns {string|null}
 */
export function localDate(value, timeZone = 'Europe/Berlin') {
  const ms = toMs(value);
  if (!Number.isFinite(ms)) return null;
  return shifted(ms, timeZone).toISOString().slice(0, 10);
}

/**
 * Lokale Bestandteile { year, month, day, hour, minute } (month 1–12).
 * @param {number|Date|string} value
 */
export function localParts(value, timeZone = 'Europe/Berlin') {
  const ms = toMs(value);
  if (!Number.isFinite(ms)) return { year: NaN, month: NaN, day: NaN, hour: NaN, minute: NaN };
  const d = shifted(ms, timeZone);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  };
}

/**
 * Minuten seit lokaler Mitternacht (0–1439).
 * @param {number|Date|string} value
 * @returns {number|null}
 */
export function localMinutesOfDay(value, timeZone = 'Europe/Berlin') {
  const ms = toMs(value);
  if (!Number.isFinite(ms)) return null;
  const d = shifted(ms, timeZone);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}
