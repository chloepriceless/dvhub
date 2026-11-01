// services/pricing-period-warning.js — Hinweis „Preis-Zeitraum endet bald“
// (Chrissi 28.10.2026). Endet der heute gültige Strompreis-Zeitraum
// (userEnergyPricing.periods) in höchstens LEAD_DAYS Tagen und beginnt am
// Folgetag kein anderer, rechnet DVhub danach still mit dem Grundtarif — etwa
// wenn zum Jahreswechsel neue Netzentgelte und Umlagen gelten. Der Hinweis
// erscheint als gelbe Systemwarnung oben im Leitstand.

export const LEAD_DAYS = 14;
const BERLIN = 'Europe/Berlin';
const DAY_MS = 86_400_000;

function localDate(ms, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
  } catch {
    return new Intl.DateTimeFormat('en-CA', { timeZone: BERLIN, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
  }
}

// Kalendertage zwischen zwei YYYY-MM-DD (unabhängig von Zeitumstellungen).
function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

function nextDay(date) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
}

const de = (date) => `${date.slice(8, 10)}.${date.slice(5, 7)}.${date.slice(0, 4)}`;
const ct = (v) => String(Math.round(Number(v) * 100) / 100).replace('.', ',');

function baseTariffText(pricing) {
  if (pricing?.mode === 'dynamic') return 'dynamisch';
  if (pricing?.mode === 'provider') return 'vom Stromanbieter';
  const v = Number(pricing?.fixedGrossImportCtKwh);
  return Number.isFinite(v) ? `fest ${ct(v)} ct/kWh` : 'fest';
}

const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

/**
 * @param {object} pricing  userEnergyPricing
 * @param {number} nowMs
 * @param {{timeZone?: string, leadDays?: number}} [options]
 * @returns {string|null}  Hinweistext oder null
 */
export function pricingPeriodEndWarning(pricing = {}, nowMs = Date.now(), options = {}) {
  const timeZone = options.timeZone || BERLIN;
  const leadDays = Number.isFinite(options.leadDays) ? options.leadDays : LEAD_DAYS;
  const periods = (Array.isArray(pricing?.periods) ? pricing.periods : [])
    .filter((p) => isDate(p?.startDate) && isDate(p?.endDate) && p.startDate <= p.endDate);
  const today = localDate(nowMs, timeZone);
  const active = periods.find((p) => p.startDate <= today && p.endDate >= today);
  if (!active) return null;
  if (daysBetween(today, active.endDate) > leadDays) return null;
  const following = nextDay(active.endDate);
  if (periods.some((p) => p !== active && p.startDate <= following && p.endDate >= following)) return null;

  // Neue Zeiträume haben anfangs keinen Namen (label '').
  const subject = active.label ? `Strompreis-Zeitraum „${active.label}“` : 'Dein Strompreis-Zeitraum';
  const later = periods
    .filter((p) => p.startDate > following)
    .sort((a, b) => (a.startDate < b.startDate ? -1 : 1))[0];
  const until = later ? ` bis zum Beginn ${later.label ? `von „${later.label}“` : 'des nächsten Zeitraums'} am ${de(later.startDate)}` : '';
  return `${subject} endet am ${de(active.endDate)}. Danach gilt${until} der Grundtarif (${baseTariffText(pricing)}). `
    + `Bitte unter Einstellungen → Strompreis einen neuen Zeitraum ab ${de(following)} anlegen (z. B. mit neuen Netzentgelten und Umlagen).`;
}
