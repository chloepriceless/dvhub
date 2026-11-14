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
  // Wie im Config-Modell: leer oder 0 = automatisch, sonst höchstens 24.
  targetSlotCount: (v) => v === null || (Number.isInteger(v) && v >= 0 && v <= 24),
  // Vorzeichen wie in der Config (Entladen negativ); Betrag höchstens 100 kW.
  maxDischargeW: (v) => finite(v) && Math.abs(v) <= 100_000,
  minSocPct: (v) => finite(v) && v >= 0 && v <= 100,
};

export const MOBILE_AUTOMATION_KEYS = Object.freeze(Object.keys(FIELDS));

// Entladeleistung aus „Meine Anlage → Akku-Grenzen“ (resolvePlantBattery):
// Ist sie gesetzt, plant die Automatik mit IHR und nicht mit dem eigenen Feld
// (withPlantBattery) — die Weboberfläche sperrt das Feld dann.
const plantDischargeW = (plant) => (finite(plant?.maxDischargeW) && plant.maxDischargeW > 0 ? plant.maxDischargeW : null);

/**
 * Config der Börsenautomatik ohne Standort, Stufen und alles Unbenannte.
 * `plant`: Ergebnis von resolvePlantBattery. Gibt „Meine Anlage“ die
 * Entladeleistung vor, steht hier der WIRKSAME Wert und
 * `maxDischargeFromPlant: true` (Gegenprüfung 56e1e0a8, P2).
 */
export function mobileAutomationConfigView(config, plant = null) {
  const c = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  const out = {};
  for (const [key, valid] of Object.entries(FIELDS)) {
    if (key in c && valid(c[key])) out[key] = c[key];
  }
  const fromPlant = plantDischargeW(plant);
  if (fromPlant != null) out.maxDischargeW = -fromPlant;
  out.maxDischargeFromPlant = fromPlant != null;
  return out;
}

/**
 * Schreibkörper der App prüfen. → { ok: true, patch } mit ausschließlich
 * benannten, gültigen Feldern oder { ok: false, error }. Unbenannte Felder
 * (location, stages, engine …) sind ein Fehler, kein stilles Weglassen: Die
 * App soll merken, wenn sie etwas schickt, das sie nicht ändern darf.
 * Gibt „Meine Anlage“ die Entladeleistung vor, wäre ein eigener Wert
 * wirkungslos: dann { ok: false, status: 409, error: 'managed_by_plant' }.
 */
export function parseMobileAutomationPatch(body, plant = null) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'invalid body' };
  const patch = {};
  for (const [key, value] of Object.entries(body)) {
    const valid = FIELDS[key];
    if (!valid) return { ok: false, error: `field_not_allowed:${String(key).slice(0, 40)}` };
    if (key === 'maxDischargeW' && plantDischargeW(plant) != null) return { ok: false, status: 409, error: 'managed_by_plant' };
    if (!valid(value)) return { ok: false, error: `${key} invalid` };
    patch[key] = value;
  }
  if (!Object.keys(patch).length) return { ok: false, error: 'nothing to change' };
  return { ok: true, patch };
}
