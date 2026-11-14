// services/mobile-link/automation-view.js — Börsenautomatik für die Handy-App.
//
// config.schedule.smallMarketAutomation enthält auch den Standort der Anlage
// (location.latitude/longitude für die Sonnenzeiten) und die Stufen der
// Automatik. Der Standort gehört nicht aufs Handy; ändern darf die App nur die
// Werte, die sie auch zeigt. Darum hier wie bei den Integrationen eine
// Positivliste — fürs Lesen UND fürs Schreiben (Gegenprüfung 3a6035d7, P2).

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

// Feld → Prüfung. Nur diese Felder liest und schreibt die App.
const FIELDS = {
  enabled: (v) => typeof v === 'boolean',
  searchWindowStart: (v) => typeof v === 'string' && HHMM.test(v),
  searchWindowEnd: (v) => typeof v === 'string' && HHMM.test(v),
  targetSlotCount: (v) => Number.isInteger(v) && v >= 1 && v <= 96,
  // Vorzeichen wie in der Config (Entladen negativ); Betrag höchstens 100 kW.
  maxDischargeW: (v) => finite(v) && Math.abs(v) <= 100_000,
  minSocPct: (v) => finite(v) && v >= 0 && v <= 100,
};

export const MOBILE_AUTOMATION_KEYS = Object.freeze(Object.keys(FIELDS));

/** Config der Börsenautomatik ohne Standort, Stufen und alles Unbenannte. */
export function mobileAutomationConfigView(config) {
  const c = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  const out = {};
  for (const [key, valid] of Object.entries(FIELDS)) {
    if (valid(c[key])) out[key] = c[key];
  }
  return out;
}

/**
 * Schreibkörper der App prüfen. → { ok: true, patch } mit ausschließlich
 * benannten, gültigen Feldern oder { ok: false, error }. Unbenannte Felder
 * (location, stages, engine …) sind ein Fehler, kein stilles Weglassen: Die
 * App soll merken, wenn sie etwas schickt, das sie nicht ändern darf.
 */
export function parseMobileAutomationPatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'invalid body' };
  const patch = {};
  for (const [key, value] of Object.entries(body)) {
    const valid = FIELDS[key];
    if (!valid) return { ok: false, error: `field_not_allowed:${String(key).slice(0, 40)}` };
    if (!valid(value)) return { ok: false, error: `${key} invalid` };
    patch[key] = value;
  }
  if (!Object.keys(patch).length) return { ok: false, error: 'nothing to change' };
  return { ok: true, patch };
}
