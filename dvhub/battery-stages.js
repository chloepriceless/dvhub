// battery-stages.js — datierte Akku-Kapazitätsstufen.
//
// Problem (Christin 2026-08-07): Die Zyklenrechnung teilt Entladeenergie durch
// die Nennkapazität. Bisher las sie IMMER den heutigen Wert aus
// `optimizer.batteryCapacityWh` — auch für Zeilen aus einer Zeit, in der der
// Akku kleiner war. Nach einem Ausbau 43 → 60 → 77 kWh sind damit sämtliche
// Rückblicke falsch: dieselbe historische Entladung erscheint nach jedem Ausbau
// als weniger Zyklen, obwohl sich an der Vergangenheit nichts geändert hat.
//
// Lösung: eine Liste datierter Stufen. Jede Stufe gilt ab `startDate` 00:00
// Berliner Zeit bis zum Beginn der nächsten. Ein Rückbau (Blöcke raus) ist
// derselbe Vorgang mit kleinerem `capacityWh` — die Liste kennt keine Richtung.
//
// Zwei bewusste Festlegungen:
//   1. VOR der ersten Stufe gilt deren Kapazität rückwärts weiter. Wer nicht
//      mehr weiß, wann die erste Ausbaustufe in Betrieb ging, muss kein Datum
//      erfinden — die älteste Stufe deckt alles davor ab. Das ist immer noch
//      richtiger als der heutige Wert und braucht kein Null-Datum als Sonderfall.
//   2. Leere Liste ⇒ Fallback auf den manuell gepflegten Einzelwert. Bestehende
//      Installationen verhalten sich damit exakt wie vorher; die Zeitleiste ist
//      additiv, nicht erzwungen.
//
// Der Ort der Wahrheit ist die Config (wie `userEnergyPricing.periods`), NICHT
// die Telemetrie-DB: die ist optional (`telemetry.enabled`), und die
// Zyklenrechner sind synchron und laufen pro Zeile.

const BERLIN_TIME_ZONE = 'Europe/Berlin';

// Bewusst strenger als das reine Formatmuster: geprüft wird, ob der Tag als
// Kalenderdatum existiert. Ein Tippfehler wie 2026-13-01 besteht den
// Regex-Test, sortiert sich als jüngste Stufe ganz nach hinten und würde damit
// die HEUTE gültige Kapazität kapern. Beim Smoke-Test genau so passiert.
function isIsoDateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (month < 1 || month > 12 || day < 1) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Lokales Kalenderdatum (YYYY-MM-DD) eines Zeitstempels in der Zielzone.
 * Bewusst zonenbewusst: ein Slot um 23:30 Berliner Zeit gehört zum Berliner
 * Tag, nicht zum UTC-Tag. Vgl. formatLocalDate() in config-model.js.
 */
export function localDateOf(value, timeZone = BERLIN_TIME_ZONE) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  if (!year || !month || !day) return null;
  return `${year}-${month}-${day}`;
}

/**
 * Prüft + normalisiert die Stufenliste.
 * Verworfen wird eine Stufe bei fehlendem/ungültigem Datum, nicht-positiver
 * Kapazität oder doppeltem Startdatum. Ergebnis ist nach Datum sortiert.
 * Verwirft NIE die ganze Liste wegen eines schlechten Eintrags — sonst würde
 * ein Tippfehler in einer Stufe die Kapazität aller anderen verlieren.
 *
 * @param {*} value                Rohwert aus der Config
 * @param {string[]} [warnings]    Sammelkanal (wie die übrigen Sanitizer)
 * @returns {Array<{id:string,label:string,startDate:string,capacityWh:number}>}
 */
export function sanitizeBatteryStages(value, warnings = []) {
  if (!Array.isArray(value)) return [];

  const normalized = value
    .map((entry, index) => {
      if (!isPlainObject(entry)) {
        warnings.push(`optimizer.batteryStages.${index}: invalid entry ignored`);
        return null;
      }
      const next = {
        id: entry.id == null || entry.id === '' ? `stage-${index + 1}` : String(entry.id),
        label: entry.label == null ? '' : String(entry.label),
        startDate: entry.startDate == null ? '' : String(entry.startDate),
        capacityWh: Number(entry.capacityWh)
      };
      if (!isIsoDateOnly(next.startDate)) {
        warnings.push(`optimizer.batteryStages.${next.id}: startDate must use YYYY-MM-DD`);
        return null;
      }
      if (!Number.isFinite(next.capacityWh) || next.capacityWh <= 0) {
        warnings.push(`optimizer.batteryStages.${next.id}: capacityWh must be a positive number`);
        return null;
      }
      return next;
    })
    .filter(Boolean)
    .sort((left, right) => left.startDate.localeCompare(right.startDate));

  // Zwei Stufen am selben Tag wären mehrdeutig — die spätere gewinnt nicht
  // "zufällig", sie wird verworfen und der Betreiber erfährt davon.
  const accepted = [];
  for (const stage of normalized) {
    const previous = accepted[accepted.length - 1];
    if (previous && previous.startDate === stage.startDate) {
      warnings.push(`optimizer.batteryStages.${stage.id}: duplicate startDate ${stage.startDate} (kept ${previous.id})`);
      continue;
    }
    accepted.push(stage);
  }
  return accepted;
}

/**
 * Kapazität (Wh), die an einem lokalen Kalendertag galt.
 *
 * @param {Array} stages       sanitisierte Stufen (sortiert)
 * @param {string} localDate   YYYY-MM-DD
 * @param {number|null} fallbackWh  manueller Einzelwert, wenn keine Stufen da sind
 * @returns {number|null}
 */
export function resolveBatteryCapacityWhForDate(stages, localDate, fallbackWh = null) {
  const list = Array.isArray(stages) ? stages : [];
  const fallback = Number.isFinite(Number(fallbackWh)) && Number(fallbackWh) > 0
    ? Number(fallbackWh)
    : null;
  if (!list.length) return fallback;
  if (!isIsoDateOnly(localDate)) return fallback;

  // Rückwärts-Extrapolation: alles vor der ältesten Stufe erbt deren Kapazität.
  if (localDate < list[0].startDate) return list[0].capacityWh;

  let match = list[0];
  for (const stage of list) {
    if (stage.startDate <= localDate) match = stage;
    else break;
  }
  return match.capacityWh;
}

/**
 * Wie oben, aber für einen Zeitstempel — rechnet ihn zonenbewusst auf den
 * lokalen Kalendertag um. Für die Zyklen-Karte, die in 15-Min-Buckets arbeitet.
 */
export function resolveBatteryCapacityWhForTimestamp(stages, ts, fallbackWh = null, timeZone = BERLIN_TIME_ZONE) {
  return resolveBatteryCapacityWhForDate(stages, localDateOf(ts, timeZone), fallbackWh);
}

/**
 * Heute gültige Kapazität — der Wert, den EOS, Optimizer und Watchdog brauchen.
 * `now` ist injizierbar, damit Tests keinen Kalender stellen müssen.
 */
export function resolveCurrentBatteryCapacityWh(stages, fallbackWh = null, now = new Date(), timeZone = BERLIN_TIME_ZONE) {
  return resolveBatteryCapacityWhForTimestamp(stages, now, fallbackWh, timeZone);
}
